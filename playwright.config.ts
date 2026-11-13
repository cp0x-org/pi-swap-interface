import {defineConfig, devices} from "@playwright/test";
import {E2E_CP0X_API} from "./tests/e2e/helpers";

/**
 * e2e against the production build (vite preview), at the three layout widths of version B.
 * Tests live in tests/e2e (integrator). Demo mode (`#/?demo=1`) gives deterministic, network-free screens.
 * `E2E_PORT` moves the server (default 4317). A server already on that port is reused only with `E2E_REUSE=1`,
 * so a stale preview left running can never be tested by mistake.
 *
 * A second build, made with VITE_CP0X_API pointing at a fake cp0x API (never resolved: tests/e2e/standard.spec.ts
 * answers every request to it), serves the hosted build's Standard mode (D30) on E2E_PORT + 1, for the "standard"
 * project only. The default build — the one every other spec runs against — has no cp0x host at all.
 */
const PORT = Number(process.env.E2E_PORT ?? 4317);
const BASE = `http://127.0.0.1:${PORT}`;
const STANDARD_PORT = PORT + 1;
const STANDARD_BASE = `http://127.0.0.1:${STANDARD_PORT}`;
const STANDARD_SPEC = /standard\.spec\.ts$/;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", {open: "never"}]] : "list",
  use: {baseURL: BASE, trace: "retain-on-failure", screenshot: "only-on-failure"},
  webServer: [
    {
      command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: BASE,
      reuseExistingServer: process.env.E2E_REUSE === "1",
      timeout: 180_000,
    },
    {
      command: `pnpm exec vite build --outDir dist-e2e-standard && pnpm exec vite preview --outDir dist-e2e-standard --host 127.0.0.1 --port ${STANDARD_PORT} --strictPort`,
      url: STANDARD_BASE,
      env: {VITE_CP0X_API: E2E_CP0X_API},
      reuseExistingServer: process.env.E2E_REUSE === "1",
      timeout: 180_000,
    },
  ],
  projects: [
    {name: "phone", testIgnore: STANDARD_SPEC, use: {...devices["Desktop Chrome"], viewport: {width: 375, height: 812}, isMobile: true, hasTouch: true}},
    {name: "tablet", testIgnore: STANDARD_SPEC, use: {...devices["Desktop Chrome"], viewport: {width: 768, height: 1024}, hasTouch: true}},
    {name: "desktop", testIgnore: STANDARD_SPEC, use: {...devices["Desktop Chrome"], viewport: {width: 1280, height: 800}}},
    // One width: the connection is the same at every width, and the layouts are covered above.
    {name: "standard", testMatch: STANDARD_SPEC, use: {...devices["Desktop Chrome"], viewport: {width: 1280, height: 800}, baseURL: STANDARD_BASE}},
  ],
});
