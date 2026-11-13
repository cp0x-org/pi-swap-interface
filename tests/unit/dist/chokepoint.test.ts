// @vitest-environment node
// The signing choke point (D10) is enforced twice — ESLint and the CI grep — and both must see every way into a
// wallet write, not only a direct `x.sendTransaction(…)`.
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ESLint} from "eslint";
import {describe, expect, it} from "vitest";

const BYPASSES: Record<string, string> = {
  "EIP-1193 request": `await provider.request({method: "eth_sendTransaction", params: []});`,
  "typed data by template": "await provider.request({method: `eth_signTypedData_v4`});",
  "personal_sign literal": `const m = "personal_sign"; void m;`,
  "Wallet Standard feature key": `void wallet.features["solana:signAndSendTransaction"];`,
  ".call on a write": `wallet.sendTransaction.call(wallet, {});`,
  "Reflect.apply": `Reflect.apply(wallet.signTypedData, wallet, [{}]);`,
  "computed write name": `wallet["sendTransaction"]({});`,
  "computed run-time key": `w[name]();`,
  "TronWeb's trx.sign": `await tronWeb.trx.sign({});`,
  "TronWeb's trx by key": `await tronWeb["trx"].sign({});`,
  "TronWeb's trx destructured": `const {trx} = tronWeb; await trx.sign({});`,
  "TronWeb's trx.sign destructured": `const {trx: {sign}} = tronWeb; await sign({});`,
  "WalletConnect Tron method": `const m = "tron_signTransaction"; void m;`,
  "NEAR batch send": `await wallet.signAndSendTransactions({});`,
};
const HEADER = `declare const provider: {request(a: unknown): Promise<unknown>};
declare const wallet: {sendTransaction(a: unknown): void; signTypedData(a: unknown): void; features: Record<string, unknown>};
declare const w: Record<string, () => void>;
declare const tronWeb: {trx: {sign(a: unknown): Promise<unknown>}};
declare const name: string;
export async function probe() {
`;
const file = (line: string) => `${HEADER}  ${line}\n}\n`;

describe("signing choke point (D10)", () => {
  const eslint = new ESLint({cwd: process.cwd()});

  for (const [what, line] of Object.entries(BYPASSES)) {
    it(`ESLint refuses ${what} outside src/execute/accounts`, async () => {
      const [res] = await eslint.lintText(file(line), {filePath: "src/screens/probe.ts"});
      expect(res!.messages.filter((m) => m.ruleId === "no-restricted-syntax").length, line).toBeGreaterThan(0);
    });
  }

  it("ESLint leaves the same code alone inside src/execute/accounts, and allows CONSTANT tables", async () => {
    const [inside] = await eslint.lintText(file(BYPASSES["EIP-1193 request"]!), {filePath: "src/execute/accounts/probe.ts"});
    expect(inside!.messages.filter((m) => m.ruleId === "no-restricted-syntax")).toEqual([]);
    const [table] = await eslint.lintText(`declare const ICONS: Record<string, () => void>; declare const k: string; ICONS[k]();\n`, {filePath: "src/ui/probe.ts"});
    expect(table!.messages.filter((m) => m.ruleId === "no-restricted-syntax")).toEqual([]);
  }, 20_000);

  it("src/wallets/tron may send TronLink its connect prompt and nothing else", async () => {
    const lint = async (line: string) => {
      const [res] = await eslint.lintText(file(line), {filePath: "src/wallets/tron/probe.ts"});
      return res!.messages.filter((m) => m.ruleId === "no-restricted-syntax").length;
    };
    expect(await lint(`await provider.request({method: "eth_requestAccounts"});`)).toBe(0);
    expect(await lint(`await provider.request({method: "tron_requestAccounts"});`)).toBe(0);
    for (const line of [
      `await provider.request({method: name});`,
      `await provider.request({method: "eth_requestAccounts", params: [name]});`,
      `await provider.request({method: "wallet_switchEthereumChain"});`,
      BYPASSES["TronWeb's trx.sign"]!,
    ])
      expect(await lint(line), line).toBeGreaterThan(0);
  }, 20_000);

  it("the CI grep catches the calls and wire names (a disable comment can't silence it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    try {
      mkdirSync(join(dir, "screens"));
      writeFileSync(join(dir, "screens", "probe.ts"), Object.values(BYPASSES).map(file).join("\n"));
      let out = "";
      let code = 0;
      try {
        out = execFileSync("bash", [".github/scripts/guard-wallet-writes.sh", dir], {encoding: "utf8"});
      } catch (e) {
        const err = e as {status: number; stdout: string};
        code = err.status;
        out = err.stdout;
      }
      expect(code).toBe(1);
      for (const needle of [
        "eth_sendTransaction",
        "eth_signTypedData_v4",
        "personal_sign",
        "solana:signAndSendTransaction",
        ".call(",
        "Reflect.apply",
        `["sendTransaction"]`,
        "tronWeb.trx.sign",
        `tronWeb["trx"]`,
        "{trx} = tronWeb",
        "{trx: {sign}} = tronWeb",
        "tron_signTransaction",
        ".signAndSendTransactions(",
      ])
        expect(out, needle).toContain(needle);
      // The real tree is clean.
      expect(execFileSync("bash", [".github/scripts/guard-wallet-writes.sh"], {encoding: "utf8"})).toContain("OK");
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
