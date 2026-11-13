/**
 * Tron payments from a wallet (D10, D20) without a network or a real wallet:
 * - the transaction builder reproduces node-built transactions byte for byte (vectors from /wallet/triggersmartcontract
 *   and /wallet/createtransaction, 2026-11-12), and the strict decoder refuses every altered field;
 * - the signature check takes only a signature by the payer over this txID (a throwaway key stands in for the wallet);
 * - the account signs once, broadcasts its own bytes, and maps every refusal or lost answer the way the engine needs;
 * - end to end through the real engine (RouterSwap2Protocol), executeSwap and the gate: what the fake TronLink is asked
 *   to sign is exactly the reviewed deposit, and a plan that isn't never reaches it.
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import {generatePrivateKey, privateKeyToAccount, sign} from "viem/accounts";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import type {CrossChainProvider, Quote, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import type {SwapToken} from "../../../src/contracts/domain";
import type {ReviewedSwap, TronSourceSigner} from "../../../src/contracts/execution";
import {bytesToHex, hexToBytes, tronAddressBytes, tronAddressFromBytes} from "../../../src/catalog";
import {TRON_FEE_LIMIT, tronEngineAccount, type TronApi} from "../../../src/execute/accounts/tron";
import {gateAccount} from "../../../src/execute/accounts/gated";
import {isWalletRejection, swapErrorText, WALLET_DECLINED_TEXT} from "../../../src/execute/errors";
import {executeSwap} from "../../../src/execute/execute";
import {checkPlanBrowser, createSwapGate, matches, planWrites, SwapGateRefusal, SwapReviewMismatch, type TronRule} from "../../../src/execute/gate";
import {TRON_RULES} from "../../../src/execute/pins";
import {buildTronTx, checkTronRaw, signedTxHex, TRON_TX_TTL_MS, verifiedSignature, type RefBlock, type TronTransfer} from "../../../src/execute/tronTx";

const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const VAULT = "TEcDijvKSXcfWT7S6rd44H5vNgufm7Y4XC"; // Chainflip's Tron Vault (CF_VAULTS)
const TRON = "tron:728126428";
const fromHex = (h: string) => tronAddressFromBytes(hexToBytes(h))!;

// ── vectors ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A reference block whose low number bytes / id bytes are the vector's, expiring when the vector does. */
const refFor = (refBytes: string, refHash: string, expiration: number): RefBlock => ({
  number: BigInt(`0x053d${refBytes}`),
  id: `00000000053d${refBytes}${refHash}`.padEnd(64, "0"),
  timestamp: expiration - TRON_TX_TTL_MS,
});

