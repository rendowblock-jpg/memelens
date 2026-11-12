import { join } from "node:path";
import { app } from "electron";
import { launch } from "./app";
import { sidecarSetup } from "./engine";

// A smoke test entry: starts the real app against a real database, then looks at the page from the inside.
// It is a separate entry point (bundled to dist/smoke.cjs) so nothing test-only sits in the shipped main.cjs.

const WAIT_FOR_PAGE = `new Promise((resolve) => {
  const timer = setInterval(() => {
    if (document.body.dataset.state) { clearInterval(timer); resolve(document.body.dataset.state); }
  }, 50);
})`;

// Runs in the page's own world, so it sees exactly what the app's own scripts see.
const PROBES = `(async () => {
  const r = {};
  r.require = typeof require; r.process = typeof process; r.module = typeof module; r.buffer = typeof Buffer;
  r.api = Object.keys(window.memelens).sort();
  r.windowOpenDenied = window.open("https://example.com/") === null;
  try { await fetch("https://example.com/"); r.fetch = "allowed"; } catch { r.fetch = "blocked"; }
  try { new Function("return 1")(); r.eval = "allowed"; } catch { r.eval = "blocked"; }
  const s = document.createElement("script"); s.textContent = "window.__inline = true"; document.head.appendChild(s);
  r.inline = window.__inline === true ? "ran" : "blocked";
  r.notification = await Notification.requestPermission();
  r.badRequest = await window.memelens.overview({ chain: "x" });
  const spec = { version: 1, from: 0, to: 10000000, strategy: { kind: "follow-wallets", wallets: ["alice"], latencyMs: 0, positionQuote: "1000000", takeProfitBps: 5000, stopLossBps: 2000, maxHoldMs: 3600000 }, costs: { feeBps: 30, slippageBps: 100 } };
  r.engineStatus = await window.memelens.engineStatus({});
  r.engineRun = await window.memelens.engineRun({ spec });
  r.engineRunPath = await window.memelens.engineRun({ spec, path: "C:\\\\x\\\\other.sqlite" });
  r.engineCheck = await window.memelens.engineCheck({});
  r.engineInstall = await window.memelens.engineInstall({});
  r.engineCancel = await window.memelens.engineCancel({});
  r.loadSampleRefused = await window.memelens.loadSample({});
  r.loadSamplePayload = await window.memelens.loadSample({ path: "C:\\\\x\\\\other.sqlite" });
  r.unknownToken = await window.memelens.token({ chain: "no-such-chain", token: "../../etc/passwd" });
  location.href = "https://example.com/";
  await new Promise((res) => setTimeout(res, 500));
  r.origin = location.origin;
  return JSON.stringify(r);
})()`;

// Presses the Backtest rail button and reads what the screen says. Runs before PROBES, which ends by navigating away.
const OPEN_BACKTEST = `(async () => {
  const rail = [...document.querySelectorAll("nav.rail button")].find((b) => b.textContent.trim() === "Backtest");
  if (!rail) return JSON.stringify({ railButton: false });
  rail.click();
  // The screen is mounted (hidden) from the start, so wait for the click's effect, not for the element: the title changes.
  for (let i = 0; i < 100 && (document.querySelector("h1") || {}).textContent !== "Backtest"; i++) await new Promise((r) => setTimeout(r, 50));
  const screen = document.querySelector(".bt");
  const run = [...document.querySelectorAll("form.bt-form button")].find((b) => b.textContent.trim() === "Run backtest");
  return JSON.stringify({
    railButton: true,
    title: (document.querySelector("h1") || {}).textContent || "",
    visible: Boolean(screen) && !screen.closest("[hidden]"),
    state: (document.querySelector("[data-testid=engine-state]") || {}).textContent || null,
    runDisabled: run ? run.disabled : null,
    text: screen ? screen.textContent : "",
  });
})()`;

interface Check {
  name: string;
  ok: boolean;
  got?: unknown;
}

