import {describe, expect, it} from "vitest";
import {
  CSP_DIRECTIVES,
  IMMUTABLE_CACHE,
  LOCAL_CONNECT_SOURCES,
  REVALIDATE_CACHE,
  cacheControlFor,
  contentSecurityPolicy,
  securityHeaders,
} from "../../../bin/headers.mjs";
import nginxConf from "../../../docker/nginx.conf?raw";
import nginxHeaders from "../../../docker/security-headers.conf?raw";
import vercel from "../../../vercel.json";

type VercelRule = {source: string; headers: {key: string; value: string}[]};
const rules = vercel.headers as VercelRule[];
const rule = (source: string) => rules.find((r) => r.source === source);
const asRecord = (r: VercelRule | undefined) => Object.fromEntries((r?.headers ?? []).map((h) => [h.key, h.value]));

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));

describe("CSP", () => {
  const csp = contentSecurityPolicy();

  it("only runs the bundle's own scripts: no inline, eval, wasm or third-party script", () => {
    expect(directive(csp, "script-src")).toBe("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|wasm-unsafe-eval|strict-dynamic|nonce-|sha256-/);
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
  });

  it("is not embeddable, and the meta form drops what <meta> ignores", () => {
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    const meta = contentSecurityPolicy({meta: true});
    expect(meta).not.toContain("frame-ancestors");
    expect(meta).toContain("script-src 'self'");
  });

  it("allows only same-origin fonts and local or data images (no hotlinked logos)", () => {
    expect(directive(csp, "font-src")).toBe("font-src 'self'");
    expect(directive(csp, "img-src")).toBe("img-src 'self' data: blob:");
  });

  it("adds the local http sources to connect-src only when asked (the npx server)", () => {
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' https: wss:");
    const local = contentSecurityPolicy({extraConnect: LOCAL_CONNECT_SOURCES});
    expect(directive(local, "connect-src")).toBe(`connect-src 'self' https: wss: ${LOCAL_CONNECT_SOURCES.join(" ")}`);
  });

  it("lists every directive once", () => {
    const names = CSP_DIRECTIVES.map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("security headers", () => {
  const h = securityHeaders();

  it("keeps the referrer, sniffing, framing and opener policies", () => {
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin-allow-popups");
  });

  it("turns off powerful features but keeps the clipboard for this origin", () => {
    const pp = h["Permissions-Policy"] ?? "";
    for (const f of ["camera", "microphone", "geolocation", "payment", "usb", "hid", "serial"]) expect(pp).toContain(`${f}=()`);
    expect(pp).toContain("clipboard-read=(self)");
    expect(pp).toContain("clipboard-write=(self)");
  });
});

describe("cache policy", () => {
  it("caches hashed assets forever and revalidates everything else", () => {
    expect(cacheControlFor("/assets/index-abc.js")).toBe(IMMUTABLE_CACHE);
    expect(cacheControlFor("/index.html")).toBe(REVALIDATE_CACHE);
    expect(cacheControlFor("/runtime-config.json")).toBe(REVALIDATE_CACHE);
    expect(cacheControlFor("/fonts/Cp0xGrotesk-Regular.woff2")).toBe(REVALIDATE_CACHE);
    expect(REVALIDATE_CACHE).toBe("no-cache");
  });
});

describe("vercel.json", () => {
  it("is a plain static deploy: no functions, middleware, rewrites or framework", () => {
    expect(vercel.framework).toBeNull();
    // The dist guard checks the very build it deploys (with its VITE_CP0X_API, if the deploy passes one; D24/D30).
    expect(vercel.buildCommand).toBe("pnpm build && pnpm guard:dist");
    expect(vercel.outputDirectory).toBe("dist");
    for (const k of ["functions", "middleware", "rewrites", "redirects", "routes", "crons"]) expect(vercel).not.toHaveProperty(k);
  });

  it("sends exactly the shared security headers on every path", () => {
    expect(asRecord(rule("/(.*)"))).toEqual(securityHeaders());
  });

  it("splits caching between assets/ and everything else without overlap", () => {
    expect(asRecord(rule("/assets/(.*)"))).toEqual({"Cache-Control": IMMUTABLE_CACHE});
    expect(asRecord(rule("/((?!assets/).*)"))).toEqual({"Cache-Control": REVALIDATE_CACHE});
    expect(rules).toHaveLength(3);
  });
});

describe("docker nginx", () => {
  const addHeaders = Object.fromEntries(
    [...nginxHeaders.matchAll(/^add_header (\S+) "([^"]*)" always;$/gm)].map((m) => [m[1], m[2]]),
  );

  it("security-headers.conf carries exactly the shared headers, each with `always`", () => {
    expect(addHeaders).toEqual(securityHeaders());
    const directives = nginxHeaders.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    expect(directives.every((l) => l.endsWith(" always;"))).toBe(true);
  });

  it("every location includes the headers and sets the shared cache policy", () => {
    const locations = [...nginxConf.matchAll(/location ([^{]+)\{([^}]*)\}/g)].map((m) => ({where: (m[1] ?? "").trim(), body: m[2] ?? ""}));
    expect(locations.map((l) => l.where).sort()).toEqual(["/", "/assets/", "= /", "= /runtime-config.json"].sort());
    for (const l of locations) {
      expect(l.body, l.where).toContain("include /etc/nginx/cp0x/security-headers.conf;");
      const cache = l.where === "/assets/" ? IMMUTABLE_CACHE : REVALIDATE_CACHE;
      expect(l.body, l.where).toContain(`add_header Cache-Control "${cache}" always;`);
    }
  });

  it("serves runtime-config.json from the /config mount and keeps no access log", () => {
    expect(nginxConf).toMatch(/location = \/runtime-config\.json \{[^}]*root \/config;/);
    expect(nginxConf).toContain("access_log off;");
    expect(nginxConf).toContain("server_tokens off;");
  });
});
