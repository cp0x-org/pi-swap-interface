import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";
import {colors, radius, space, type} from "../../../src/theme/tokens";

const css = readFileSync(resolve(process.cwd(), "src/theme/tokens.css"), "utf8");
const vars = new Map([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** "#00D4FF" / "rgba(0,0,0,.55)" and "#00d4ff" / "rgba(0, 0, 0, 0.55)" compare equal. */
const norm = (v: string) => v.toLowerCase().replace(/\s+/g, "").replace(/(^|[,(])\.(\d)/g, "$10.$2");

describe("tokens.css mirrors theme/tokens.ts", () => {
  it("colors", () => {
    for (const [k, v] of Object.entries(colors)) expect(norm(vars.get(kebab(k)) ?? "missing"), k).toBe(norm(v));
  });

  it("radius and space", () => {
    for (const [k, v] of Object.entries(radius)) expect(vars.get(`r-${kebab(k)}`), k).toBe(`${v}px`);
    for (const [k, v] of Object.entries(space)) expect(vars.get(`sp-${kebab(k)}`), k).toBe(`${v}px`);
  });

  it("type scale: size, weight, tracking, line-height", () => {
    for (const [k, v] of Object.entries(type)) {
      const p = `t-${kebab(k)}`;
      expect(vars.get(`${p}-size`), k).toBe(`${v.size}px`);
      expect(vars.get(`${p}-weight`), k).toBe(String(v.weight));
      expect(vars.get(`${p}-tracking`), k).toBe(`${v.tracking}px`);
      if ("lineHeight" in v) expect(vars.get(`${p}-line`), k).toBe(`${v.lineHeight}px`);
    }
  });

  it("keeps every variable name of the contracts-phase stub", () => {
    const stub = ["bg", "bg-outer", "surface1", "surface2", "surface3", "surface3-alt", "menu", "menu-hover", "divider", "ink", "ink2", "muted", "dim", "faint", "accent", "accent-pressed", "accent-bg", "accent-border", "on-accent", "glass-tint", "green", "green-bg", "red", "amber", "backdrop", "red-bg", "red-bg-step", "amber-bg", "r-tag", "r-chip", "r-control", "r-card", "r-sheet", "r-pill", "sp-page", "sp-list", "sp-row", "sh-card", "sh-button", "sh-button-accent", "sh-sheet", "sh-menu"];
    for (const name of stub) expect(vars.has(name), name).toBe(true);
  });
});

describe("text contrast (WCAG AA 4.5:1)", () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  it("every text role (ink2, muted, dim) reads at 4.5:1 on the page and on cards", () => {
    for (const fg of ["ink2", "muted", "dim"] as const)
      for (const bg of ["bg", "surface1", "surface2"] as const) expect(ratio(colors[fg], colors[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});
