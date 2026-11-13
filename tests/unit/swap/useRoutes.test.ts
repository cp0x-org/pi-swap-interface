import {act, renderHook} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createTokenBucket} from "../../../src/config";
import type {PreviewRequest, QuoteRequest, RouteSnapshot, RoutesRequest, WebRoute} from "../../../src/contracts/routes";
import {DEBOUNCE_MS, PREVIEW_DEBOUNCE_MS, PREVIEW_STALE_MS, REFRESH_MS, createUseRoutes, type QuoteRoutesFn} from "../../../src/swap/useRoutes";
import {USDC_ARB, USDC_BASE, request} from "./fixtures";

const live = (over: Partial<QuoteRequest> = {}): RoutesRequest => ({mode: "live", req: request(over)});
const preview = (over: Partial<PreviewRequest> = {}): RoutesRequest => ({
  mode: "preview",
  req: {preview: true, from: {...USDC_ARB, owner: null, payMode: "connect"}, to: {...USDC_BASE, owner: null}, amountIn: 5_000_000n, slippageBps: 30, toOther: false, ...over},
});

/** One controllable quote round. */
interface Round {
  mode: RoutesRequest["mode"];
  req: QuoteRequest | PreviewRequest;
  signal: AbortSignal;
  update(s: RouteSnapshot): void;
  finish(s: RouteSnapshot | null): void;
  fail(e: Error): void;
}

function fakeQuote() {
  const rounds: Round[] = [];
  const fn: QuoteRoutesFn = (r, onUpdate, _prices, signal) =>
    new Promise((resolve, reject) => {
      rounds.push({mode: r.mode, req: r.req, signal: signal!, update: onUpdate, finish: resolve, fail: reject});
    });
  return {rounds, fn};
}

