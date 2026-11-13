# Contributing

Thank you for your interest in contributing to cp0x Swap, the Permissionless Swap Interface by cp0x!

# Development

You need Node.js 22 or newer and pnpm 10 (the exact version is in `package.json` → `packageManager`; `corepack
enable` picks it up). Install the locked dependencies:

```sh
pnpm install --frozen-lockfile
```

## Running the interface locally

```sh
pnpm dev
```

Then open <http://127.0.0.1:5173/>. To see every screen without a wallet or network, use demo mode:
<http://127.0.0.1:5173/#/?demo=1> (add `&demoWallets=none|evm|solana|both` to pick the fake connections).

Use `127.0.0.1` or `localhost`. A LAN address such as `http://192.168.x.x:5173` is not a secure context, and NEAR
Intents, Chainflip and Jupiter quotes fail there with "crypto.randomUUID is not a function".

## Creating a production build

```sh
pnpm build
node bin/cli.mjs --no-browser   # serves dist/ on http://127.0.0.1:4370 with the production headers and CSP
```

`pnpm preview` also serves `dist/`, but without the security headers. Use `bin/cli.mjs` to check that nothing is
blocked by the Content-Security-Policy.

## Checks

CI runs all of these on every pull request. Run them before you push:

```sh
bash .github/scripts/guard-wallet-writes.sh        # wallet writes only in src/execute/accounts/
pnpm lint
pnpm exec tsc -p tsconfig.app.json --noEmit
pnpm exec vitest run                               # or: pnpm exec vitest run tests/unit/<module>
node .github/scripts/runtime-config-example.mjs --check
pnpm build && node .github/scripts/guard-dist.mjs dist             # no cp0x host in a plain build
VITE_CP0X_API=https://cp0x-api.vercel.app pnpm exec vite build --outDir dist-standard \
  && node .github/scripts/guard-dist.mjs dist-standard --api https://cp0x-api.vercel.app   # that origin, once, as a bare literal
pnpm test:e2e      # Playwright at 375, 768 and 1280 px (demo, real, IPFS), plus the Standard build on E2E_PORT + 1
```

Unit tests live in `tests/unit/<module>/` and never touch the network. A live check against a real API must be
opt-in (`LIVE=1`) and sparing: Symbiosis allows about 1 request per second, and Jupiter 0.5.

## Where things live

The module map, file ownership and every design decision are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Where it disagrees with the specs in `docs/specs/`, it wins. In short:

- `src/contracts/`: shared types and the export list each module must provide. `conformance.ts` fails the
  typecheck when a module drifts from it.
- `src/config/`: runtime config, demo flag, hash routing, ports. `src/mocks/`: the demo ports.
- `src/catalog/`, `src/wallets/`, `src/swap/`, `src/execute/`, `src/activity/`: the effectful modules.
  Screens reach them only through `usePorts()`.
- `src/ui/`, `src/theme/`, `src/screens/`: the interface (CSS Modules over `src/theme/tokens.css`).
- `bin/`: the zero-dependency `npx` server and the one copy of the HTTP headers (`bin/headers.mjs`).
- `docker/`, `Dockerfile`, `vercel.json`, `.github/`: distribution.

If you change `src/config/defaults.ts`, regenerate the example config:

```sh
node .github/scripts/runtime-config-example.mjs
```

If you change a header or the CSP, change `bin/headers.mjs` first, then copy the values into `vercel.json` and
`docker/security-headers.conf`. `tests/unit/dist/headers.test.ts` fails until all three agree.

If you add or update a dependency, update the dependency list in `THIRD_PARTY_NOTICES.md`
(`pnpm licenses list --prod`).

## Guidelines

The following points should help guide your development:

- Security: the interface is safe to use
  - Only `src/execute/accounts/` may ask a wallet to sign or send, behind the swap gate. Never add a second path to
    the wallet.
  - Avoid adding unnecessary dependencies due to
    [supply chain risk](https://github.com/LavaMoat/lavamoat#further-reading-on-software-supplychain-security).
    Pin every dependency exactly.
  - No inline scripts, no third-party scripts, no `eval`. The CSP blocks them, and the build must not need them.
- Privacy: the interface tells no one more than the swap needs
  - No analytics, trackers, error reporters, remote fonts or hotlinked images. Bundle assets in `public/`.
  - No request to a cp0x server at runtime, except the hosted build's Standard mode (ARCHITECTURE D30), which only
    carries quote requests and RPC calls through cp0x's proxy. Public and Custom mode, and every build without
    `VITE_CP0X_API`, talk only to venues, RPCs, price APIs and (when the user picks it) WalletConnect.
  - Never put a secret in the code, the build or `runtime-config.json`. Everything shipped to a browser is public.
- Permissionlessness: anyone can use the interface
  - No geo-blocking, address screening or allowlists of users. Never set a provider fee.
- Reproducibility: anyone can build the interface
  - Avoid adding steps to the development or build processes.
  - The build must be deterministic: a given commit always produces the same `dist/` and the same IPFS CID.
- Decentralization: anyone can run the interface
  - The same `dist/` must work at `/`, under a sub-path and from an IPFS CID (relative URLs and hash routing only).

Code style follows the cp0x wallet: strict TypeScript, named exports, small modules, and a short doc comment on
each export that says why it exists. User-facing text is plain English in full sentences.
