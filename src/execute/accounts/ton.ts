/**
 * The TON engine account (D10, D11, D35): the connected TON Connect wallet behind the gate. The engine's TON writes —
 * `sendTransaction({to, value, body?})`, TON to a deposit address with an optional comment;
 * `transfer({token, recipient, amount, memo?})`, a jetton deposit; and `sendTransaction({to, value, bodyBoc})`, a
 * venue's contract call (gated.ts turned the engine's cell body into its exact BoC) — reach this account only after
 * gated.ts consumed the armed write. Each becomes ONE TON Connect message built here, which tonGate.ts's
 * checkTonRequest reads back from its own BoCs against that very write before the wallet sees it; the wallet then
 * signs and broadcasts it.
 *
 * A jetton transfer goes to the payer's own jetton wallet: asked from TonAPI (runtime config `tonApiUrl`), equal to
 * the address computed here from the jetton's pinned wallet code, and proven by its get_wallet_data (owner = the
 * payer, master = the reviewed jetton, balance enough) — the API's answer is checked, never trusted. A jetton without
 * pinned code (only USDT has it) is refused: TonAPI alone could name another jetton's wallet of the payer's.
 *
 * A contract call is signed only for the reviewed route's own (`call`, tonPlan.ts tonCallOf; without it a cell body is
 * refused): `getJettonWalletAddress` names the engine that same proven wallet for the call's jetton, and the message —
 * that wallet, bounceable, the TON the write attaches, the write's BoC as its payload, byte for byte — goes through
 * checkTonRequest's jetton-call kind, which reads the BoC again against the reviewed call, then through the call's
 * asynchronous binding (tonPlan.ts TON_CALLS `bind`; Omniston: the secret this browser holds for the escrow's
 * hashlock, its package's verifiers) on that same frozen request, right before the wallet is asked. An account built
 * for a contract call signs nothing else: no plain TON or jetton deposit (its venue never makes one; checkTonPlan
 * refuses one first).
 *
 * Outcomes: TON Connect's error answer, or the SDK's own refusal before it hands the request over, is `answered`
 * (nothing was sent), and so is any failure before an installed wallet (JS bridge) got the request. TON Connect's
 * HTTP bridge confirms a request only once its POST was answered, and retries until then — the wallet may hold one
 * the page never saw confirmed — so any other failure or silence there is maybe-sent (tracked, never retried), like
 * a lost answer after the wallet got it. The signed message's normalized hash is the swap's source hash. Loaded as
 * a lazy chunk with @ton/core (execute.ts).
 */
import {Buffer} from "buffer";
import {Address, beginCell} from "@ton/core";
import {UserRejectedError} from "@anywalletkit/core";
import type {TonConnectRequest, TonSourceSigner} from "../../contracts/execution";
import {answered, refusal, WALLET_DECLINED_TEXT} from "../errors";
import {SwapGateRefusal} from "../gate";
import {
  JETTON_TRANSFER_OP,
  TON_JETTON_ATTACHED,
  TON_JETTON_FORWARD,
  TON_NETWORK,
  TON_VALID_SECONDS,
  checkTonRequest,
  commentCell,
  mainnetRaw,
  messageAddress,
  pinnedJettonWallet,
  tonMessageHash,
  type TonExpected,
} from "../tonGate";
import type {TonCallExpected} from "../tonPlan";

/** Every member the engine touches on a TON account (engine.md §5.2). */
export interface TonEngineAccount {
  /** "ton:-239" — the engine's account-chain check. */
  chain: string;
  getAddress(): Promise<string>;
  /** The payer's jetton wallet for the reviewed call's jetton (the engine binds a contract call's target to it), proven. */
  getJettonWalletAddress(token: string): Promise<string>;
  /** `body`: a text comment; `bodyBoc`: a contract call's exact cell body (never both). */
  sendTransaction(tx: {to: string; value: bigint; body?: string; bodyBoc?: string}): Promise<{hash: string}>;
  transfer(t: {token: string; recipient: string; amount: bigint; memo?: string}): Promise<{hash: string}>;
}

/** What tests replace: the network (TonAPI), the clock, the query id. */
export interface TonAccountDeps {
  fetch?: typeof fetch;
  now?: () => number;
  queryId?: () => bigint;
}

/** How long a TonAPI read may take. */
const API_TIMEOUT_MS = 10_000;
/** After the request's validity ends, how long an unanswered wallet is still waited for. */
const ANSWER_GRACE_MS = 60_000;

const only = (o: object, keys: readonly string[], what: string) => {
  for (const [k, v] of Object.entries(o)) if (v !== undefined && !keys.includes(k)) throw refusal(`This ${what} carries a field (${k}) the swap never sends — nothing was sent.`);
};

const text = (e: unknown): string => String((e as {message?: unknown} | null)?.message ?? e);

const randomQueryId = (): bigint => {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
};

/** A maybe-sent failure (the engine's marker): the wallet may have broadcast it. */
const lostAnswer = (message: string, cause?: unknown, hash?: string): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : {cause}), {maybeSent: true, ...(hash ? {hash} : {})});

