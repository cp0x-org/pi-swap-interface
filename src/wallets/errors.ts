/**
 * Wallet errors in the user's words. A connect or switch refusal never sent
 * anything, so the errors we raise carry `answered: true` (D25): execute and
 * the screens then show the text as is and never treat it as "maybe sent".
 */

/** An Error whose message is user text and which proves nothing was broadcast. */
export type AnsweredError = Error & {answered: true};

/** Build an answered Error (the cause is kept for the console, never shown). */
export function answered(message: string, cause?: unknown): AnsweredError {
  return Object.assign(new Error(message, cause === undefined ? undefined : {cause}), {answered: true as const});
}

export const isAnswered = (e: unknown): e is AnsweredError =>
  e instanceof Error && (e as {answered?: unknown}).answered === true;

/**
 * Codes that mean "the user said no": EIP-1193 4001, and WalletConnect's
 * USER_REJECTED family (5000-5003) that some wallets forward as the code.
 */
const REJECT_CODES = new Set([4001, 5000, 5001, 5002, 5003]);
const REJECT_TEXT = /user (rejected|denied|declined|cancell?ed|closed)|rejected by (the )?user|request reset|user aborted|cancelled by user/i;

/** Walk an error and its causes (bounded: some wallets build cyclic chains). */
function* chain(e: unknown): Generator<unknown> {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    yield cur;
    cur = (cur as {cause?: unknown}).cause;
  }
}

const codeOf = (x: unknown): number | undefined => {
  const c = (x as {code?: unknown} | null)?.code;
  return typeof c === "number" ? c : undefined;
};
const messageOf = (x: unknown): string => {
  if (typeof x === "string") return x;
  const m = (x as {message?: unknown} | null)?.message;
  return typeof m === "string" ? m : "";
};

/** The user declined in the wallet (connect, chain switch). */
export function isUserRejection(e: unknown): boolean {
  for (const x of chain(e)) {
    const code = codeOf(x);
    if (code !== undefined && REJECT_CODES.has(code)) return true;
    if ((x as {name?: unknown} | null)?.name === "UserRejectedRequestError") return true;
    if (REJECT_TEXT.test(messageOf(x))) return true;
  }
  return false;
}

/** EIP-1193 -32002: the wallet already has a prompt open for this site. */
function isPending(e: unknown): boolean {
  for (const x of chain(e)) {
    if (codeOf(x) === -32002) return true;
    if (/already pending|already processing|request already/i.test(messageOf(x))) return true;
  }
  return false;
}

function isMissing(e: unknown): boolean {
  for (const x of chain(e)) {
    if ((x as {name?: unknown} | null)?.name === "ProviderNotFoundError") return true;
  }
  return false;
}

/** What the connect menu shows when `connect` fails. */
export function connectErrorText(e: unknown, walletName: string): string {
  if (isAnswered(e)) return e.message;
  if (isUserRejection(e)) return "You declined in your wallet.";
  if (isPending(e)) return `${walletName} already has a request open — finish it in the wallet first.`;
  if (isMissing(e)) return `${walletName} isn't available in this browser.`;
  return `Couldn't connect ${walletName}. Try again.`;
}
