// Looks at a PACKAGED MemeLens from outside, the way a person would use it: starts the real executable (the installed
// MSI on Windows, the unpacked folder on Linux), talks to its window over the Chrome DevTools protocol, clicks
// through the screens, checks what is on them and saves a screenshot of each.
// usage: node scripts/check-packaged.mjs --exe PATH --db PATH --out DIR [--rows N] [--no-sandbox] [--axe PATH_TO_axe.min.js]
// With --axe, every screen that is photographed is also scanned with axe-core (WCAG 2.2 A/AA and best practice) inside the
// real window, and any violation fails the check.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// By default the app gets its own empty engine folder, so what the Backtest screen says does not depend on the machine running
// this. With --default-engine-folder the app is left to choose its own per-user folder (%LOCALAPPDATA%\MemeLens\sidecar), the
// way a real install does. That is for a clean Windows runner only: it refuses to run if the folder already exists, so it can
// never touch an engine somebody already has.
const useDefaultFolder = process.argv.includes("--default-engine-folder");
let engineRoot;
if (useDefaultFolder) {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    console.error("--default-engine-folder is for Windows only (it needs %LOCALAPPDATA%)");
    process.exit(2);
  }
  engineRoot = join(process.env.LOCALAPPDATA, "MemeLens", "sidecar");
  if (existsSync(engineRoot)) {
    console.error(`${engineRoot} already exists: refusing to run against an existing engine folder`);
    process.exit(2);
  }
}
// --first-run: the app is started on a database that does not exist yet, so it shows the "No data yet" screen, and the check
// presses "Load the sample data" the way a person who has just installed MemeLens would. --default-db (Windows only) also leaves
// the database path to the app (its own user-data folder) instead of naming one.
const firstRun = process.argv.includes("--first-run");
const useDefaultDb = process.argv.includes("--default-db");
if (useDefaultDb && (!firstRun || process.platform !== "win32")) {
  console.error("--default-db needs --first-run and is for Windows only");
  process.exit(2);
}
const dbFile = firstRun ? join(out, "first-run.sqlite") : db;
if (firstRun) for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(dbFile + suffix, { force: true });
const appEnv = { ...process.env, MEMELENS_DB: dbFile };
if (useDefaultDb) delete appEnv.MEMELENS_DB;
if (useDefaultFolder) delete appEnv.MEMELENS_SIDECAR_DIR;
else appEnv.MEMELENS_SIDECAR_DIR = mkdtempSync(join(tmpdir(), "memelens-sidecar-"));
const child = spawn(exe, [`--remote-debugging-port=${port}`, ...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : [])], {
  env: appEnv,
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
  await axeScan(name);
  await controlSizeScan(name);
}

// WCAG 2.5.8 (Target Size, Minimum, AA): a control is at least 24 x 24 CSS px. axe grants an exception for small controls that
// have room around them; this check does not, so a cramped control cannot hide behind the empty space beside it.
async function controlSizeScan(name) {
  const small = JSON.parse(
    await evaluate(`JSON.stringify([...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]")]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest("[hidden]"); })
      .map((e) => { const r = e.getBoundingClientRect(); return { el: e.tagName.toLowerCase() + (e.classList[0] ? "." + e.classList[0] : ""), text: (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 24), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; })
      .filter((x) => x.w < 24 || x.h < 24).slice(0, 8))`),
  );
  check(`every control on ${name} is at least 24 x 24 px (WCAG 2.5.8)`, small.length === 0, small);
}