/** Adapt the connected TON Connect wallet to the engine account. `call`: the reviewed route's TON contract call, if any. */
export function tonEngineAccount(signer: TonSourceSigner, deps: TonAccountDeps = {}, call?: TonCallExpected): TonEngineAccount {
  const self = mainnetRaw(signer.rawAddress);
  if (!self || mainnetRaw(signer.address) !== self) throw refusal("The TON wallet's address can't be read — nothing was sent.");
  const fetchImpl = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? Date.now;
  const queryId = deps.queryId ?? randomQueryId;
  const api = signer.tonApiUrl.replace(/\/+$/, "");

  /** A TonAPI get-method's decoded answer, or an answered refusal. */
  async function getMethod(account: string, method: string, args?: string): Promise<Record<string, unknown> | null> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    try {
      const url = `${api}/v2/blockchain/accounts/${encodeURIComponent(account)}/methods/${method}${args ? `?args=${encodeURIComponent(args)}` : ""}`;
      const res = await fetchImpl(url, {headers: {accept: "application/json"}, signal: ctl.signal});
      const body = (await res.json().catch(() => null)) as {success?: unknown; decoded?: unknown} | null;
      if (res.ok && body?.success === true && body.decoded && typeof body.decoded === "object") return body.decoded as Record<string, unknown>;
      // TonAPI answers 404 "entity not found" for an account that was never deployed: no such jetton wallet.
      if (res.status === 404) return null;
      throw new Error(`TonAPI ${res.status}`);
    } catch (e) {
      throw refusal("Couldn't read your TON jetton wallet (TonAPI didn't answer) — nothing was sent. Try again in a moment.", e);
    } finally {
      clearTimeout(t);
    }
  }

  /** The payer's jetton wallet for `token`, proven: recomputed from the pinned code; owner, master and balance from its own state. */
  async function jettonWallet(token: string, amount: bigint): Promise<string> {
    const master = mainnetRaw(token);
    if (!master) throw refusal("The token to send isn't a TON jetton — nothing was sent.");
    const pinned = pinnedJettonWallet(master, self!);
    if (pinned === null) throw refusal("This TON jetton can't be sent from a wallet here yet — nothing was sent.");
    const named = await getMethod(master, "get_wallet_address", self!);
    const jw = mainnetRaw(named?.jetton_wallet_address);
    if (!jw) throw refusal("Couldn't find your TON jetton wallet — nothing was sent.");
    if (pinned !== jw) throw refusal("TonAPI named a jetton wallet that isn't yours — nothing was sent.");
    const data = await getMethod(jw, "get_wallet_data");
    if (!data) throw refusal("Your TON wallet holds none of this token — nothing was sent.");
    if (mainnetRaw(data.owner) !== self || mainnetRaw(data.jetton) !== master)
      throw refusal("TonAPI named a jetton wallet that isn't yours for this token — nothing was sent.");
    const balance = typeof data.balance === "string" && /^[0-9]{1,40}$/.test(data.balance) ? BigInt(data.balance) : null;
    if (balance === null) throw refusal("Couldn't read your TON jetton balance — nothing was sent.");
    if (balance < amount) throw refusal("Your TON wallet holds less of this token than the swap sends — nothing was sent.");
    return jw;
  }

  /** Check the request against the write (a contract call: and its binding), then hand it to the wallet once. */
  async function send(req: TonConnectRequest, exp: TonExpected): Promise<{hash: string}> {
    // Frozen: a contract call's binding is awaited between the check and the wallet, and nothing may change in between.
    for (const m of req.messages) Object.freeze(m);
    Object.freeze(req.messages);
    Object.freeze(req);
    const why =
      checkTonRequest(req, exp, {self: self!, now: now()}) ??
      (exp.kind === "jetton-call" ? await exp.call.bind({to: req.messages[0]!.address, value: exp.value, bodyBoc: exp.bodyBoc}) : null);
    if (why) throw new SwapGateRefusal(`The TON message didn't match the reviewed route (${why}) — it was refused before signing.`);
    const acct = signer.sender.account;
    if (!acct || mainnetRaw(acct.address) !== self || acct.chain !== TON_NETWORK)
      throw refusal("Your wallet switched accounts — nothing was sent. Switch back to the account you reviewed.");
    let reached = false;
    // On the HTTP bridge `reached` can lag the wallet (see the outcomes above): only the JS bridge proves "not yet".
    const bridged = signer.sender.wallet?.provider !== "injected";
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitMs = Math.max(0, req.validUntil * 1000 - now()) + ANSWER_GRACE_MS;
    try {
      const answer = signer.sender.sendTransaction(req, {onRequestSent: () => (reached = true), signal: ctl.signal});
      const silence = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(
            reached || bridged
              ? lostAnswer("Your TON wallet didn't answer before the transaction expired — it may still have been sent.")
              : refusal("Your TON wallet never received the transaction — nothing was sent."),
          );
        }, waitMs);
      });
      const res = await Promise.race([answer, silence]);
      const hash = tonMessageHash(res?.boc, self!);
      if (!hash) throw lostAnswer("Your TON wallet sent the transaction but returned no readable message — check Activity before trying again.");
      return {hash};
    } catch (e) {
      const flags = e as {maybeSent?: unknown; answered?: unknown} | null;
      if (flags?.maybeSent === true || flags?.answered === true) throw e;
      const t = text(e);
      if (/User rejects the action|user reject|rejected by user|user declined|cancell?ed by user/i.test(t))
        throw answered(Object.assign(new UserRejectedError(WALLET_DECLINED_TEXT), {cause: e}));
      // The SDK's own errors (it refused before sending, or the wallet answered with an error) never broadcast.
      if (t.startsWith("[TON_CONNECT_SDK_ERROR]") || (!reached && !bridged))
        throw refusal(`Your TON wallet refused the transaction (${t.replace(/^\[TON_CONNECT_SDK_ERROR\]\s*/, "").split("\n")[0]!.slice(0, 120)}) — nothing was sent.`, e);
      throw lostAnswer("Your TON wallet's answer was lost — the transaction may still go through. Check Activity before trying again.", e);
    } finally {
      clearTimeout(timer);
    }
  }

  const request = (message: TonConnectRequest["messages"][number]): TonConnectRequest => ({
    validUntil: Math.floor(now() / 1000) + TON_VALID_SECONDS,
    network: TON_NETWORK,
    from: self!,
    messages: [message],
  });

  const boc = (cell: ReturnType<typeof commentCell>) => Buffer.from(cell.toBoc()).toString("base64");

  const unsigned = () => refusal("This TON deposit carries a contract payload, which isn't signed here — nothing was sent.");
  const callOnly = () => refusal("This route is paid by its TON contract call only; a plain transfer for it isn't signed — nothing was sent.");

  return {
    chain: "ton:-239",
    getAddress: async () => signer.address,
    async getJettonWalletAddress(token) {
      // Only the reviewed call's jetton: any other is refused before TonAPI is asked.
      if (!call || mainnetRaw(token) === null || mainnetRaw(token) !== mainnetRaw(call.jetton)) throw unsigned();
      return jettonWallet(call.jetton, call.amount);
    },
    async sendTransaction(tx) {
      only(tx, ["to", "value", "body", "bodyBoc"], "transaction");
      if (tx.bodyBoc !== undefined) {
        // A venue's contract call: its exact BoC, from the payer's proven jetton wallet, checked again on the request.
        if (!call || tx.body !== undefined || typeof tx.bodyBoc !== "string" || !tx.bodyBoc) throw unsigned();
        const address = messageAddress(tx.to);
        if (!address || typeof tx.value !== "bigint" || tx.value <= 0n) throw refusal("This TON contract call is malformed — nothing was sent.");
        const jw = await jettonWallet(call.jetton, call.amount);
        const req = request({address, amount: tx.value.toString(), payload: tx.bodyBoc});
        return send(req, {kind: "jetton-call", jettonWallet: jw, value: tx.value, bodyBoc: tx.bodyBoc, call});
      }
      if (call) throw callOnly();
      if (tx.body !== undefined && typeof tx.body !== "string") throw unsigned();
      const address = messageAddress(tx.to);
      if (!address || typeof tx.value !== "bigint" || tx.value <= 0n) throw refusal("This TON deposit is malformed — nothing was sent.");
      const req = request({address, amount: tx.value.toString(), ...(tx.body !== undefined ? {payload: boc(commentCell(tx.body))} : {})});
      return send(req, {kind: "native", to: tx.to, value: tx.value, ...(tx.body !== undefined ? {comment: tx.body} : {})});
    },
    async transfer(t) {
      if (call) throw callOnly();
      only(t, ["token", "recipient", "amount", "memo"], "transfer");
      const recipient = mainnetRaw(t.recipient);
      if (!recipient || typeof t.amount !== "bigint" || t.amount <= 0n || (t.memo !== undefined && typeof t.memo !== "string"))
        throw refusal("This jetton deposit is malformed — nothing was sent.");
      const jw = await jettonWallet(t.token, t.amount);
      const body = beginCell()
        .storeUint(JETTON_TRANSFER_OP, 32)
        .storeUint(queryId(), 64)
        .storeCoins(t.amount)
        .storeAddress(Address.parseRaw(recipient))
        .storeAddress(Address.parseRaw(self!))
        .storeMaybeRef(null)
        .storeCoins(TON_JETTON_FORWARD)
        .storeMaybeRef(t.memo !== undefined ? commentCell(t.memo) : null)
        .endCell();
      const req = request({address: Address.parseRaw(jw).toString({urlSafe: true, bounceable: true}), amount: TON_JETTON_ATTACHED.toString(), payload: boc(body)});
      return send(req, {kind: "jetton", jettonWallet: jw, recipient: t.recipient, amount: t.amount, ...(t.memo !== undefined ? {comment: t.memo} : {})});
    },
  };
}
