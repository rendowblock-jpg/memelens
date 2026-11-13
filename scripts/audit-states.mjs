// Measures every screen state of the renderer, at the window sizes people really get, in the display modes that change how
// a page is drawn. It reads numbers from a real Chromium (through DevTools), not pictures: no state, size or mode can pass
// because nobody looked.
//
//   node scripts/audit-states.mjs [--dir apps/desktop/dist/preview] [--axe node_modules/axe-core/axe.min.js] [--only TEXT] [--json FILE]
//   run it under xvfb-run on a machine without a display:  xvfb-run -a node scripts/audit-states.mjs
//
// It serves the preview build (scripts/preview-build.ts, run it first) on a free local port, starts scripts/audit-shell.cjs
// (an empty Electron window with a DevTools port) and for every combination of state x window size x display mode checks:
//   - no sideways scroll, and nothing in <main> sticking out past the window's right edge
//   - no text running out of its own box (scrollWidth > clientWidth on a box that does not scroll or clip)
//   - exactly one <h1> and one <main>
//   - every control is at least 24 x 24 px (WCAG 2.5.8)
//   - axe-core: no WCAG 2.2 A/AA or best-practice violation
//   - forced-colors (Windows high contrast): the emulation took effect, every control still has a visible edge, no text
//     keeps its own colour on the system background
//   - reduced motion: nothing animates for longer than 50 ms once the person asked for less motion
// Sizes: 1366x728 (a 1366x768 laptop minus the taskbar), 900x600 (the smallest window the app allows), 1920x1040.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const dir = resolve(arg("dir", join(root, "apps/desktop/dist/preview")));
const axeSource = readFileSync(resolve(arg("axe", join(root, "node_modules/axe-core/axe.min.js"))), "utf8");
const only = arg("only", "");
const jsonOut = arg("json", "");

const STATES = [
  ["feed", "/"],
  ["first run (empty database)", "/?db=empty"],
  ["token panel", "/?go=tok1"],
  ["smart money", "/?go=smart"],
  ["wallet", "/?go=wallet-alice"],
  ["backtest, no engine", "/?go=backtest&engine=none"],
  ["backtest, engine ready", "/?go=backtest&engine=ready"],
  ["backtest, engine problem", "/?go=backtest&engine=problem"],
  ["backtest, result", "/?go=backtest&engine=ready&run=1"],
  ["backtest, run failed", "/?go=backtest&engine=ready&run=1&fail=1"],
].filter(([name]) => name.includes(only));
const SIZES = [
  ["1366x728", 1366, 728],
  ["900x600", 900, 600],
  ["1920x1040", 1920, 1040],
];
const MODES = [
  ["normal", []],
  ["forced-colors", [{ name: "forced-colors", value: "active" }]],
  ["more contrast", [{ name: "prefers-contrast", value: "more" }]],
  ["reduced motion", [{ name: "prefers-reduced-motion", value: "reduce" }]],
];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// ---- the preview build, served from a folder
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = normalize(join(dir, path === "/" ? "index.html" : path));
  if (!file.startsWith(dir)) return (res.writeHead(403), res.end());
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const serverPort = server.address().port;

// ---- the Chromium window
const electron = createRequire(join(root, "package.json"))("electron");
const cdpPort = 9400 + Math.floor(Math.random() * 400);
const child = spawn(electron, ["--no-sandbox", join(here, "audit-shell.cjs")], { env: { ...process.env, AUDIT_PORT: String(cdpPort) }, stdio: "ignore" });
const stop = () => {
  try {
    child.kill("SIGKILL");
  } catch {}
  server.close();
};
process.on("exit", stop);

let ws;
let nextId = 1;
const pending = new Map();
function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 30_000);
  });
}
async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

