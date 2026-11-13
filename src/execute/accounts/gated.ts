/**
 * The signing choke point (engine.md §7.2-7.3, ARCHITECTURE.md D10): the object the engine actually holds. Each
 * write method first CONSUMES one armed write on this execution's gate — on a frozen copy of exactly what the
 * engine asked for, which is also what reaches the adapter — and only then may the adapter talk to the wallet.
 * Anything the gate does not recognise is refused with SwapGateRefusal (`answered`: the engine reports "nothing
 * sent" and runs its cleanup, a revoke, through this same gate).
 *
 * Only the members the engine is known to call survive (engine.md §5.2): an adapter growing an extra write method
 * cannot leak past the gate by accident.
 */
import type {SwapGate, WriteMethod} from "../gate";
import {readApprove, SwapGateRefusal} from "../gate";

/** Read-only members the engine calls; passed through untouched. */
const READS = ["getAddress", "getChainId", "getBalance", "getAllowance", "getTokenInfo", "quoteSendTransaction", "waitForTransaction"] as const;

/** Write members the engine calls, and the gate's name for each. */
const WRITES = {
  sendTransaction: "sendTransaction",
  transfer: "transfer",
  sendSerializedTransaction: "sendSerialized",
  signTypedData: "signTypedData",
} as const satisfies Record<string, WriteMethod>;

type EngineMember = (typeof READS)[number] | keyof typeof WRITES | "chain";

/** What gateAccount returns: the inner account's engine members only. */
export type Gated<T> = Pick<T, Extract<keyof T, EngineMember>>;

/** The Solana signing window (solana.ts): opened for exactly the duration of one gated write. */
export interface WindowControl {
  open(): void;
  close(): void;
}

/** A deep, frozen copy, so nothing can change the request between the gate's check and the wallet. */
function snapshot(v: unknown): unknown {
  let copy: unknown;
  try {
    copy = structuredClone(v);
  } catch {
    throw new SwapGateRefusal("A transaction couldn't be checked against the reviewed route — it was refused before signing.");
  }
  const freeze = (x: unknown): unknown => {
    if (x && typeof x === "object" && !Object.isFrozen(x)) {
      Object.freeze(x);
      for (const k of Object.keys(x)) freeze((x as Record<string, unknown>)[k]);
    }
    return x;
  };
  return freeze(copy);
}

const isAnswered = (e: unknown): boolean => {
  for (let x = e, i = 0; x && typeof x === "object" && i < 6; x = (x as {cause?: unknown}).cause, i++)
    if ((x as {answered?: unknown}).answered === true) return true;
  return false;
};

/**
 * Wrap an engine account so every write passes `gate` first. One object per execution: the engine's in-flight
 * guard keys on it. `window` (Solana) is open only while a consumed write runs.
 */
export function gateAccount<T extends object>(inner: T, gate: SwapGate, window?: WindowControl): Gated<T> {
  const src = inner as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof src.chain === "string") out.chain = src.chain;
  for (const name of READS) {
    const fn = src[name];
    if (typeof fn === "function") out[name] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(inner, args);
  }
  for (const [name, method] of Object.entries(WRITES)) {
    const fn = src[name];
    if (typeof fn !== "function") continue;
    out[name] = async (...args: unknown[]) => {
      const raw = snapshot(args[0]);
      if (!gate.consume({chain: gate.chain, method, raw})) throw new SwapGateRefusal();
      const rest = args.slice(1).map(snapshot);
      const approve = method === "sendTransaction" ? readApprove((raw as {data?: unknown} | null)?.data) : null;
      const grant = approve && approve.amount > 0n ? () => gate.recordGrant(String((raw as {to: unknown}).to), approve.spender) : null;
      window?.open();
      try {
        const res = (await (fn as (...a: unknown[]) => Promise<{hash?: unknown}>).apply(inner, [raw, ...rest])) ?? {};
        if (grant && res.hash) grant();
        return res;
      } catch (e) {
        // An approval that may have landed (no definitive answer) can be revoked; a refused one leaves nothing to revoke.
        if (grant && !isAnswered(e)) grant();
        throw e;
      } finally {
        window?.close();
      }
    };
  }
  return Object.freeze(out) as Gated<T>;
}
