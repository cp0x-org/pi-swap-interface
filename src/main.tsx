import "./polyfills";
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {loadRuntimeConfig} from "./config/runtime";
import {startConnection} from "./config/standard";

/**
 * Boot: load the runtime config first, then import the app, so every module
 * evaluates with the final config (providers and RPC lists are built from it
 * once per page — D9). In Standard mode (D30) the proxy-routing fetch goes in
 * before the app loads and the health check starts in the background: the
 * first render never waits for it. The hosted build alone counts page views
 * (D31); in every other build the branch, and the analytics chunk, are gone.
 */
async function boot(): Promise<void> {
  await loadRuntimeConfig();
  startConnection();
  if (import.meta.env.VITE_CP0X_API) void import("./config/analytics").then((m) => m.startAnalytics(), () => {});
  const {App} = await import("./App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