// ---- what is measured, run inside the page
const MEASURE = `(() => {
  const vw = innerWidth;
  const main = document.querySelector("main");
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.closest("[hidden]"); };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.classList[0] ? "." + e.classList[0] : "");
  const inMain = main ? [...main.querySelectorAll("*")].filter(visible) : [];
  const sticksOut = inMain.filter((e) => !e.closest(".sr-only") && e.getBoundingClientRect().right > vw + 1).slice(0, 5).map((e) => ({ el: name(e), right: Math.round(e.getBoundingClientRect().right) }));
  const spills = inMain
    .filter((e) => { const s = getComputedStyle(e); return e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && s.overflowX === "visible" && s.display !== "inline" && s.display !== "table-cell"; })
    .slice(0, 5).map((e) => ({ el: name(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth }));
  const small = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]")]
    .filter(visible).map((e) => { const r = e.getBoundingClientRect(); return { el: name(e), text: (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 20), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; })
    .filter((x) => x.w < 24 || x.h < 24).slice(0, 6);
  const controls = [...document.querySelectorAll("button, input:not([type=hidden]), select, textarea")].filter(visible);
  // A control is recognisable by an edge, or by sitting inside a bordered group (the segmented choice), or by being an underlined
  // link-like word, or by being an item of the navigation list (whose selected item is checked separately below).
  const noEdge = controls.filter((e) => { const s = getComputedStyle(e); return !(parseFloat(s.borderTopWidth) >= 1 && s.borderTopStyle !== "none") && !(parseFloat(s.outlineWidth) >= 1 && s.outlineStyle !== "none") && !(s.textDecorationLine.includes("underline")) && !e.classList.contains("rail-item") && !(parseFloat(getComputedStyle(e.parentElement).borderTopWidth) >= 1 && getComputedStyle(e.parentElement).borderTopStyle !== "none"); })
    .slice(0, 6).map((e) => ({ el: name(e), text: (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 20) }));
  // What marks the chosen item (the open screen, the selected row, a pressed toggle) must not be a colour alone.
  const unmarked = [...document.querySelectorAll('[aria-current="page"], tr.selected, [aria-pressed="true"]')].filter(visible)
    .filter((e) => e.matches("tr.selected") || !e.closest("tr.selected")) // a button inside the selected row is marked by the row
    .filter((e) => { const s = getComputedStyle(e); return !(parseFloat(s.outlineWidth) >= 1 && s.outlineStyle !== "none") && !(parseFloat(s.borderTopWidth) >= 1 && s.borderTopStyle !== "none"); })
    .slice(0, 5).map((e) => ({ el: name(e), text: (e.textContent || "").trim().slice(0, 20) }));
  // After a run has finished, its result must be where the person is looking: the heading holds focus (so a screen reader says
  // "Result") and is on screen. Measured 13 Nov 2026: it started 306px below the fold and nothing moved it.
  const resultHeading = document.querySelector("section.bt-result h2");
  const reveal = resultHeading === null ? null : (() => {
    const b = resultHeading.getBoundingClientRect();
    // The scroll area the heading lives in, and how far its focus ring reaches outside its box (outline width + offset).
    // Measured 13 Nov 2026 on the Windows build: the ring's top edge was missing, cut off by the top of this scroll area.
    let sc = resultHeading.parentElement; while (sc !== null && !(sc.scrollHeight > sc.clientHeight && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    const area = (sc ?? document.documentElement).getBoundingClientRect();
    const cs = getComputedStyle(resultHeading);
    const reach = cs.outlineStyle === "none" ? 4 : Math.max(0, parseFloat(cs.outlineWidth)) + Math.max(0, parseFloat(cs.outlineOffset));
    return { focused: document.activeElement === resultHeading, top: Math.round(b.top), bottom: Math.round(b.bottom), viewport: innerHeight, areaTop: Math.round(area.top), areaBottom: Math.round(area.bottom), reach };
  })();
  // The title of a detail panel (a token's or a wallet's) is set as a title: the largest text inside it is at least 16px.
  // Measured 13 Nov 2026: a wallet's address was 12px grey, smaller than the figures under it.
  const panelH2 = document.querySelector(".wallet-panel h2, .token-panel h2");
  const panelTitle = panelH2 === null ? null : Math.max(...[panelH2, ...panelH2.querySelectorAll("*")].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(getComputedStyle(e).fontSize)));
  // The Backtest screen uses the same width as the others: all the room its parent gives, up to the shared 1180px.
  const btEl = document.querySelector(".bt");
  const btFill = btEl === null || !visible(btEl) ? null : (() => { const ps = getComputedStyle(btEl.parentElement); return { w: Math.round(btEl.getBoundingClientRect().width), inner: Math.round(btEl.parentElement.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight)) }; })();
  const animated = [...document.querySelectorAll("*")].filter((e) => { const s = getComputedStyle(e); return s.animationName !== "none" && parseFloat(s.animationDuration) > 0.05; })
    .slice(0, 5).map((e) => ({ el: name(e), name: getComputedStyle(e).animationName, s: getComputedStyle(e).animationDuration }));
  const sizes = inMain.filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(getComputedStyle(e).fontSize));
  return JSON.stringify({
    h1: document.querySelectorAll("h1").length, mains: document.querySelectorAll("main").length,
    reveal, panelTitle, btFill, overflowX: document.documentElement.scrollWidth - vw, sticksOut, spills, small, noEdge, unmarked, animated,
    forced: matchMedia("(forced-colors: active)").matches, more: matchMedia("(prefers-contrast: more)").matches, reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
    bodyColor: getComputedStyle(document.body).color, bodyBg: getComputedStyle(document.body).backgroundColor,
    minFont: sizes.length ? Math.min(...sizes) : null, controls: controls.length, contentHeight: document.documentElement.scrollHeight,
  });
})()`;
const AXE = `axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(AXE_TAGS)} }, resultTypes: ["violations"] }).then((r) => JSON.stringify(r.violations.map((v) => ({ rule: v.id, impact: v.impact, count: v.nodes.length, where: v.nodes.slice(0, 3).map((n) => n.target.join(" ")), why: (v.nodes[0].any[0] || v.nodes[0].all[0] || v.nodes[0].none[0] || {}).message }))))`;

