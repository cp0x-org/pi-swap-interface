import {describe, expect, it} from "vitest";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config/defaults";
import {buildOmniston} from "../../../src/swap/omniston";
import {evmRpcByCaip2} from "../../../src/swap/providers";
import {createProviderStores} from "../../../src/swap/stores";

describe("the Omniston chunk", () => {
  it("constructs the real provider, enabled (audited settlement contracts set), without opening its WebSocket", () => {
    const p = buildOmniston(DEFAULT_RUNTIME_CONFIG, createProviderStores(), evmRpcByCaip2(DEFAULT_RUNTIME_CONFIG.evmRpc));
    expect(p.name).toBe("omniston");
    expect(p.enabled()).toBe(true);
    expect(typeof p.registerSignedOrder).toBe("function");
    expect(globalThis.Buffer).toBeDefined();
  });
});