// axe-core is a development dependency (Deque, MPL-2.0); it is read from node_modules and never packaged. It runs in the page
// through DevTools, which the page's no-eval and no-inline-script policy does not apply to, and it needs neither itself.
const axePath = arg("axe");
const axeSource = axePath ? readFileSync(axePath, "utf8") : null;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
async function axeScan(name) {
  if (axeSource === null) return;
  if ((await evaluate("typeof axe")) !== "object") await evaluate(axeSource, { allowUnsafeEvalBlockedByCSP: true });
  const raw = await evaluate(
    `axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(AXE_TAGS)} }, resultTypes: ["violations"] }).then((r) => JSON.stringify(r.violations.map((v) => ({ rule: v.id, impact: v.impact, help: v.help, count: v.nodes.length, where: v.nodes.slice(0, 4).map((n) => n.target.join(" ")), why: v.nodes.slice(0, 2).map((n) => (n.any[0] || n.all[0] || n.none[0] || {}).message) }))))`,
    { allowUnsafeEvalBlockedByCSP: true },
  );
  const violations = JSON.parse(raw);
  check(`accessibility scan (axe, WCAG 2.2 AA and best practice): ${name} has no violations`, violations.length === 0, violations);
}
// The command lines of the app's processes while it runs (Chromium puts --type=renderer on the renderer's).
function appCommandLines() {
  if (process.platform === "win32") {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='MemeLens.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" });
    return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
  }
  const r = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").filter((l) => l.includes(exe) && !l.includes("check-packaged"));
}
const text = (sel) => evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
const waitSel = (sel) => until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(sel)}))`), `selector ${sel}`, 20_000);

async function firstRunChecks() {
  const state = await until(() => evaluate("document.body.dataset.state"), "the first screen to finish loading");
  check("a database with no data opens the 'No data yet' screen", state === "empty", state);
  const empty = JSON.parse(
    await evaluate(`JSON.stringify({
      title: (document.querySelector("[data-testid=empty-state] h2") || {}).textContent || "",
      hasButton: [...document.querySelectorAll("[data-testid=empty-state] button")].some((b) => b.textContent.trim() === "Load the sample data" && !b.disabled),
      text: (document.querySelector("[data-testid=empty-state]") || {}).textContent || "",
    })`),
  );
  check(
    "it offers 'Load the sample data' and says the sample is made up and that there is no real-data adapter yet",
    empty.title === "No data yet" && empty.hasButton && /SYNTHETIC DATA/.test(empty.text) && /real-data adapter is not built yet/.test(empty.text),
    empty,
  );
  await shot("0-first-run-empty");
  await evaluate(`[...document.querySelectorAll("[data-testid=empty-state] button")].find((b) => b.textContent.trim() === "Load the sample data").click()`);
  await until(async () => (await evaluate(`document.querySelectorAll("table.feed tbody tr[data-token]").length`)) === expectRows, "the feed to show the sample after the button was pressed", 30_000);
  const after = JSON.parse(
    await evaluate(`JSON.stringify({
      rows: document.querySelectorAll("table.feed tbody tr[data-token]").length,
      notice: (document.querySelector("[data-testid=notice]") || {}).textContent || "",
      emptyGone: !document.querySelector("[data-testid=empty-state]"),
    })`),
  );
  check("the feed then shows every token of the sample", after.rows === expectRows && after.emptyGone, after);
  check("and every screen says it is SYNTHETIC DATA", /SYNTHETIC DATA/.test(after.notice), after.notice);
  await shot("0-first-run-loaded");
  const again = await evaluate(`window.memelens.loadSample({}).then((r) => JSON.stringify(r))`);
  check(
    "pressing it again is impossible: the app refuses to add the sample to a database that now has data",
    again === JSON.stringify({ ok: false, error: "this database already holds data; the sample is only loaded into an empty one" }),
    again,
  );
}

async function standardChecks() {
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
  check(
    "window.memelens has exactly the 11 channels",
    JSON.stringify(facts.api) === JSON.stringify(["engineCancel", "engineCheck", "engineInstall", "engineRun", "engineStatus", "feed", "loadSample", "overview", "smart", "token", "wallet"]),
    facts.api,
  );

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

  const lines = appCommandLines();
  check("the app is running its renderer as a separate process (--type=renderer)", lines.some((l) => l.includes("--type=renderer")), lines.length);
  if (process.argv.includes("--no-sandbox")) console.log("SKIP  no process runs with --no-sandbox (this host needs the flag for the whole run)");
  else check("no process of the app runs with --no-sandbox", lines.length > 0 && !lines.some((l) => l.includes("no-sandbox")), lines.filter((l) => l.includes("no-sandbox")));

  // What a keyboard or screen-reader user depends on: one main landmark around the notice and the screen (not the navigation),
  // a skip link as the first stop, and focus that follows the person to the screen they opened.
  const structure = JSON.parse(
    await evaluate(`JSON.stringify((() => {
      const mains = [...document.querySelectorAll("main")];
      const main = mains[0];
      const skip = document.querySelector("a[data-testid=skip-link]");
      const stops = [...document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")].filter((e) => !e.disabled && e.tabIndex >= 0 && !e.closest("[hidden]"));
      return {
        mains: mains.length,
        noticeInside: Boolean(main && main.querySelector("[data-testid=notice]")),
        screenInside: Boolean(main && main.querySelector(".content")),
        navInside: Boolean(main && main.querySelector("nav")),
        skipText: skip ? skip.textContent.trim() : null,
        skipIsFirstStop: stops[0] === skip,
        headerIsBanner: Boolean(document.querySelector("body header.topbar") && !document.querySelector("main header")),
      };
    })())`),
  );
  check("the page has one main landmark that holds the data notice and the screen, and not the navigation", structure.mains === 1 && structure.noticeInside && structure.screenInside && !structure.navInside && structure.headerIsBanner, structure);
  check("the first stop for the keyboard is a 'Skip to content' link", structure.skipText === "Skip to content" && structure.skipIsFirstStop, structure);
  await evaluate(`document.querySelector("a[data-testid=skip-link]").click()`);
  const skipped = await evaluate(`document.activeElement === document.querySelector("main")`);
  check("using the skip link puts focus on the main area", skipped === true, skipped);

  await shot("1-feed");
  await evaluate(`[...document.querySelectorAll(".rail-item")].find((b) => b.textContent.includes("Smart")).click()`);
  await waitSel("table.smart-ranked");
  const landed = JSON.parse(await evaluate(`JSON.stringify({ tag: document.activeElement.tagName, text: document.activeElement.textContent })`));
  check("opening another screen moves focus to its heading, so a screen reader announces where it is", landed.tag === "H1" && landed.text === "Smart money", landed);
  const ranked = await text("table.smart-ranked tbody tr:first-child");
  check("smart money ranks alice first with +0.005 SOL", /alice/.test(ranked) && /\+0\.005 SOL/.test(ranked), ranked);
  await shot("2-smart-money");
  await evaluate(`document.querySelector("table.smart-ranked button.wallet").click()`);
  await waitSel(".wallet-panel[data-wallet='alice']");
  const wallet = await text(".wallet-panel");
  check("alice's wallet page shows realised +0.005 SOL and 10 trades", /Realised\s*\+0\.005 SOL/.test(wallet) && /10 trades/.test(wallet), wallet.slice(0, 160));
  await shot("3-wallet-alice");

  // The Backtest screen, with no engine installed: it says so, and the Run button is off with the reason beside it.
  await evaluate(`[...document.querySelectorAll(".rail-item")].find((b) => b.textContent.includes("Backtest")).click()`);
  await until(() => evaluate(`document.querySelector("h1").textContent === "Backtest"`), "the Backtest screen to open", 10_000);
  const bt = JSON.parse(
    await evaluate(`JSON.stringify({
      state: (document.querySelector("[data-testid=engine-state]") || {}).textContent || null,
      runDisabled: (([...document.querySelectorAll("form.bt-form button")].find((b) => b.textContent.trim() === "Run backtest")) || {}).disabled,
      hasCheck: [...document.querySelectorAll(".engine-panel button")].some((b) => b.textContent.trim() === "Check for update"),
      text: (document.querySelector(".bt") || {}).textContent || "",
    })`),
  );
  check(
    "the Backtest screen says no engine is installed, and its Run button is off with the reason",
    bt.state === "No engine is installed" && bt.runDisabled === true && /No engine is installed, so a backtest cannot run\./.test(bt.text),
    bt,
  );
  // This build knows where engines are published, so the screen offers the update check (it is not pressed here: no network).
  check(
    "the Backtest screen offers Check for update, and says to use it",
    bt.hasCheck === true && /Use Check for update to download one\./.test(bt.text),
    { hasCheck: bt.hasCheck },
  );
  await shot("4-backtest");

  if (process.argv.includes("--live-engine")) {
    // The whole product path through the screen, on this machine, against the real release host: find the published engine,
    // install it (download, signature, size and hash, self-test), run a backtest on the app's database, read the result.
    const clickButton = (label) =>
      evaluate(`(() => { const b = [...document.querySelectorAll(".bt button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const panel = () => text(".engine-panel");
    // React controls these fields, so a value has to be set through the native setter and announced with an input event.
    const setField = (id, value, kind) =>
      evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); const set = Object.getOwnPropertyDescriptor(window.${kind}.prototype, "value").set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return el.value; })()`);

    await until(() => clickButton("Check for update"), "the Check for update button to be pressable", 30_000);
    const found = await until(async () => {
      const t = await panel();
      return /is available\.|latest engine|older than yours|could not|not signed|not valid|nothing was installed|not set up/i.test(t) ? t : false;
    }, "the update check to answer", 180_000);
    const version = /Version (\S+) is available\./.exec(found)?.[1];
    check("the update check finds the published engine", version !== undefined, found.slice(0, 300));
    if (version !== undefined) console.log(`INFO  the update check offered engine ${version}`);
    if (version !== undefined) {
      await until(() => clickButton(`Install version ${version}`), "the Install button to be pressable", 30_000);
      const installed = await until(async () => {
        const t = await panel();
        return /Installed engine \S+\.|could not|not signed|not valid|failed its self-test|nothing was installed/i.test(t) ? t : false;
      }, "the install to finish", 240_000);
      check("the engine installs from the release host", new RegExp(`Installed engine ${version.replace(/\./g, "\\.")}\\.`).test(installed), installed.slice(0, 300));
      const state = await until(async () => {
        const t = await text("[data-testid=engine-state]");
        return t.startsWith("Engine ") ? t : false;
      }, "the engine state to show the installed version", 30_000);
      check("the screen then shows the installed version", state.startsWith(`Engine ${version} is installed`), state);
      console.log(`INFO  the screen says: ${state}`);
      if (engineRoot !== undefined) {
        const dir = join(engineRoot, "versions", version);
        const present = existsSync(join(dir, "memelens-sidecar.exe")) && existsSync(join(dir, "manifest.json"));
        check("the engine is in the app's own per-user folder (%LOCALAPPDATA%\\MemeLens\\sidecar), not a folder chosen for the test", present, dir);
        let current = null;
        try {
          current = JSON.parse(readFileSync(join(engineRoot, "current.json"), "utf8"));
        } catch {}
        check("current.json in that folder names the installed version", current?.version === version, current);
        console.log(`INFO  engine folder: ${engineRoot}`);
      }

      await setField("bt-wallets", "alice carol", "HTMLTextAreaElement");
      await setField("bt-positionSize", "0.001", "HTMLInputElement");
      await until(() => clickButton("Run backtest"), "the Run backtest button to be pressable", 30_000);
      const outcome = await until(async () => {
        const result = await text("section.bt-result");
        if (result) return { result };
        const alerts = await evaluate(`[...document.querySelectorAll(".bt [role=alert]")].map((e) => e.textContent).join(" | ")`);
        return alerts ? { alerts } : false;
      }, "the backtest to finish", 180_000);
      const entered = /Entered\s*(\d+)/.exec(outcome.result ?? "")?.[1];
      check("a backtest runs on the app's own database and enters positions", entered !== undefined && Number(entered) > 0, outcome.alerts ?? (outcome.result ?? "").slice(0, 300));
      console.log(`INFO  the backtest entered ${entered ?? "no"} positions; the result says: ${(outcome.result ?? outcome.alerts ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
      check("the result names the engine that produced it", new RegExp(`Engine ${version.replace(/\./g, "\\.")}`).test(outcome.result ?? ""), (outcome.result ?? "").slice(0, 200));
      await shot("5-backtest-result");
    }
  }
}

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

  if (firstRun) await firstRunChecks();
  else await standardChecks();
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
