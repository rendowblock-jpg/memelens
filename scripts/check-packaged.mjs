// Looks at a PACKAGED MemeLens from outside, the way a person would use it: starts the real executable (the installed
// MSI on Windows, the unpacked folder on Linux), talks to its window over the Chrome DevTools protocol, clicks
// through the screens, checks what is on them and saves a screenshot of each.
// usage: node scripts/check-packaged.mjs --exe PATH --db PATH --out DIR [--rows N] [--no-sandbox]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const exe = arg("exe");
const db = arg("db");
const out = arg("out");
if (!exe || !db || !out) {
  console.error("usage: node scripts/check-packaged.mjs --exe PATH --db PATH --out DIR [--rows N] [--no-sandbox]");
  process.exit(2);
}
const expectRows = Number(arg("rows", "5"));
const port = Number(process.env.CDP_PORT ?? 9333);
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${last.message})` : ""}`);
}

const checks = [];
const check = (name, ok, got) => {
  checks.push({ name, ok: Boolean(ok), got });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
};

const child = spawn(exe, [`--remote-debugging-port=${port}`, ...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : [])], {
  env: { ...process.env, MEMELENS_DB: db },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
let exited = null;
child.on("exit", (code, signal) => (exited = { code, signal }));

function stopApp() {
  if (exited) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

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
// DevTools exempts the code it evaluates from the page's "no eval" rule unless told otherwise
// (allowUnsafeEvalBlockedByCSP defaults to true), so a probe of eval must turn that off to test the page's own policy.
async function evaluate(expression, extra = {}) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false, ...extra });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const file = join(out, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`SHOT ${file} ${Buffer.from(r.data, "base64").length} bytes`);
}
const text = (sel) => evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
const waitSel = (sel) => until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(sel)}))`), `selector ${sel}`, 20_000);

let failed = false;
try {
  const target = await until(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await r.json()).find((t) => t.type === "page" && t.url.startsWith("app://memelens"));
  }, "the app window to appear over the DevTools port");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error("DevTools websocket failed")))));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (p) (pending.delete(msg.id), msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result));
  };
  console.log(`window: ${target.url}  title: ${JSON.stringify(target.title)}`);

  const state = await until(() => evaluate("document.body.dataset.state"), "the first screen to finish loading");
  check("the first screen finished loading without error", state === "done", state);

  const facts = JSON.parse(
    await evaluate(`JSON.stringify({
      rows: document.querySelectorAll("table.feed tbody tr[data-token]").length,
      notice: (document.querySelector("[data-testid=notice]") || {}).textContent || "",
      gauge: Boolean(document.querySelector("section.token-panel .gauge")),
      bar: document.querySelectorAll("section.token-panel svg[aria-label^='Risk by signal'] .seg-track").length,
      origin: location.origin, title: document.title,
      req: typeof require, proc: typeof process, mod: typeof module, buf: typeof Buffer,
      api: Object.keys(window.memelens).sort(),
    })`),
  );
  check("the feed shows every token of the fixture", facts.rows === expectRows, facts.rows);
  check("the notice says the data is synthetic", /SYNTHETIC DATA/.test(facts.notice), facts.notice);
  check("the first token's panel has its risk gauge and a bar of 10 signals", facts.gauge && facts.bar === 10, facts);
  check("the page runs on app://memelens", facts.origin === "app://memelens", facts.origin);
  check("the window title is MemeLens", facts.title === "MemeLens", facts.title);
  check("the page has no require/process/module/Buffer", [facts.req, facts.proc, facts.mod, facts.buf].every((t) => t === "undefined"), facts);
  check("window.memelens has exactly the 5 channels", JSON.stringify(facts.api) === JSON.stringify(["feed", "overview", "smart", "token", "wallet"]), facts.api);

  const probes = JSON.parse(
    await evaluate(`(async () => {
      const r = {};
      try { await fetch("https://example.com/"); r.fetch = "allowed"; } catch { r.fetch = "blocked"; }
      try { new Function("return 1")(); r.eval = "allowed"; } catch { r.eval = "blocked"; }
      const s = document.createElement("script"); s.textContent = "window.__inline = true"; document.head.appendChild(s);
      r.inline = window.__inline === true ? "ran" : "blocked";
      return JSON.stringify(r);
    })()`),
  );
  check("network fetch is blocked", probes.fetch === "blocked", probes.fetch);
  check("eval is blocked", probes.eval === "blocked", probes.eval);
  check("inline script is blocked", probes.inline === "blocked", probes.inline);

  await shot("1-feed");
  await evaluate(`[...document.querySelectorAll(".rail-item")].find((b) => b.textContent.includes("Smart")).click()`);
  await waitSel("table.smart-ranked");
  const ranked = await text("table.smart-ranked tbody tr:first-child");
  check("smart money ranks alice first with +0.005 SOL", /alice/.test(ranked) && /\+0\.005 SOL/.test(ranked), ranked);
  await shot("2-smart-money");
  await evaluate(`document.querySelector("table.smart-ranked button.wallet").click()`);
  await waitSel(".wallet-panel[data-wallet='alice']");
  const wallet = await text(".wallet-panel");
  check("alice's wallet page shows realised +0.005 SOL and 10 trades", /Realised\s*\+0\.005 SOL/.test(wallet) && /10 trades/.test(wallet), wallet.slice(0, 160));
  await shot("3-wallet-alice");
} catch (e) {
  failed = true;
  console.log(`FAIL  the check itself could not finish: ${e.message}`);
  if (exited) console.log(`      the app had already exited: ${JSON.stringify(exited)}`);
  console.log(`      app output (last 1500 chars): ${log.slice(-1500)}`);
} finally {
  try {
    ws?.close();
  } catch {}
  stopApp();
}
const bad = checks.filter((c) => !c.ok).length;
console.log(`PACKAGED ${bad === 0 && !failed ? "OK" : "FAILED"}: ${checks.length - bad}/${checks.length} checks passed`);
process.exit(bad === 0 && !failed ? 0 : 1);