async function run(): Promise<number> {
  const dbPath = process.env["MEMELENS_DB"];
  if (!dbPath) throw new Error("MEMELENS_DB must name the database to open");
  const expectRows = Number(process.env["MEMELENS_EXPECT_ROWS"] ?? "NaN");

  const { window } = await launch({
    dbPath,
    sidecar: sidecarSetup(process.env, app.getPath("home")),
    rendererRoot: join(__dirname, "renderer"),
    preloadPath: join(__dirname, "preload.cjs"),
    devTools: false,
    log: (line) => console.error(`[app] ${line}`),
  });
  const contents = window.webContents;

  const state = (await contents.executeJavaScript(WAIT_FOR_PAGE)) as string;
  // What the real screen shows, read from its DOM: the number of token rows, the data notice and the detail panel.
  const page = JSON.parse(
    (await contents.executeJavaScript(`JSON.stringify({
      rows: document.querySelectorAll("table.feed tbody tr[data-token]").length,
      notice: (document.querySelector("[data-testid=notice]") || {}).textContent || "",
      panel: Boolean(document.querySelector("section.token-panel")),
      gauge: Boolean(document.querySelector("section.token-panel .gauge")),
      bar: document.querySelectorAll("section.token-panel svg[aria-label^='Risk by signal'] .seg-track").length,
    })`)) as string,
  ) as { rows: number; notice: string; panel: boolean; gauge: boolean; bar: number };
  // The Backtest screen, opened by pressing its rail button, with no engine installed (the smoke script gives the app an empty engine folder).
  const backtest = JSON.parse((await contents.executeJavaScript(OPEN_BACKTEST)) as string) as Record<string, any>;
  const probes = JSON.parse((await contents.executeJavaScript(PROBES)) as string) as Record<string, any>;

  // Present at run time in Electron 45 but missing from its typings; if it ever goes away this throws and the smoke fails.
  const effective = (contents as unknown as { getLastWebPreferences(): { sandbox?: boolean } }).getLastWebPreferences();

  const checks: Check[] = [
    { name: "page script finished without error", ok: state === "done", got: state },
    { name: "the feed shows the expected number of tokens", ok: page.rows === expectRows, got: page.rows },
    { name: "the notice names the chain and warns that the data is synthetic", ok: /synthetic/i.test(page.notice) && /SYNTHETIC DATA/.test(page.notice), got: page.notice },
    { name: "the first token's panel is open with its risk gauge and a bar of 10 signals", ok: page.panel && page.gauge && page.bar === 10, got: page },
    { name: "page has no require/process/module/Buffer", ok: [probes["require"], probes["process"], probes["module"], probes["buffer"]].every((t) => t === "undefined"), got: [probes["require"], probes["process"], probes["module"], probes["buffer"]] },
    { name: "window.memelens has exactly the 11 channels", ok: JSON.stringify(probes["api"]) === JSON.stringify(["engineCancel", "engineCheck", "engineInstall", "engineRun", "engineStatus", "feed", "loadSample", "overview", "smart", "token", "wallet"]), got: probes["api"] },
    { name: "the sample is never added to a database that already has data", ok: JSON.stringify(probes["loadSampleRefused"]) === JSON.stringify({ ok: false, error: "this database already holds data; the sample is only loaded into an empty one" }), got: probes["loadSampleRefused"] },
    { name: "the sample channel takes no payload from the window", ok: JSON.stringify(probes["loadSamplePayload"]) === JSON.stringify({ ok: false, error: "loadSample: takes no payload" }), got: probes["loadSamplePayload"] },
    { name: "with no engine installed the status says so, and that this build cannot update", ok: JSON.stringify(probes["engineStatus"]) === JSON.stringify({ ok: true, data: { installed: null, running: false, busy: false, problem: null, canUpdate: false, offered: null } }), got: probes["engineStatus"] },
    { name: "a backtest without an engine says the engine is not installed", ok: JSON.stringify(probes["engineRun"]) === JSON.stringify({ ok: false, error: "the backtest engine is not installed" }), got: probes["engineRun"] },
    { name: "the window cannot choose the database: an extra field is refused", ok: JSON.stringify(probes["engineRunPath"]) === JSON.stringify({ ok: false, error: 'engineRun: unknown field "path"' }), got: probes["engineRunPath"] },
    { name: "update check and install say this build has no release source", ok: probes["engineCheck"]?.error === "this build is not set up to fetch engine releases" && probes["engineInstall"]?.error === "this build is not set up to fetch engine releases", got: [probes["engineCheck"], probes["engineInstall"]] },
    { name: "cancel with nothing running is a plain no", ok: JSON.stringify(probes["engineCancel"]) === JSON.stringify({ ok: true, data: { cancelled: false } }), got: probes["engineCancel"] },
    { name: "window.open is denied", ok: probes["windowOpenDenied"] === true, got: probes["windowOpenDenied"] },
    { name: "network fetch is blocked", ok: probes["fetch"] === "blocked", got: probes["fetch"] },
    { name: "eval is blocked", ok: probes["eval"] === "blocked", got: probes["eval"] },
    { name: "inline script is blocked", ok: probes["inline"] === "blocked", got: probes["inline"] },
    { name: "notification permission is not granted", ok: probes["notification"] !== "granted", got: probes["notification"] },
    { name: "a bad request gets a readable error, not a crash", ok: JSON.stringify(probes["badRequest"]) === JSON.stringify({ ok: false, error: 'overview: unknown field "chain"' }), got: probes["badRequest"] },
    { name: "an unknown chain gets an error reply with no path or stack", ok: probes["unknownToken"]?.ok === false && typeof probes["unknownToken"]?.error === "string" && !/\n|\bat |\/root\//.test(probes["unknownToken"].error), got: probes["unknownToken"] },
    { name: "the window's sandbox preference is on", ok: effective.sandbox === true, got: effective.sandbox },
    ...(process.env["MEMELENS_EXPECT_SANDBOX"] === "1"
      ? [{ name: "the app was started without --no-sandbox", ok: !app.commandLine.hasSwitch("no-sandbox"), got: app.commandLine.hasSwitch("no-sandbox") }]
      : []),
    { name: "the Backtest rail button opens a screen titled Backtest", ok: backtest["railButton"] === true && backtest["title"] === "Backtest" && backtest["visible"] === true, got: backtest },
    { name: "the Backtest screen says no engine is installed and cannot update", ok: backtest["state"] === "No engine is installed" && /This build has no source for engine updates yet/.test(backtest["text"]), got: backtest["state"] },
    { name: "the Run backtest button is off and says why", ok: backtest["runDisabled"] === true && /No engine is installed, so a backtest cannot run\./.test(backtest["text"]), got: backtest["runDisabled"] },
    { name: "navigating away is blocked: still on app://memelens", ok: probes["origin"] === "app://memelens", got: probes["origin"] },
  ];

  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : `  (got ${JSON.stringify(c.got)})`}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`SMOKE ${failed === 0 ? "OK" : "FAILED"}: ${checks.length - failed}/${checks.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

const timer = setTimeout(() => {
  console.error("SMOKE TIMEOUT after 30 s");
  app.exit(2);
}, 30_000);

run()
  .then((code) => app.exit(code))
  .catch((e: unknown) => {
    console.error("SMOKE ERROR:", e);
    app.exit(3);
  })
  .finally(() => clearTimeout(timer));
