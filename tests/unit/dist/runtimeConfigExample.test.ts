import {describe, expect, it} from "vitest";
import {DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig} from "../../../src/config";
import example from "../../../public/runtime-config.example.json";

describe("public/runtime-config.example.json", () => {
  it("parses with no warnings", () => {
    expect(parseRuntimeConfig(example).warnings).toEqual([]);
  });

  it("lists every key with its built-in default (regenerate: node .github/scripts/runtime-config-example.mjs)", () => {
    expect(parseRuntimeConfig(example).config).toEqual(DEFAULT_RUNTIME_CONFIG);
    // Same keys at every level, so no field is undocumented.
    expect(Object.keys(example).sort()).toEqual(Object.keys(DEFAULT_RUNTIME_CONFIG).sort());
    expect(Object.keys(example.api).sort()).toEqual(Object.keys(DEFAULT_RUNTIME_CONFIG.api).sort());
    expect(Object.keys(example.providers).sort()).toEqual(Object.keys(DEFAULT_RUNTIME_CONFIG.providers).sort());
  });

  it("holds no secrets: only public https/wss endpoints and an empty WalletConnect id", () => {
    const urls = JSON.stringify(example).match(/"[a-z]+:\/\/[^"]+"/g) ?? [];
    expect(urls.length).toBeGreaterThan(30);
    for (const u of urls) {
      expect(u).toMatch(/^"(https|wss):\/\//);
      expect(u).not.toMatch(/[?&](key|apikey|api_key|token)=|\/v2\/[0-9a-f]{32}/i);
    }
    expect(example.walletConnect.projectId).toBe("");
  });
});