const route = (provider: string): WebRoute => ({
  provider,
  sourceAmount: 5_000_000n,
  destAmount: 4_999_000n,
  minDestAmount: 4_999_000n,
  etaSeconds: 30,
  feeUsd: 0,
  fees: [],
  tags: [],
  relativeValue: 1,
  netValueUsd: null,
  approvalSpender: null,
  nativeFee: 0n,
  validUntilMs: 0,
  gasUsd: null,
  execution: "calldata",
  hasMemo: false,
  trust: "provider-api",
});
const snap = (routes: string[], pending: string[] = [], mode: RouteSnapshot["mode"] = "live"): RouteSnapshot => ({
  mode,
  routes: routes.map(route),
  pending,
  rejections: [],
  asked: [...routes, ...pending],
  venues: [...routes, ...pending],
});

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("useRoutes", () => {
  it("is idle without a request and never quotes", async () => {
    const q = fakeQuote();
    const {result} = renderHook(() => createUseRoutes(q.fn)(null, {}));
    await advance(REFRESH_MS * 2);
    expect(q.rounds).toHaveLength(0);
    expect(result.current).toMatchObject({snapshot: null, loading: false, error: null, updatedAt: 0, limitedUntil: 0});
  });

  it("waits 400 ms after the request settles, showing loading meanwhile", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn);
    const {result} = renderHook(() => useRoutes(live(), {}));
    expect(result.current.loading).toBe(true);
    await advance(DEBOUNCE_MS - 1);
    expect(q.rounds).toHaveLength(0);
    await advance(1);
    expect(q.rounds).toHaveLength(1);
    await act(async () => q.rounds[0]!.update(snap([], ["cctp", "relay"])));
    expect(result.current.snapshot?.pending).toEqual(["cctp", "relay"]);
    await act(async () => q.rounds[0]!.update(snap(["cctp"], ["relay"])));
    expect(result.current.snapshot?.routes.map((r) => r.provider)).toEqual(["cctp"]);
    expect(result.current.loading).toBe(true);
    await act(async () => q.rounds[0]!.finish(snap(["cctp", "relay"])));
    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot?.routes).toHaveLength(2);
    expect(result.current.updatedAt).toBeGreaterThan(0);
  });

  it("typing quickly quotes only the last amount", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn);
    const {rerender} = renderHook(({amount}) => useRoutes(live({amountIn: amount}), {}), {initialProps: {amount: 1n}});
    await advance(200);
    rerender({amount: 12n});
    await advance(200);
    rerender({amount: 123n});
    await advance(DEBOUNCE_MS);
    expect(q.rounds.map((r) => r.req.amountIn)).toEqual([123n]);
  });

  it("a new request aborts the old round and drops its late answers", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn);
    const {result, rerender} = renderHook(({amount}) => useRoutes(live({amountIn: amount}), {}), {initialProps: {amount: 1n}});
    await advance(DEBOUNCE_MS);
    const old = q.rounds[0]!;
    rerender({amount: 2n});
    expect(old.signal.aborted).toBe(true);
    await act(async () => {
      old.update(snap(["stale"]));
      old.finish(snap(["stale"]));
    });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(true);
    await advance(DEBOUNCE_MS);
    await act(async () => q.rounds[1]!.finish(snap(["fresh"])));
    expect(result.current.snapshot?.routes.map((r) => r.provider)).toEqual(["fresh"]);
  });

  it("the address is part of the key: a new recipient re-quotes", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn);
    const {rerender} = renderHook(({to}) => useRoutes(live({recipient: to}), {}), {initialProps: {to: "0x1111111111111111111111111111111111111111"}});
    await advance(DEBOUNCE_MS);
    rerender({to: "0x2222222222222222222222222222222222222222"});
    await advance(DEBOUNCE_MS);
    expect(q.rounds.map((r) => r.req.recipient)).toEqual(["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"]);
  });

  it("a refresh keeps the old list until the first new price lands", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn);
    const {result} = renderHook(() => useRoutes(live(), {}));
    await advance(DEBOUNCE_MS);
    await act(async () => q.rounds[0]!.finish(snap(["cctp", "relay"])));
    act(() => result.current.refresh());
    expect(result.current.loading).toBe(true);
    expect(result.current.snapshot?.routes).toHaveLength(2);
    await advance(0);
    expect(q.rounds).toHaveLength(2);
    await act(async () => q.rounds[1]!.update(snap([], ["cctp", "relay"])));
    expect(result.current.snapshot?.routes.map((r) => r.provider)).toEqual(["cctp", "relay"]);
    expect(result.current.snapshot?.pending).toEqual(["cctp", "relay"]);
    await act(async () => q.rounds[1]!.update(snap(["relay"], ["cctp"])));
    expect(result.current.snapshot?.routes.map((r) => r.provider)).toEqual(["relay"]);
  });

  it("refreshes every 30 s while visible, not while hidden; a long-hidden tab refreshes on return", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn);
    renderHook(() => useRoutes(live(), {}));
    await advance(DEBOUNCE_MS);
    await act(async () => q.rounds[0]!.finish(snap(["cctp"])));
    await advance(REFRESH_MS);
    await advance(0);
    expect(q.rounds).toHaveLength(2);
    await act(async () => q.rounds[1]!.finish(snap(["cctp"])));
    visibility = "hidden";
    await advance(REFRESH_MS * 3);
    await advance(0);
    expect(q.rounds).toHaveLength(2);
    visibility = "visible";
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await advance(0);
    expect(q.rounds).toHaveLength(3);
  });

  it("a failed round keeps the list and says why", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn);
    const {result} = renderHook(() => useRoutes(live(), {}));
    await advance(DEBOUNCE_MS);
    await act(async () => q.rounds[0]!.finish(snap(["cctp"])));
    act(() => result.current.refresh());
    await advance(0);
    await act(async () => q.rounds[1]!.fail(new TypeError("Failed to fetch")));
    expect(result.current).toMatchObject({loading: false, error: "Couldn't reach it — tap refresh"});
    expect(result.current.snapshot?.routes.map((r) => r.provider)).toEqual(["cctp"]);
  });

  it("a round failure no rule knows says what failed (URLs out, cut short), never just 'No quote right now'", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn);
    const {result} = renderHook(() => useRoutes(live(), {}));
    await advance(DEBOUNCE_MS);
    await act(async () => q.rounds[0]!.fail(new Error("A recipient and a refund address are needed to quote.")));
    expect(result.current.error).toBe("A recipient and a refund address are needed to quote.");

    act(() => result.current.refresh());
    await advance(0);
    const long = `provider config at https://example.org/config.json?key=SECRET is invalid: ${"field ".repeat(40)}`;
    await act(async () => q.rounds[1]!.fail(new Error(long)));
    const error = result.current.error!;
    expect(error).toMatch(/^provider config at <url> is invalid: field/);
    expect(error).not.toContain("SECRET");
    expect(error.length).toBe(120);
    expect(error.endsWith("…")).toBe(true);
  });

  it("unmounting aborts the round in flight", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn);
    const {unmount} = renderHook(() => useRoutes(live(), {}));
    await advance(DEBOUNCE_MS);
    unmount();
    expect(q.rounds[0]!.signal.aborted).toBe(true);
  });
});

