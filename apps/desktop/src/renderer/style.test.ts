import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A contract on style.css that no screenshot is needed for. jsdom does not compute styles, so the rules that keep the
// design honest are checked on the stylesheet itself: every colour pair that carries text meets WCAG 2.2 contrast, every
// control boundary meets the 3:1 non-text contrast, nothing outside the token block uses a raw colour or an ad-hoc font
// size, motion can be switched off, and the page still works when Windows forces its own colours.

const RAW = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8");
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, "");

/** The text between the braces of the first block that starts with `head`. */
function block(css: string, head: string): string {
  const start = css.indexOf(head);
  if (start < 0) throw new Error(`style.css has no "${head}" block`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`"${head}" is not closed`);
}

function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const ROOT = block(CSS, ":root");
const T = tokens(ROOT);
/** Everything except the token blocks (the :root block and any :root override inside a media query): the rules that must use the tokens. */
function withoutRoots(css: string): string {
  let out = css;
  for (;;) {
    const at = out.indexOf(":root");
    if (at < 0) return out;
    const open = out.indexOf("{", at);
    out = out.slice(0, at) + out.slice(open + 1 + block(out.slice(at), ":root").length + 1);
  }
}
const RULES = withoutRoots(CSS);

type RGB = readonly [number, number, number];
function rgb(value: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (m === null) throw new Error(`"${value}" is not a #rrggbb colour`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function color(name: string): RGB {
  const v = T[name];
  if (v === undefined) throw new Error(`token --${name} is missing`);
  return rgb(v);
}
/** `fg` at `alpha` laid over the opaque `bg`. */
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as unknown as RGB;
}
function luminance([r, g, b]: RGB): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const ratio = (fg: string, bg: string): number => contrast(color(fg), color(bg));

/** The percentage the stylesheet mixes a tone into a badge, read from the rule itself so the test follows the CSS. */
function badgeTint(): number {
  const m = /\.badge\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--tone\)\s*(\d+)%/.exec(CSS);
  if (m === null) throw new Error("the .badge rule no longer mixes its tint with color-mix(in srgb, var(--tone) N%, …)");
  return Number(m[1]) / 100;
}

const SURFACES = ["bg", "rail", "surface", "surface-2"] as const;

