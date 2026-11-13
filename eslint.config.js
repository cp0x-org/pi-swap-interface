import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * The signing choke point (ARCHITECTURE.md D10): only src/execute/accounts/** may ask a wallet to sign or send.
 * Everything else reaches a wallet through the gated engine account, so an unarmed write cannot be prompted.
 */
const WALLET_WRITES =
  "sendTransaction|sendRawTransaction|writeContract|signTypedData|signMessage|signTransaction|signAllTransactions|signAndSendTransaction|signAndSendAllTransactions|signAndSendTransactions|signDelegateActions|sendCalls|signData";
const WRITE_MESSAGE = "Wallet writes live only in src/execute/accounts/** behind the swap gate (ARCHITECTURE.md D10).";
/** The same writes by their wire names: an EIP-1193 `request({method})` or a Wallet Standard feature key reaches them without a method call. */
const RPC_WRITES =
  "eth_sendTransaction|eth_sendRawTransaction|eth_signTransaction|eth_sign|personal_sign|eth_signTypedData(_v[134])?|wallet_sendCalls|solana:signAndSendTransaction|solana:signAndSendAllTransactions|solana:signTransaction|solana:signMessage|solana:signIn|tron_signTransaction|tron_signMessage";
/** The one request an injected Tron wallet may get outside the accounts: the connect prompt (src/wallets/tron). */
const TRON_CONNECT = "eth_requestAccounts|tron_requestAccounts";
/** Objects a wallet write could be reached through by a computed key (`wallet[name](…)`). */
const WALLETISH = "(wallet|provider|signer|account|feature|client|connector)s?$";

/**
 * Every way into a wallet write the choke point knows: direct calls, call/apply/bind, Reflect, computed keys, wire
 * names, TronWeb's `trx` (sign, multiSign, sendRawTransaction), read or destructured. `connectRequests`: a request() whose only argument is
 * `{method: "<one of these>"}` as literals is let through (the Tron connect prompt); every other request() is not.
 */
const writeSelectors = ({allowRequest = false, connectRequests = ""} = {}) => [
  {selector: `CallExpression[callee.property.name=/^(${WALLET_WRITES})$/]`, message: WRITE_MESSAGE},
  {selector: `CallExpression[callee.name=/^(${WALLET_WRITES})$/]`, message: WRITE_MESSAGE},
  {selector: `CallExpression[callee.property.name=/^(call|apply|bind)$/][callee.object.property.name=/^(${WALLET_WRITES})$/]`, message: WRITE_MESSAGE},
  {selector: `MemberExpression[computed=true][property.value=/^(${WALLET_WRITES})$/]`, message: WRITE_MESSAGE},
  {selector: `CallExpression[callee.computed=true][callee.object.name=/${WALLETISH}/i]`, message: `${WRITE_MESSAGE} (computed method on a wallet object)`},
  // Any other computed call with a run-time key (`w[name]()`), except on CONSTANT lookup tables (ICONS[name]()).
  {
    selector: `CallExpression[callee.computed=true][callee.property.type!="Literal"]:not([callee.object.name=/^[A-Z][A-Z0-9_]*$/]):not([callee.object.name=/${WALLETISH}/i])`,
    message: `${WRITE_MESSAGE} (a computed call can reach a write by name; use a CONSTANT table or a plain call)`,
  },
  {selector: `CallExpression[callee.object.name="Reflect"]`, message: `${WRITE_MESSAGE} (Reflect can call a write by name)`},
  {selector: `MemberExpression[property.name="trx"]`, message: `${WRITE_MESSAGE} (TronWeb's trx signs and broadcasts)`},
  {selector: `MemberExpression[computed=true][property.value="trx"]`, message: `${WRITE_MESSAGE} (TronWeb's trx signs and broadcasts)`},
  // Destructured (`const {trx} = tronWeb`, `{trx: {sign}}`, `{["trx"]: t}`): no member access is left to catch.
  {selector: `ObjectPattern > Property[key.name="trx"]`, message: `${WRITE_MESSAGE} (TronWeb's trx signs and broadcasts)`},
  {selector: `ObjectPattern > Property[key.value="trx"]`, message: `${WRITE_MESSAGE} (TronWeb's trx signs and broadcasts)`},
  {selector: `Literal[value=/^(${RPC_WRITES})$/]`, message: `${WRITE_MESSAGE} (a signing RPC method or feature name)`},
  {selector: `TemplateElement[value.raw=/^(${RPC_WRITES})$/]`, message: `${WRITE_MESSAGE} (a signing RPC method or feature name)`},
  // The raw EIP-1193 provider: only src/wallets/evm (connection bookkeeping) may hold it; nothing may send it requests.
  ...(allowRequest ? [] : [{selector: `CallExpression[callee.property.name="getProvider"][arguments.length=0]`, message: `${WRITE_MESSAGE} (the raw EIP-1193 provider)`}]),
  {
    selector: `CallExpression[callee.property.name="request"]:not([callee.object.name="locks"])${
      connectRequests
        ? `:not([arguments.length=1][arguments.0.type="ObjectExpression"][arguments.0.properties.length=1][arguments.0.properties.0.key.name="method"][arguments.0.properties.0.value.value=/^(${connectRequests})$/])`
        : ""
    }`,
    message: `${WRITE_MESSAGE} (EIP-1193 request)`,
  },
];

export default tseslint.config(
  {ignores: ["dist", "dist-*", "node_modules", "playwright-report", "test-results"]},
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {ecmaVersion: 2023, globals: {...globals.browser}},
    plugins: {"react-hooks": reactHooks},
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", {argsIgnorePattern: "^_", varsIgnorePattern: "^_"}],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/execute/accounts/**"],
    rules: {
      "no-restricted-syntax": ["error", ...writeSelectors()],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {name: "wagmi", importNames: ["useSendTransaction", "useWriteContract", "useSignTypedData", "useSignMessage", "useSendCalls"], message: WRITE_MESSAGE},
            {name: "wagmi/actions", importNames: ["sendTransaction", "writeContract", "signTypedData", "signMessage", "sendCalls"], message: WRITE_MESSAGE},
            {name: "@wagmi/core", importNames: ["sendTransaction", "writeContract", "signTypedData", "signMessage", "sendCalls"], message: WRITE_MESSAGE},
          ],
        },
      ],
    },
  },
  {
    // wagmi's connector bookkeeping reads the provider (WalletConnect session metadata); every other rule stays.
    files: ["src/wallets/evm/**/*.{ts,tsx}"],
    rules: {"no-restricted-syntax": ["error", ...writeSelectors({allowRequest: true})]},
  },
  {
    // TronLink's connect prompt (eth_requestAccounts, legacy tron_requestAccounts) and nothing else; every other rule stays.
    files: ["src/wallets/tron/**/*.{ts,tsx}"],
    rules: {"no-restricted-syntax": ["error", ...writeSelectors({connectRequests: TRON_CONNECT})]},
  },
);