describe("buildTronTx (node-built vectors)", () => {
  it("a TRC-20 transfer: the same raw bytes and txID as /wallet/triggersmartcontract", () => {
    const tx = buildTronTx(
      {
        kind: "trc20",
        owner: fromHex("41d3682962027e721c5247a9faf7865fe4a71d5438"),
        token: USDT,
        to: fromHex("41d3682962027e721c5247a9faf7865fe4a71d5439"),
        amount: 1n,
        feeLimit: 60_000_000n,
      },
      refFor("ec79", "d6a2d5cadad2643d", 1794506904000),
      1794506844695,
    );
    expect(tx.raw_data_hex).toBe(
      "0a02ec792208d6a2d5cadad2643d40c0a3c9879d345aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a1541d3682962027e721c5247a9faf7865fe4a71d5438121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000d3682962027e721c5247a9faf7865fe4a71d543900000000000000000000000000000000000000000000000000000000000000017097d4c5879d349001808ece1c",
    );
    expect(tx.txID).toBe("a5eead3bf7a70b2a412801b0461d02e7b9cbe1503cd02207b9ccc8cd9ddeaddc");
    expect(tx.raw_data).toEqual({
      ref_block_bytes: "ec79",
      ref_block_hash: "d6a2d5cadad2643d",
      expiration: 1794506904000,
      contract: [
        {
          parameter: {
            value: {
              owner_address: "41d3682962027e721c5247a9faf7865fe4a71d5438",
              contract_address: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
              data: "a9059cbb000000000000000000000000d3682962027e721c5247a9faf7865fe4a71d54390000000000000000000000000000000000000000000000000000000000000001",
            },
            type_url: "type.googleapis.com/protocol.TriggerSmartContract",
          },
          type: "TriggerSmartContract",
        },
      ],
      timestamp: 1794506844695,
      fee_limit: 60000000,
    });
  });

  it("a TRX send with a memo: the same raw bytes and txID as /wallet/createtransaction with extra_data", () => {
    const tx = buildTronTx(
      {
        kind: "trx",
        owner: fromHex("41d3682962027e721c5247a9faf7865fe4a71d5438"),
        to: USDT,
        amount: 1234567n,
        memo: new TextEncoder().encode("hello"),
      },
      refFor("ec87", "32a0bc30c787b2d2", 1794506946000),
      1794506888018,
    );
    expect(tx.raw_data_hex).toBe(
      "0a02ec87220832a0bc30c787b2d240d0ebcb879d34520568656c6c6f5a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541d3682962027e721c5247a9faf7865fe4a71d5438121541a614f803b6fd780986a42c78ec9c7f77e6ded13c1887ad4b70d2a6c8879d34",
    );
    expect(tx.txID).toBe("5c5980070cb9a9e4a01ec56d5e6eb42667b79936148b44dc6b62b0a818829cb6");
    expect(tx.raw_data.data).toBe("68656c6c6f");
  });
});

// ── the byte-level check ─────────────────────────────────────────────────────────────────────────────────────────

const OWNER_KEY = generatePrivateKey();
const OWNER = fromHex(`41${privateKeyToAccount(OWNER_KEY).address.slice(2)}`);
const DEPOSIT = fromHex("41a614f803b6fd780986a42c78ec9c7f77e6ded13d");
const NOW_BLOCK = (): RefBlock => ({number: 87_944_324n, id: `00000000053dec84${"39b47990fc4da5b9"}${"0".repeat(32)}`, timestamp: Date.now()});
const USDT_PAY: TronTransfer = {kind: "trc20", owner: OWNER, token: USDT, to: DEPOSIT, amount: 25_000_000n, feeLimit: TRON_FEE_LIMIT};

/** Re-encode a raw transaction with one varint field changed (field 18 fee limit, 8 expiration) — a hand-made tamper. */
function withField(rawHex: string, append: number[]): string {
  return bytesToHex(new Uint8Array([...hexToBytes(rawHex), ...append]), false);
}