describe("the colour tokens", () => {
  it("define every colour the screens use, as plain #rrggbb values", () => {
    const names = ["bg", "rail", "surface", "surface-2", "line", "line-soft", "line-strong", "text", "muted", "accent", "on-accent", "low", "medium", "high", "critical", "unknown", "gain", "loss", "error-text", "warn-text", "on-warn", "scroll"];
    for (const n of names) expect(() => color(n), `--${n}`).not.toThrow();
  });

  it.each(SURFACES)("body text reaches 4.5:1 on --%s (WCAG 1.4.3)", (s) => {
    expect(ratio("text", s)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(SURFACES)("muted text reaches 4.5:1 on --%s", (s) => {
    expect(ratio("muted", s)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(SURFACES)("the accent as a text colour reaches 4.5:1 on --%s", (s) => {
    expect(ratio("accent", s)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["gain", "loss"] as const)("--%s (money) reaches 4.5:1 on every surface", (tone) => {
    for (const s of SURFACES) expect(ratio(tone, s), `${tone} on ${s}`).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["low", "medium", "high", "critical", "unknown"] as const)("risk tone --%s reaches 4.5:1 on every surface and on its own badge tint", (tone) => {
    for (const s of SURFACES) expect(ratio(tone, s), `${tone} on ${s}`).toBeGreaterThanOrEqual(4.5);
    for (const s of ["bg", "surface", "surface-2"] as const) {
      const tinted = over(color(tone), badgeTint(), color(s));
      expect(contrast(color(tone), tinted), `${tone} badge on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("the text of the primary button reaches 4.5:1 on the accent", () => {
    expect(ratio("on-accent", "accent")).toBeGreaterThanOrEqual(4.5);
  });
  it("the data-notice label reaches 4.5:1 on the warning colour", () => {
    expect(ratio("on-warn", "medium")).toBeGreaterThanOrEqual(4.5);
  });
  it("error and warning text reach 4.5:1 on their own tinted boxes", () => {
    for (const s of ["bg", "surface"] as const) {
      expect(contrast(color("error-text"), over(color("critical"), 0.08, color(s))), `error on ${s}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color("warn-text"), over(color("medium"), 0.08, color(s))), `warning on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("the selected rail item (accent on the accent wash over the rail) reaches 4.5:1", () => {
    expect(contrast(color("accent"), over(color("accent"), 0.13, color("rail")))).toBeGreaterThanOrEqual(4.5);
  });

  // WCAG 1.4.11: the edge of a field or button is what tells a person it is one. The quiet --line is for separators only.
  it.each(["surface", "surface-2", "bg"] as const)("--line-strong, used on the edge of every control, reaches 3:1 on --%s", (s) => {
    expect(ratio("line-strong", s)).toBeGreaterThanOrEqual(3);
  });
  it("the focus ring (the accent) reaches 3:1 on every surface", () => {
    for (const s of SURFACES) expect(ratio("accent", s), s).toBeGreaterThanOrEqual(3);
  });
});

describe("type, colour and motion rules", () => {
  const SCALE = ["fs-xs", "fs-sm", "fs-md", "fs-lg", "fs-xl", "fs-2xl", "fs-3xl"];

  it("people who ask for more contrast get muted text at 7:1 and control edges at 4.5:1 on every surface", () => {
    const more = tokens(block(CSS, "@media (prefers-contrast: more)"));
    const dark = (name: string): RGB => rgb(more[name] ?? T[name]!);
    for (const s of SURFACES) {
      expect(contrast(dark("muted"), color(s)), `muted on ${s}`).toBeGreaterThanOrEqual(7);
      expect(contrast(dark("line-strong"), color(s)), `line-strong on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("has a type scale of seven sizes, none under 12px, rising", () => {
    const sizes = SCALE.map((n) => {
      const v = /^(\d+(?:\.\d+)?)px$/.exec(T[n] ?? "");
      if (v === null) throw new Error(`--${n} is missing or not in px`);
      return Number(v[1]);
    });
    expect(sizes[0]).toBeGreaterThanOrEqual(12);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it("sets every font-size from the scale, never a literal", () => {
    const sizes = [...RULES.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(sizes.length).toBeGreaterThan(10);
    const loose = sizes.filter((v) => !new RegExp(`^var\\(--(${[...SCALE, "mono-scale"].join("|")})\\)$`).test(v) && v !== "inherit");
    expect(loose).toEqual([]);
  });

  it("uses no raw colour outside the token block (hex, rgb, rgba, hsl)", () => {
    const raw = [...RULES.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g)].map((m) => m[0]);
    expect(raw).toEqual([]);
  });

  it("never removes the focus outline, and draws a focus ring on keyboard focus", () => {
    expect(/outline\s*:\s*(none|0)\b/.test(RULES)).toBe(false);
    expect(/:focus-visible\s*\{[^}]*outline\s*:\s*2px solid var\(--accent\)/.test(RULES)).toBe(true);
  });

  it("switches animation and transition off when the system asks for reduced motion", () => {
    const body = block(CSS, "@media (prefers-reduced-motion: reduce)");
    expect(body).toMatch(/animation\s*:\s*none\s*!important/);
    expect(body).toMatch(/transition\s*:\s*none\s*!important/);
  });

  it("has a forced-colors block so Windows High Contrast keeps focus, selection and state visible", () => {
    const body = block(CSS, "@media (forced-colors: active)");
    expect(body).toMatch(/:focus-visible/);
    expect(body).toMatch(/aria-current|aria-pressed|\.selected/);
    expect(body).toMatch(/Highlight|CanvasText|ButtonText|LinkText/);
  });

  it("uses !important only to honour [hidden] and the reduced-motion request", () => {
    const offenders = [...CSS.matchAll(/([^{}]*)\{([^{}]*!important[^{}]*)\}/g)].map((m) => m[1]!.trim()).filter((sel) => sel !== "[hidden]" && sel !== "*, *::before, *::after");
    expect(offenders).toEqual([]);
  });

  it("gives a link-like button and a disclosure summary a hit area of at least 24px (WCAG 2.5.8)", () => {
    const link = /\.link\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(link).toMatch(/min-height\s*:\s*24px/);
    expect(link).toMatch(/min-width\s*:\s*24px/); // a one-digit count ("x1") is narrower than 24px on its own
    expect(link).not.toMatch(/margin\s*:\s*-/);
    const summary = /\.empty summary\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(summary).toMatch(/min-height\s*:\s*24px/);
  });

  // Measured in a real Chromium (scripts/audit-states.mjs): at the smallest window, 900 x 600, the wallet's positions table
  // was 24px wider than its panel because a header, "Sold without a known buy", would not wrap. A header may wrap in the
  // screens that hold a table inside a panel; only the feed's headers stay on one line.
  it("lets the header cells of a table inside a panel wrap, so a long header cannot push the table out of its panel", () => {
    const panel = /\.detail thead th,\s*\.single thead th\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(panel).toMatch(/white-space\s*:\s*normal/);
  });
});

// Measured in a real Chromium on 13 Nov 2026 (docs/ui-readings/): the wallet's own address was the weakest text on its screen,
// 12px grey under a title bar that says "Wallet", smaller than the three figures below it (22px). A detail panel's title is a
// title: in the text colour and at a size from the top of the scale.
describe("the title of a detail panel", () => {
  const rule = (selector: string): string => {
    const found = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.split(",").map((x) => x.trim()).includes(selector));
    return found.map((m) => m[2]).join(" ");
  };

  it("sets a wallet's address at the size of a title and in the text colour, not in the muted stub style", () => {
    const wallet = rule(".wallet-panel h2 .addr");
    expect(wallet).toMatch(/font-size\s*:\s*var\(--fs-xl\)/);
    expect(wallet).toMatch(/color\s*:\s*var\(--text\)/);
    expect(wallet).not.toMatch(/color\s*:\s*var\(--muted\)/);
  });

  it("keeps the token's address under its name as the small muted stub it is", () => {
    const token = rule(".token-panel h2 .addr");
    expect(token).toMatch(/font-size\s*:\s*var\(--fs-xs\)/);
    expect(token).toMatch(/color\s*:\s*var\(--muted\)/);
  });
});

describe("the Backtest screen", () => {
  it("has the same measure as the screens beside it: no cap below the 1180px they share", () => {
    const bt = /(?:^|\})\s*\.bt\s*\{([^}]*)\}/m.exec(CSS)?.[1] ?? "";
    expect(bt).not.toBe("");
    const cap = /max-width\s*:\s*(\d+)px/.exec(bt)?.[1];
    expect(cap === undefined || Number(cap) >= 1180).toBe(true);
    expect(/\.single\s*\{[^}]*max-width\s*:\s*1180px/.test(CSS)).toBe(true);
  });
});
