# Security

cp0x Swap moves people's money, so a report that keeps funds safe is the most useful thing you can send us.

## Reporting a vulnerability

Report privately through GitHub: this repository's **Security** tab → **Report a vulnerability**. Don't open a public
issue or pull request for anything that could put funds or a viewer's keys at risk.

Please include what you found, where (file and line, or the page and steps), how to reproduce it, and what an attacker
gains. A proof of concept against a test wallet helps; never use someone else's funds.

## What the design promises

Reports that break one of these are the ones we care about most:

- **The page never signs.** The viewer's wallet signs, and only after the in-page gate has checked the exact
  transaction against the route the viewer reviewed: target, spender, amount, recipient and minimum
  (`src/execute`, ARCHITECTURE D10). A transaction that reaches the wallet without matching what was reviewed is a
  critical bug.
- **No server is trusted with a quote.** Every venue answer is checked in the browser by the Any Wallet Kit modules. In
  Standard mode cp0x's swap-web proxy only carries requests and adds cp0x's API keys (D30); a proxy answer that gets
  past those checks is in scope.
- **Custom mode keys stay in this browser.** They are kept in `localStorage` and each one goes only to its own venue.
  Anything that sends one to another origin is in scope.
- **Copies built without `VITE_CP0X_API`** (IPFS, Docker, `npx`, self-hosted) never contact cp0x and hold no analytics.
  `.github/scripts/guard-dist.mjs` checks every build; a way around it is in scope.
- **Strict CSP** (`bin/headers.mjs`): only the bundle's own scripts run. A script injection is in scope.

## Where else to report

- A bug in the swap modules themselves (`@anywalletkit/*`): the
  [Any Wallet Kit repository](https://github.com/ultratestbro/anywalletkit).
- A venue's contracts or API (LI.FI, Relay, THORChain, NEAR Intents and the others): that venue's own program.
- A phishing copy of this site: report its URL here anyway, so we can warn people.

## Supported versions

The interface at [swap.cp0x.com](https://swap.cp0x.com) and the latest tagged release (IPFS, Docker, npm). Older
releases get no fixes; use the newest.