describe("checkTronRaw", () => {
  it("accepts exactly the transfer it was built from", () => {
    const tx = buildTronTx(USDT_PAY, NOW_BLOCK());
    expect(checkTronRaw(tx.raw_data_hex, USDT_PAY)).toBeNull();
    const trx: TronTransfer = {kind: "trx", owner: OWNER, to: DEPOSIT, amount: 5n, memo: hexToBytes("0x0102")};
    expect(checkTronRaw(buildTronTx(trx, NOW_BLOCK()).raw_data_hex, trx)).toBeNull();
  });

  it("refuses every field that isn't the reviewed transfer", () => {
    const raw = buildTronTx(USDT_PAY, NOW_BLOCK()).raw_data_hex;
    expect(checkTronRaw(raw, {...USDT_PAY, amount: 25_000_001n})).toMatch(/recipient and amount/);
    expect(checkTronRaw(raw, {...USDT_PAY, to: VAULT})).toMatch(/recipient and amount/);
    expect(checkTronRaw(raw, {...USDT_PAY, token: VAULT})).toMatch(/another token contract/);
    expect(checkTronRaw(raw, {...USDT_PAY, owner: VAULT})).toMatch(/another account/);
    expect(checkTronRaw(raw, {...USDT_PAY, feeLimit: 1n})).toMatch(/fee limit/);
    expect(checkTronRaw(raw, {...USDT_PAY, memo: new Uint8Array([1])})).toMatch(/memo/);
    expect(checkTronRaw(raw, {kind: "trx", owner: OWNER, to: DEPOSIT, amount: 25_000_000n})).toMatch(/not a TRX transfer/);
    // A repeated field, an unknown one (12: scripts), a truncated buffer.
    expect(checkTronRaw(withField(raw, [0x90, 0x01, 0x01]), USDT_PAY)).toMatch(/repeated/);
    expect(checkTronRaw(withField(raw, [0x62, 0x01, 0x00]), USDT_PAY)).toMatch(/unexpected field 12/);
    expect(checkTronRaw(raw.slice(0, -4), USDT_PAY)).toMatch(/can't be read/);
    // Expired, or an expiration far beyond what the node allows.
    expect(checkTronRaw(raw, USDT_PAY, Date.now() + TRON_TX_TTL_MS + 1)).toMatch(/expiration/);
    expect(checkTronRaw(raw, USDT_PAY, Date.now() - 25 * 3_600_000)).toMatch(/expiration/);
  });
});

// ── the signature ────────────────────────────────────────────────────────────────────────────────────────────────

const sigOver = async (txID: string, key = OWNER_KEY) => (await sign({hash: `0x${txID}`, privateKey: key, to: "hex"})).slice(2);

describe("verifiedSignature", () => {
  it("takes a signature by the payer over this txID, in either v form (27/28 or a Ledger's 0/1)", async () => {
    const tx = buildTronTx(USDT_PAY, NOW_BLOCK());
    const sig = await sigOver(tx.txID);
    expect(await verifiedSignature(tx.txID, sig, OWNER)).toBe(sig.toLowerCase());
    const v = parseInt(sig.slice(128), 16);
    const ledger = `${sig.slice(0, 128)}0${v - 27}`;
    expect(await verifiedSignature(tx.txID, ledger, OWNER)).toBe(ledger);
  });

  it("refuses another key, another txID and anything malformed", async () => {
    const tx = buildTronTx(USDT_PAY, NOW_BLOCK());
    expect(await verifiedSignature(tx.txID, await sigOver(tx.txID, generatePrivateKey()), OWNER)).toBeNull();
    expect(await verifiedSignature(tx.txID, await sigOver("11".repeat(32)), OWNER)).toBeNull();
    for (const bad of [undefined, 42, "", "0x00", `${"ab".repeat(64)}05`, {signature: "x"}]) expect(await verifiedSignature(tx.txID, bad, OWNER)).toBeNull();
  });
});

// ── the account ──────────────────────────────────────────────────────────────────────────────────────────────────

type Wallet = {sign(tx: unknown): Promise<unknown>; asked: unknown[]};

/** A TronLink TronWeb stand-in: signs the txID it is handed with `key` (or misbehaves as told). */
function fakeTronWeb(o: {key?: `0x${string}`; reject?: boolean; tamper?: (signed: Record<string, unknown>) => void; address?: () => string} = {}) {
  const asked: unknown[] = [];
  const trx: Wallet = {
    asked,
    async sign(tx: unknown) {
      asked.push(structuredClone(tx));
      if (o.reject) throw "Confirmation declined by user";
      const t = tx as {txID: string};
      const signed: Record<string, unknown> = {...(tx as object), signature: [await sigOver(t.txID, o.key ?? OWNER_KEY)]};
      o.tamper?.(signed);
      return signed;
    },
  };
  return {
    tronWeb: {
      get defaultAddress() {
        return {base58: o.address ? o.address() : OWNER};
      },
      trx,
    },
    asked,
  };
}

/** The node API: a recent block, a passing dry run, and a broadcast answer per host (a function, or an Error to throw). */
function fakeApi(o: {broadcast?: Record<string, unknown | Error>; simulate?: unknown} = {}) {
  const calls: {base?: string; path: string; body: unknown}[] = [];
  const api: TronApi = {
    async post<T>(path: string, body: unknown) {
      calls.push({path, body});
      if (path === "/wallet/getnowblock") return {blockID: NOW_BLOCK().id, block_header: {raw_data: {number: 87_944_324, timestamp: Date.now()}}} as T;
      if (path === "/wallet/triggerconstantcontract") return (o.simulate ?? {result: {result: true}, constant_result: ["01".padStart(64, "0")], transaction: {ret: [{}]}}) as T;
      if (path === "/wallet/getaccount") return {balance: 1_000_000} as T;
      throw new Error(`unexpected ${path}`);
    },
    async postTo<T>(base: string, path: string, body: unknown) {
      calls.push({base, path, body});
      const a = o.broadcast?.[base] ?? {result: true};
      if (a instanceof Error) throw a;
      return a as T;
    },
  };
  return {api, calls, broadcasts: () => calls.filter((c) => c.path === "/wallet/broadcasthex")};
}

const HOSTS = ["https://a.tron.test", "https://b.tron.test"];
const signerOf = (tw: TronSourceSigner["tronWeb"]): TronSourceSigner => ({family: "tron", tronWeb: tw, owner: OWNER, walletName: "TronLink", apiUrls: HOSTS});

describe("tronEngineAccount", () => {
  it("TRC-20: a dry run, one prompt, our own bytes broadcast with the payer's signature", async () => {
    const w = fakeTronWeb();
    const n = fakeApi();
    const acc = tronEngineAccount(signerOf(w.tronWeb), {api: n.api});
    const res = await acc.transfer({token: USDT, recipient: DEPOSIT, amount: 25_000_000n});
    expect(w.asked).toHaveLength(1);
    const asked = w.asked[0] as {txID: string; raw_data_hex: string};
    expect(res).toEqual({hash: asked.txID, fee: 0n});
    expect(checkTronRaw(asked.raw_data_hex, USDT_PAY)).toBeNull();
    expect(n.calls.map((c) => c.path)).toEqual(["/wallet/triggerconstantcontract", "/wallet/getnowblock", "/wallet/broadcasthex"]);
    const sent = n.broadcasts()[0]!;
    expect(sent.base).toBe(HOSTS[0]);
    expect((sent.body as {transaction: string}).transaction).toBe(signedTxHex(asked.raw_data_hex, await sigOver(asked.txID)));
  });

  it("TRX with Chainflip's hex note: the note's bytes in raw_data.data", async () => {
    const w = fakeTronWeb();
    const acc = tronEngineAccount(signerOf(w.tronWeb), {api: fakeApi().api});
    await acc.sendTransaction({to: VAULT, value: 30_000_000n, memo: "0x11223344", memoEncoding: "hex"});
    const asked = w.asked[0] as {raw_data: {data: string}; raw_data_hex: string};
    expect(asked.raw_data.data).toBe("11223344");
    expect(checkTronRaw(asked.raw_data_hex, {kind: "trx", owner: OWNER, to: VAULT, amount: 30_000_000n, memo: hexToBytes("0x11223344")})).toBeNull();
  });

  it("a rejection in TronLink is answered with the declined text; nothing is broadcast", async () => {
    const n = fakeApi();
    const acc = tronEngineAccount(signerOf(fakeTronWeb({reject: true}).tronWeb), {api: n.api});
    const e = await acc.transfer({token: USDT, recipient: DEPOSIT, amount: 1n}).catch((x: unknown) => x);
    expect(isWalletRejection(e)).toBe(true);
    expect((e as {answered?: boolean}).answered).toBe(true);
    expect(swapErrorText(e, "TRX")).toBe(WALLET_DECLINED_TEXT);
    expect(n.broadcasts()).toEqual([]);
  });

  it("refuses a signature by another key, a changed txID or two signatures — nothing is broadcast", async () => {
    for (const w of [
      fakeTronWeb({key: generatePrivateKey()}),
      fakeTronWeb({tamper: (s) => void (s.txID = "00".repeat(32))}),
      fakeTronWeb({tamper: (s) => void (s.signature = [...(s.signature as string[]), "ab"])}),
    ]) {
      const n = fakeApi();
      const e = await tronEngineAccount(signerOf(w.tronWeb), {api: n.api})
        .transfer({token: USDT, recipient: DEPOSIT, amount: 1n})
        .catch((x: unknown) => x);
      expect((e as {answered?: boolean}).answered, String(e)).toBe(true);
      expect(n.broadcasts()).toEqual([]);
    }
  });

  it("refuses before any prompt: another account in the wallet, an unlisted token, a dry run that reverts, a stray field", async () => {
    let address = OWNER;
    const w = fakeTronWeb({address: () => address});
    const n = fakeApi();
    const acc = tronEngineAccount(signerOf(w.tronWeb), {api: n.api});
    address = DEPOSIT;
    await expect(acc.transfer({token: USDT, recipient: DEPOSIT, amount: 1n})).rejects.toThrow(/switched accounts/);
    address = OWNER;
    await expect(acc.transfer({token: VAULT, recipient: DEPOSIT, amount: 1n})).rejects.toThrow(/doesn't list on Tron/);
    await expect(acc.sendTransaction({to: DEPOSIT, value: 1n, data: "0x00"} as never)).rejects.toThrow(/field \(data\)/);
    await expect(acc.sendTransaction({to: "T1", value: 1n})).rejects.toThrow(/isn't a Tron address/);
    await expect(acc.sendTransaction({to: DEPOSIT, value: 1n, memo: "zz", memoEncoding: "hex"})).rejects.toThrow(/memo is malformed/);
    const reverting = tronEngineAccount(signerOf(w.tronWeb), {api: fakeApi({simulate: {result: {result: true}, transaction: {ret: [{ret: "FAILED"}]}}}).api});
    await expect(reverting.transfer({token: USDT, recipient: DEPOSIT, amount: 1n})).rejects.toThrow(/would fail on-chain/);
    expect(w.asked).toEqual([]);
  });

  it("broadcast: a duplicate is sent; every host refusing is 'not sent'; a lost answer is maybe-sent with the hash", async () => {
    const dup = fakeApi({broadcast: {[HOSTS[0]!]: {result: false, code: "DUP_TRANSACTION_ERROR"}}});
    await expect(tronEngineAccount(signerOf(fakeTronWeb().tronWeb), {api: dup.api}).transfer({token: USDT, recipient: DEPOSIT, amount: 1n})).resolves.toMatchObject({fee: 0n});

    const refused = fakeApi({
      broadcast: {
        [HOSTS[0]!]: {result: false, code: "CONTRACT_VALIDATE_ERROR", message: bytesToHex(new TextEncoder().encode("balance is not sufficient"), false)},
        [HOSTS[1]!]: {result: false, code: "BANDWITH_ERROR"},
      },
    });
    const e1 = await tronEngineAccount(signerOf(fakeTronWeb().tronWeb), {api: refused.api})
      .transfer({token: USDT, recipient: DEPOSIT, amount: 1n})
      .catch((x: unknown) => x);
    expect((e1 as Error).message).toMatch(/CONTRACT_VALIDATE_ERROR: balance is not sufficient; BANDWITH_ERROR\) — nothing was sent/);
    expect((e1 as {answered?: boolean}).answered).toBe(true);

    const lost = fakeApi({broadcast: {[HOSTS[0]!]: new Error("network down"), [HOSTS[1]!]: {result: false, code: "SIGERROR"}}});
    const w = fakeTronWeb();
    const e2 = await tronEngineAccount(signerOf(w.tronWeb), {api: lost.api})
      .transfer({token: USDT, recipient: DEPOSIT, amount: 1n})
      .catch((x: unknown) => x);
    expect(e2).toMatchObject({maybeSent: true, hash: (w.asked[0] as {txID: string}).txID});
  });

  it("is reachable only through the gate: an unarmed transfer never builds or prompts", async () => {
    const w = fakeTronWeb();
    const n = fakeApi();
    const gate = createSwapGate(TRON);
    gate.arm([{kind: "transfer", token: USDT, recipient: DEPOSIT, amount: 25_000_000n}]);
    const acc = gateAccount(tronEngineAccount(signerOf(w.tronWeb), {api: n.api}), gate);
    await expect(acc.transfer({token: USDT, recipient: VAULT, amount: 25_000_000n})).rejects.toBeInstanceOf(SwapGateRefusal);
    // One stray write disarmed the rest: the armed one is refused too.
    await expect(acc.transfer({token: USDT, recipient: DEPOSIT, amount: 25_000_000n})).rejects.toBeInstanceOf(SwapGateRefusal);
    expect(w.asked).toEqual([]);
    expect(n.calls).toEqual([]);
  });
});

// ── the gate's Tron rule ─────────────────────────────────────────────────────────────────────────────────────────

const reviewedTron = (over: Partial<ReviewedSwap> = {}): ReviewedSwap => ({
  provider: "near_intents",
  fromChain: TRON,
  fromContract: USDT,
  amountIn: 25_000_000n,
  destChain: "eip155:8453",
  destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  recipient: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
  refundAddress: OWNER,
  minOut: 24_000_000n,
  slippageBps: 50,
  approvalSpender: null,
  nativeFee: 0n,
  ...over,
});

const planOf = (r: ReviewedSwap, source: Swap2ExecutionPlan["source"], over: Partial<Swap2ExecutionPlan> = {}): Swap2ExecutionPlan => ({
  provider: r.provider,
  fromChain: r.fromChain,
  destChain: r.destChain,
  destToken: r.destToken,
  recipient: r.recipient,
  refundAddress: r.refundAddress,
  sourceAmount: r.amountIn,
  destAmount: 24_900_000n,
  minDestAmount: 24_500_000n,
  feeUsd: 0.1,
  etaSeconds: 60,
  validUntilMs: Date.now() + 60_000,
  approvals: [],
  source,
  ...over,
});

describe("checkPlanBrowser on Tron", () => {
  const near = TRON_RULES.near_intents;
  const cf = TRON_RULES.chainflip;

  it("has rules for NEAR Intents (deposit) and Chainflip (its Tron Vault, hex note) only", () => {
    expect(Object.keys(TRON_RULES).sort()).toEqual(["chainflip", "near_intents"]);
    expect(cf).toEqual({kind: "vault", to: [VAULT], memo: "hex"});
  });

  it("passes the reviewed TRC-20 or TRX deposit", () => {
    const r = reviewedTron();
    expect(checkPlanBrowser(planOf(r, {kind: "token-transfer", token: USDT, recipient: DEPOSIT, amount: r.amountIn}), r, undefined, near)).toBeNull();
    const t = reviewedTron({fromContract: null, amountIn: 40_000_000n});
    expect(checkPlanBrowser(planOf(t, {kind: "call", to: DEPOSIT, value: t.amountIn}), t, undefined, near)).toBeNull();
    const c = reviewedTron({provider: "chainflip", fromContract: null, amountIn: 40_000_000n});
    expect(checkPlanBrowser(planOf(c, {kind: "call", to: VAULT, value: c.amountIn, memo: "0x0a0b", memoEncoding: "hex"}), c, undefined, cf)).toBeNull();
  });

  it("refuses what the review didn't show", () => {
    const r = reviewedTron();
    const tt = (over: object = {}) => ({kind: "token-transfer" as const, token: USDT, recipient: DEPOSIT, amount: r.amountIn, ...over});
    const cases: [Swap2ExecutionPlan, TronRule | undefined, RegExp][] = [
      [planOf(r, tt()), undefined, /no Tron rule/],
      [planOf(r, tt({recipient: OWNER})), near, /your own address/],
      [planOf(r, tt({recipient: "0x8ba1f109551bD432803012645Ac136ddd64DBA72"})), near, /isn't a Tron address/],
      [planOf(r, tt({memo: "hi"})), near, /memo the review didn't show/],
      [planOf(r, tt({amount: r.amountIn + 1n})), near, /not the reviewed token or amount/],
      [planOf(r, tt({token: VAULT})), near, /not the reviewed token or amount/],
      [planOf(r, {kind: "call", to: DEPOSIT, value: 1n}), near, /sends more than you reviewed/],
      [planOf(r, {kind: "call", to: DEPOSIT, value: 0n, data: "0xa9059cbb"}), near, /calldata/],
      [planOf(r, tt(), {approvals: [{token: USDT, spender: DEPOSIT, amount: r.amountIn}]}), near, /approval/],
      [planOf(r, {kind: "serialized", serializedTx: "AA=="}), near, /provider-built transaction/],
    ];
    for (const [plan, rule, why] of cases) expect(checkPlanBrowser(plan, r, undefined, rule), String(why)).toMatch(why);
    const t = reviewedTron({provider: "chainflip", fromContract: null, amountIn: 40_000_000n});
    const call = (over: object) => ({kind: "call" as const, to: VAULT, value: t.amountIn, memo: "0x0a0b", memoEncoding: "hex" as const, ...over});
    expect(checkPlanBrowser(planOf(t, call({to: DEPOSIT})), t, undefined, cf)).toMatch(/contract the app doesn't trust/);
    expect(checkPlanBrowser(planOf(t, call({memoEncoding: "utf8"})), t, undefined, cf)).toMatch(/another encoding/);
    expect(checkPlanBrowser(planOf(t, call({memo: "not hex"})), t, undefined, cf)).toMatch(/malformed memo/);
    expect(checkPlanBrowser(planOf(t, call({value: t.amountIn + 1n})), t, undefined, cf)).toMatch(/sends more/);
    // No note: the Vault can't tie the payment to a swap, as a TRX send or a TRC-20 transfer.
    expect(checkPlanBrowser(planOf(t, {kind: "call", to: VAULT, value: t.amountIn}), t, undefined, cf)).toMatch(/vault without its note/);
    expect(checkPlanBrowser(planOf(t, call({memo: undefined, memoEncoding: undefined})), t, undefined, cf)).toMatch(/vault without its note/);
    const u = reviewedTron({provider: "chainflip"});
    expect(checkPlanBrowser(planOf(u, tt({recipient: VAULT})), u, undefined, cf)).toMatch(/vault without its note/);
  });

  it("arms the memo's encoding: the same memo as text is not the armed write", () => {
    const t = reviewedTron({provider: "chainflip", fromContract: null, amountIn: 40_000_000n});
    const {writes} = planWrites(planOf(t, {kind: "call", to: VAULT, value: t.amountIn, memo: "0x0a0b", memoEncoding: "hex"}));
    expect(writes).toEqual([{kind: "call", to: VAULT, value: t.amountIn, memo: "0x0a0b", memoEncoding: "hex"}]);
    expect(matches(writes[0]!, "sendTransaction", {to: VAULT, value: t.amountIn, memo: "0x0a0b", memoEncoding: "hex"})).toBe(true);
    expect(matches(writes[0]!, "sendTransaction", {to: VAULT, value: t.amountIn, memo: "0x0a0b"})).toBe(false);
    expect(matches(writes[0]!, "sendTransaction", {to: VAULT, value: t.amountIn, memo: "0x0a0b", memoEncoding: "utf8"})).toBe(false);
  });
});

// ── end to end: engine → gate → Tron account → fake TronLink ─────────────────────────────────────────────────────

const token = (over: Partial<SwapToken>): SwapToken => ({
  key: `tron:${USDT.toLowerCase()}`,
  chain: "tron",
  caip2: TRON,
  chainName: "Tron",
  family: "tron",
  symbol: "USDT",
  catalogSymbol: "USDT",
  decimals: 6,
  contract: USDT,
  gasToken: false,
  amount: "100000000",
  balance: "loaded",
  usd: 100,
  owner: OWNER,
  payMode: "wallet",
  ...over,
});
const FROM = token({});
const TO = token({
  key: "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  chain: "base",
  caip2: "eip155:8453",
  chainName: "Base",
  family: "evm",
  contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  catalogSymbol: "USDC",
  owner: null,
});

/** A 1Click-shaped venue: a per-quote Tron deposit address, the reviewed amount; `over` changes what it says. */
function nearVenue(over: Partial<Quote> = {}, build?: (q: Quote) => UnsignedTx): CrossChainProvider {
  return {
    name: "near_intents",
    supportsSameChain: false,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async (p) => ({
      provider: "near_intents",
      intentId: `ni1:${DEPOSIT}|`,
      depositAddress: DEPOSIT,
      depositMemo: null,
      sourceAmount: p.amountIn,
      destAmount: "24900000",
      minDestAmount: "24800000",
      feeUsd: 0.1,
      etaSeconds: 60,
      reliability: 0.95,
      validUntilMs: Date.now() + 55_000,
      ...over,
    }),
    buildDeposit: async (q) => build?.(q) ?? {chain: "", to: q.depositAddress, value: q.sourceAmount, ...(q.depositMemo ? {memo: q.depositMemo} : {})},
    trackIntent: async () => ({state: "pending" as const}),
  };
}

function rig(provider: CrossChainProvider, o: {r?: ReviewedSwap; wallet?: ReturnType<typeof fakeTronWeb>} = {}) {
  const w = o.wallet ?? fakeTronWeb();
  const n = fakeApi();
  const router = new CrossChainRouter([provider]);
  const run = () => executeSwap({from: FROM, to: TO, reviewed: o.r ?? reviewedTron(), signer: signerOf(w.tronWeb)}, {router: () => router, tronApi: () => n.api});
  return {run, wallet: w, api: n};
}

afterEach(() => vi.restoreAllMocks());

describe("executeSwap from a Tron wallet (real engine, fake TronLink)", () => {
  it("signs exactly the reviewed USDT deposit and broadcasts it", async () => {
    const {run, wallet, api} = rig(nearVenue());
    const res = await run();
    expect(wallet.asked).toHaveLength(1);
    const asked = wallet.asked[0] as {txID: string; raw_data_hex: string};
    expect(checkTronRaw(asked.raw_data_hex, USDT_PAY)).toBeNull();
    expect(res).toMatchObject({hash: asked.txID, depositTo: DEPOSIT});
    expect(res.id).toMatch(/^awk1\.near_intents\./);
    expect(api.broadcasts()).toHaveLength(1);
  });

  it("refuses a live quote that pays the payer's own address or carries a memo, and a build that pays elsewhere — TronLink is never asked", async () => {
    for (const [venue, why] of [
      [nearVenue({depositAddress: OWNER, intentId: `ni1:${OWNER}|`}), /your own address/],
      [nearVenue({depositMemo: "pay-me"}), /memo the review didn't show/],
    ] as const) {
      const {run, wallet} = rig(venue);
      const e = await run().catch((x: unknown) => x);
      expect(e, String(e)).toBeInstanceOf(SwapReviewMismatch);
      expect((e as Error).message).toMatch(why);
      expect(wallet.asked).toEqual([]);
    }
    // A build that pays another address than the quote named: the engine itself refuses it.
    const {run, wallet} = rig(nearVenue({}, (q) => ({chain: "", to: VAULT, value: q.sourceAmount})));
    await expect(run()).rejects.toThrow(/does not match the validated quote deposit/);
    expect(wallet.asked).toEqual([]);
  });

  it("refuses a Tron signer for another account than the reviewed refund address", async () => {
    const {run, wallet} = rig(nearVenue(), {r: reviewedTron({refundAddress: VAULT})});
    await expect(run()).rejects.toBeInstanceOf(SwapReviewMismatch);
    expect(wallet.asked).toEqual([]);
  });

  it("a decline in TronLink ends the swap as answered, with nothing broadcast", async () => {
    const {run, api} = rig(nearVenue(), {wallet: fakeTronWeb({reject: true})});
    const e = await run().catch((x: unknown) => x);
    expect(swapErrorText(e, "TRX")).toBe(WALLET_DECLINED_TEXT);
    expect(api.broadcasts()).toEqual([]);
  });

  it("checks the address helpers it builds on", () => {
    expect(tronAddressBytes(OWNER)?.[0]).toBe(0x41);
    expect(tronAddressFromBytes(tronAddressBytes(USDT)!)).toBe(USDT);
    expect(tronAddressBytes(`${USDT.slice(0, -1)}u`)).toBeNull();
  });
});