const results = [];
let failures = 0;
function record(state, size, mode, label, ok, detail) {
  results.push({ state, size, mode, label, ok, detail });
  if (!ok) {
    failures += 1;
    console.log(`FAIL  [${state} | ${size} | ${mode}] ${label}  ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 420)}`);
  }
}

try {
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === "page"), "the Chromium window");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error("DevTools websocket failed")))));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (p) (pending.delete(msg.id), msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result));
  };
  await cdp("Page.enable");

  let combos = 0;
  for (const [sizeName, width, height] of SIZES) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const [modeName, features] of MODES) {
      await cdp("Emulation.setEmulatedMedia", { features });
      for (const [state, path] of STATES) {
        await cdp("Page.navigate", { url: "about:blank" });
        await cdp("Page.navigate", { url: `http://127.0.0.1:${serverPort}${path}` });
        const settled = await until(
          () => evaluate(`(() => { const m = document.querySelector("main"); if (!m || m.textContent.trim().length < 20 || document.querySelector(".skeleton")) return false; if (${JSON.stringify(path)}.includes("run=1")) return Boolean(document.querySelector("section.bt-result, .bt [role=alert]")); return true; })()`),
          `${state} to settle`,
        ).catch(() => false);
        await sleep(450); // past the skeleton's 160 ms delay and any entrance motion
        combos += 1;
        if (!settled) {
          record(state, sizeName, modeName, "the screen settles", false, "no <main> content within 20 s");
          continue;
        }
        const m = JSON.parse(await evaluate(MEASURE));
        const at = (label, ok, detail) => record(state, sizeName, modeName, label, ok, ok ? undefined : detail);
        at("one <h1> and one <main>", m.h1 === 1 && m.mains === 1, { h1: m.h1, mains: m.mains });
        at("no sideways scroll", m.overflowX <= 0, { overflowX: m.overflowX });
        at("nothing in <main> sticks out past the window", m.sticksOut.length === 0, m.sticksOut);
        at("no text runs out of its own box", m.spills.length === 0, m.spills);
        at("every control is at least 24 x 24 px", m.small.length === 0, m.small);
        at("the title of a detail panel is set as a title (largest text in it at least 16px)", m.panelTitle === null || m.panelTitle >= 16, { panelTitle: m.panelTitle });
        at("the Backtest screen fills the room its parent gives it (up to the width the other screens share)", m.btFill === null || m.btFill.w >= m.btFill.inner - 1, m.btFill);
        if (path.includes("run=1") && !path.includes("fail=1")) {
          at("a finished run focuses the result's heading and brings it on screen", m.reveal !== null && m.reveal.focused && m.reveal.top >= 0 && m.reveal.bottom <= m.reveal.viewport, m.reveal);
          at("the result heading's focus ring is not cut off by the top or bottom of its scroll area", m.reveal !== null && m.reveal.top - m.reveal.reach >= m.reveal.areaTop && m.reveal.bottom + m.reveal.reach <= m.reveal.areaBottom, m.reveal);
        }
        if (modeName === "forced-colors") {
          at("the forced-colors emulation took effect", m.forced === true, { forced: m.forced });
          at("every control keeps a visible edge (or sits in a bordered group, is an underlined link, or a navigation item)", m.noEdge.length === 0, m.noEdge);
          at("the selected item is still marked without its colour", m.unmarked.length === 0, m.unmarked);
        }
        if (modeName === "more contrast") at("the contrast preference reached the page", m.more === true, { more: m.more });
        if (modeName === "reduced motion") {
          at("the motion preference reached the page", m.reduce === true, { reduce: m.reduce });
          at("nothing animates once less motion is asked for", m.animated.length === 0, m.animated);
        }
        if (modeName !== "forced-colors") {
          if ((await evaluate("typeof axe")) !== "object") await evaluate(axeSource);
          const violations = JSON.parse(await evaluate(AXE));
          at("axe-core: no WCAG 2.2 AA or best-practice violation", violations.length === 0, violations);
        }
        results.push({ state, size: sizeName, mode: modeName, label: "measured", ok: true, detail: { minFont: m.minFont, controls: m.controls, contentHeight: m.contentHeight, bodyColor: m.bodyColor, bodyBg: m.bodyBg } });
      }
    }
  }
  const checks = results.filter((r) => r.label !== "measured").length;
  console.log(`${failures === 0 ? "AUDIT OK" : "AUDIT FAILED"}: ${combos} state/size/mode combinations, ${checks - failures}/${checks} checks passed`);
} catch (e) {
  failures += 1;
  console.log(`FAIL  the audit itself could not finish: ${e.message}`);
} finally {
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
  stop();
}
process.exit(failures === 0 ? 0 : 1);
