// CCTP takes one RPC per chain; rpcFailoverFetch (its fetchImpl) moves a failed call to the rest of that chain's
// runtime list, like every other RPC client here, and leaves Circle's API calls alone.
import {describe, expect, it, vi} from "vitest";
import {rpcFailoverFetch} from "../../../src/swap/rpcFailover";

const LISTS = {"https://a.example": ["https://a.example", "https://b.example", "https://c.example"]};
const BODY = {method: "POST", headers: {"content-type": "application/json"}, body: '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[]}'};

function recorder(respond: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    expect(init).toBe(BODY);
    return respond(String(input));
  });
  return {f: rpcFailoverFetch(LISTS, base as unknown as typeof fetch), urls};
}

describe("rpcFailoverFetch", () => {
  it("one call when the first URL answers", async () => {
    const r = recorder(() => new Response("{}", {status: 200}));
    expect((await r.f("https://a.example", BODY)).status).toBe(200);
    expect(r.urls).toEqual(["https://a.example"]);
  });

  it("moves to the next URL on a non-2xx answer and on a network error, the same request each time", async () => {
    const r = recorder((u) => {
      if (u === "https://a.example") return new Response('{"error":"daily budget spent"}', {status: 429});
      if (u === "https://b.example") throw new TypeError("Failed to fetch");
      return new Response('{"result":"0x1"}', {status: 200});
    });
    expect(await (await r.f("https://a.example", BODY)).text()).toBe('{"result":"0x1"}');
    expect(r.urls).toEqual(["https://a.example", "https://b.example", "https://c.example"]);
  });

  it("returns the last answer when every URL fails (or throws the last error)", async () => {
    const r = recorder((u) => new Response(u, {status: 503}));
    expect(await (await r.f("https://a.example", BODY)).text()).toBe("https://c.example");
    const t = recorder(() => {
      throw new TypeError("offline");
    });
    await expect(t.f("https://a.example", BODY)).rejects.toThrow("offline");
  });

  it("leaves every other request alone (Circle's attestation API)", async () => {
    const base = vi.fn(async () => new Response("{}", {status: 404}));
    const f = rpcFailoverFetch(LISTS, base as unknown as typeof fetch);
    const init = {headers: {accept: "application/json"}};
    await f("https://iris-api.circle.com/v2/messages/0?transactionHash=0x1", init);
    expect(base.mock.calls).toEqual([["https://iris-api.circle.com/v2/messages/0?transactionHash=0x1", init]]);
  });

  it("stops when the caller aborted", async () => {
    const ac = new AbortController();
    const base = vi.fn(async () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const f = rpcFailoverFetch(LISTS, base as unknown as typeof fetch);
    await expect(f("https://a.example", {...BODY, signal: ac.signal})).rejects.toThrow("aborted");
    expect(base).toHaveBeenCalledTimes(1);
  });
});
