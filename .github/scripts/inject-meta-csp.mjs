#!/usr/bin/env node
/**
 * Adds the shared CSP as a <meta http-equiv> tag to a built index.html, for hosts that cannot send headers. IPFS
 * gateways are the main case. frame-ancestors is left out because browsers ignore it in <meta>. Running it twice
 * changes nothing, and it does nothing when the build already carries a meta CSP.
 *
 *   node .github/scripts/inject-meta-csp.mjs dist/index.html
 */
import {readFile, writeFile} from "node:fs/promises";
import {contentSecurityPolicy} from "../../bin/headers.mjs";

const file = process.argv[2] ?? "dist/index.html";
const html = await readFile(file, "utf8");
if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) {
  console.log(`${file}: already has a <meta> CSP`);
} else {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy({meta: true})}" />`;
  // Right after <meta charset>, so the policy is in force before any script or stylesheet tag is parsed.
  const out = html.replace(/(<meta charset=[^>]*>)/i, `$1\n    ${tag}`);
  if (out === html) throw new Error(`${file}: no <meta charset> to anchor the CSP after`);
  await writeFile(file, out);
  console.log(`${file}: added <meta> CSP`);
}
