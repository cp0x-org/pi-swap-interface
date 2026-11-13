#!/usr/bin/env node
/**
 * Writes public/runtime-config.example.json from the built-in defaults (src/config/defaults.ts), so the example
 * always lists every key with its real default. `--check` exits 1 when the committed file is out of date (CI).
 * It loads the TypeScript through Vite's module runner, so no extra dependency is needed.
 *
 *   node .github/scripts/runtime-config-example.mjs          # rewrite
 *   node .github/scripts/runtime-config-example.mjs --check  # verify
 */
import {readFile, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {runnerImport} from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = new URL("../../public/runtime-config.example.json", import.meta.url);

/** JSON with 2-space indent, but a short array of strings stays on one line, so the example is easy to read. */
function pretty(value, indent = "") {
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    const flat = JSON.stringify(value);
    if (value.every((v) => typeof v !== "object" || v === null) && flat.length + indent.length <= 110) return flat.replaceAll('","', '", "');
    return `[\n${value.map((v) => next + pretty(v, next)).join(",\n")}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${pretty(v, next)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

const {module} = await runnerImport(fileURLToPath(new URL("../../src/config/defaults.ts", import.meta.url)), {
  root,
  configFile: false,
  logLevel: "silent",
});
const text = `${pretty(module.DEFAULT_RUNTIME_CONFIG)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== text) {
    console.error("public/runtime-config.example.json is out of date: run node .github/scripts/runtime-config-example.mjs");
    process.exit(1);
  }
  console.log("public/runtime-config.example.json matches the built-in defaults.");
} else {
  await writeFile(target, text);
  console.log(`wrote ${fileURLToPath(target)}`);
}
