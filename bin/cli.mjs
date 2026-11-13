#!/usr/bin/env node
/**
 * `npx` entry point: serves the dist/ bundled in this package on this machine and opens the browser. It has no
 * dependencies, never contacts GitHub or a cp0x server, and downloads nothing at runtime.
 */
import {execFile} from "node:child_process";
import {readFileSync, realpathSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";
import {isLoopbackHost, loadSite, startServer} from "./server.mjs";

const HELP = `cp0x Swap: a permissionless swap and bridge interface, served on this machine.

Usage: npx @cp0x/pi-swap-interface [options]

  --port <n>           Port to listen on (default 4370). Keep it the same between runs: your
                       swap history lives in browser storage for this exact origin. Don't
                       share the port with another local site (Vite's preview uses 4173).
  --host <address>     Address to bind (default 127.0.0.1). Anything that is not loopback
                       is served over plain http, which is not a secure context, so some
                       venues (NEAR Intents, Chainflip, Jupiter) will not quote.
  --config <file>      Serve this JSON file as runtime-config.json. It is re-read on each
                       page load, and keys you leave out keep the built-in defaults.
  --allowed-host <h>   Accept this Host name too, for example behind a reverse proxy.
                       Repeat it for more names; "*" accepts any.
  --dir <path>         Serve another build instead of the bundled dist/.
  --no-browser         Do not open the browser.
  -v, --version        Print the version.
  -h, --help           Print this help.
`;

/** Parsed command-line options, validated. */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const {values} = parseArgs({
    args: argv,
    strict: true,
    options: {
      // Not 4173: Vite's preview default, so another local project would share this origin's storage.
      port: {type: "string", default: "4370"},
      host: {type: "string", default: "127.0.0.1"},
      config: {type: "string"},
      "allowed-host": {type: "string", multiple: true, default: []},
      dir: {type: "string"},
      "no-browser": {type: "boolean", default: false},
      version: {type: "boolean", short: "v", default: false},
      help: {type: "boolean", short: "h", default: false},
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be an integer from 1 to 65535 (got ${values.port}).`);
  return {
    port,
    host: values.host,
    configFile: values.config ? resolve(values.config) : null,
    allowedHosts: values["allowed-host"],
    dir: values.dir ? resolve(values.dir) : fileURLToPath(new URL("../dist/", import.meta.url)),
    openBrowser: !values["no-browser"],
    version: values.version,
    help: values.help,
  };
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Open a URL in the default browser without a shell: the URL is a single argv entry. */
function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  execFile(cmd, args, (err) => {
    if (err) console.log(`Open ${url} in your browser.`);
  });
}

export async function main(argv) {
  const opts = parseCliArgs(argv);
  if (opts.help) return void process.stdout.write(HELP);
  if (opts.version) return void console.log(packageVersion());

  const files = await loadSite(opts.dir);
  let started;
  try {
    started = await startServer({files, port: opts.port, host: opts.host, configFile: opts.configFile, allowedHosts: opts.allowedHosts});
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "EADDRINUSE")
      throw new Error(`Port ${opts.port} is already in use. Choose another with --port. cp0x Swap never switches ports on its own, because your swap history is stored per origin.`);
    throw e;
  }
  const {server, url} = started;
  console.log(`cp0x Swap ${packageVersion()}: ${url}`);
  if (opts.configFile) console.log(`runtime-config.json comes from ${opts.configFile}`);
  if (!isLoopbackHost(opts.host))
    console.log(`Warning: bound to ${opts.host}. Other devices reach it over plain http, which is not a secure context: put HTTPS in front of it.`);
  console.log("Press Ctrl+C to stop.");
  if (opts.openBrowser) openInBrowser(url);

  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const isEntry = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