describe("useRoutes, preview rounds (D7, D29)", () => {
  const bucket = (burst = 5) => createTokenBucket(burst, 20_000);

  it("waits 800 ms, hands the engine the preview, and never refreshes on a timer", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn, {previewBucket: bucket()});
    const {result} = renderHook(() => useRoutes(preview(), {}));
    await advance(PREVIEW_DEBOUNCE_MS - 1);
    expect(q.rounds).toHaveLength(0);
    await advance(1);
    expect(q.rounds.map((r) => r.mode)).toEqual(["preview"]);
    await act(async () => q.rounds[0]!.finish(snap(["cctp"], [], "preview")));
    expect(result.current.snapshot?.mode).toBe("preview");
    await advance(REFRESH_MS * 4);
    expect(q.rounds).toHaveLength(1);
  });

  it("a tab back after more than 2 min re-asks once; sooner, not at all", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn, {previewBucket: bucket()});
    renderHook(() => useRoutes(preview(), {}));
    await advance(PREVIEW_DEBOUNCE_MS);
    await act(async () => q.rounds[0]!.finish(snap(["cctp"], [], "preview")));
    visibility = "hidden";
    await advance(REFRESH_MS * 2);
    visibility = "visible";
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await advance(0);
    expect(q.rounds).toHaveLength(1);
    await advance(PREVIEW_STALE_MS);
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await advance(0);
    expect(q.rounds).toHaveLength(2);
  });

  it("every round spends a token: past the burst, a new amount waits for the next token and says until when", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn, {previewBucket: bucket(2)});
    const {result, rerender} = renderHook(({amount}) => useRoutes(preview({amountIn: amount}), {}), {initialProps: {amount: 1n}});
    await advance(PREVIEW_DEBOUNCE_MS);
    await act(async () => q.rounds[0]!.finish(snap(["cctp"], [], "preview")));
    expect(result.current.limitedUntil).toBe(0);
    rerender({amount: 2n});
    await advance(PREVIEW_DEBOUNCE_MS);
    await act(async () => q.rounds[1]!.finish(snap(["cctp"], [], "preview")));
    // The bucket is empty now: the refresh button waits (limitedUntil in the future).
    expect(result.current.limitedUntil).toBeGreaterThan(Date.now());
    rerender({amount: 3n});
    await advance(PREVIEW_DEBOUNCE_MS);
    expect(q.rounds).toHaveLength(2);
    expect(result.current).toMatchObject({snapshot: null, loading: false});
    expect(result.current.limitedUntil).toBeGreaterThan(Date.now());
    await advance(20_000);
    expect(q.rounds.map((r) => r.req.amountIn)).toEqual([1n, 2n, 3n]);
  });

  it("a manual refresh costs a token; with none left it starts only when the next one is in", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn, {previewBucket: bucket(1)});
    const {result} = renderHook(() => useRoutes(preview(), {}));
    await advance(PREVIEW_DEBOUNCE_MS);
    await act(async () => q.rounds[0]!.finish(snap(["cctp"], [], "preview")));
    const until = result.current.limitedUntil;
    expect(until).toBeGreaterThan(Date.now());
    act(() => result.current.refresh());
    await advance(0);
    expect(q.rounds).toHaveLength(1);
    // The list stays while it waits.
    expect(result.current.snapshot?.routes.map((r) => r.provider)).toEqual(["cctp"]);
    await advance(until - Date.now());
    expect(q.rounds).toHaveLength(2);
  });

  it("the preview list clears the moment the request turns live, and a live round runs at the live pace", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn, {previewBucket: bucket()});
    const {result, rerender} = renderHook(({r}) => useRoutes(r, {}), {initialProps: {r: preview()}});
    await advance(PREVIEW_DEBOUNCE_MS);
    await act(async () => q.rounds[0]!.finish(snap(["cctp", "relay"], [], "preview")));
    expect(result.current.snapshot?.routes).toHaveLength(2);
    rerender({r: live()});
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(true);
    await advance(DEBOUNCE_MS);
    expect(q.rounds.map((r) => r.mode)).toEqual(["preview", "live"]);
    await act(async () => q.rounds[1]!.finish(snap(["cctp"])));
    expect(result.current.snapshot?.mode).toBe("live");
  });

  it("an amount typed and changed back within the wait shows its preview again: no second round, no token", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn, {previewBucket: bucket(2)});
    const {result, rerender} = renderHook(({amount}) => useRoutes(preview({amountIn: amount}), {}), {initialProps: {amount: 1n}});
    await advance(PREVIEW_DEBOUNCE_MS);
    await act(async () => q.rounds[0]!.finish(snap(["cctp"], [], "preview")));
    rerender({amount: 2n});
    await advance(PREVIEW_DEBOUNCE_MS / 4);
    rerender({amount: 1n});
    expect(result.current).toMatchObject({loading: false});
    expect(result.current.snapshot?.routes.map((r) => r.provider)).toEqual(["cctp"]);
    await advance(PREVIEW_DEBOUNCE_MS * 2);
    expect(q.rounds).toHaveLength(1);
    // A refresh still asks again, at once: the token the typo didn't spend is still there.
    act(() => result.current.refresh());
    await advance(0);
    expect(q.rounds).toHaveLength(2);
  });

  it("a round cut off mid-flight, or a refresh still waiting for a token, starts again when the amount comes back", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn, {previewBucket: bucket(2)});
    const {result, rerender} = renderHook(({amount}) => useRoutes(preview({amountIn: amount}), {}), {initialProps: {amount: 1n}});
    await advance(PREVIEW_DEBOUNCE_MS);
    rerender({amount: 2n});
    expect(q.rounds[0]!.signal.aborted).toBe(true);
    rerender({amount: 1n});
    await advance(0);
    expect(q.rounds.map((r) => r.req.amountIn)).toEqual([1n, 1n]);
    await act(async () => q.rounds[1]!.finish(snap(["cctp"], [], "preview")));
    // The bucket is empty: the refresh waits for the next token, and keeps waiting across a typo.
    act(() => result.current.refresh());
    await advance(0);
    expect(q.rounds).toHaveLength(2);
    rerender({amount: 2n});
    await advance(PREVIEW_DEBOUNCE_MS / 4);
    rerender({amount: 1n});
    await advance(20_000);
    expect(q.rounds.map((r) => r.req.amountIn)).toEqual([1n, 1n, 1n]);
  });

  it("live rounds never touch the preview budget", async () => {
    const q = fakeQuote();
    const empty = bucket(1);
    empty.take();
    const useRoutes = createUseRoutes(q.fn, {previewBucket: empty});
    const {result} = renderHook(() => useRoutes(live(), {}));
    await advance(DEBOUNCE_MS);
    expect(q.rounds).toHaveLength(1);
    expect(result.current.limitedUntil).toBe(0);
  });
});

describe("useRoutes, cleanup", () => {
  it("unmounting a preview aborts the round in flight", async () => {
    const q = fakeQuote();
    const useRoutes = createUseRoutes(q.fn, {previewBucket: createTokenBucket(5, 20_000)});
    const {unmount} = renderHook(() => useRoutes(preview(), {}));
    await advance(PREVIEW_DEBOUNCE_MS);
    unmount();
    expect(q.rounds[0]!.signal.aborted).toBe(true);
  });
});
