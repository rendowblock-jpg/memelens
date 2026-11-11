import { join } from "node:path";
import { app } from "electron";
import { launch } from "./app";

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
  r.unknownToken = await window.memelens.token({ chain: "no-such-chain", token: "../../etc/passwd" });
  location.href = "https://example.com/";
  await new Promise((res) => setTimeout(res, 500));
  r.origin = location.origin;
  return JSON.stringify(r);
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
    rendererRoot: join(__dirname, "renderer"),
    preloadPath: join(__dirname, "preload.cjs"),
    devTools: false,
    log: (line) => console.error(`[app] ${line}`),
  });
  const contents = window.webContents;

  const state = (await contents.executeJavaScript(WAIT_FOR_PAGE)) as string;
  const page = JSON.parse((await contents.executeJavaScript(`document.getElementById("out").textContent`)) as string) as {
    overview: { chains: unknown[] };
    feed: { rows: unknown[] } | null;
  };
  const probes = JSON.parse((await contents.executeJavaScript(PROBES)) as string) as Record<string, any>;

  const checks: Check[] = [
    { name: "page script finished without error", ok: state === "done", got: state },
    { name: "overview came through the real IPC path", ok: page.overview.chains.length === 1, got: page.overview.chains.length },
    { name: "feed has the expected number of tokens", ok: page.feed?.rows.length === expectRows, got: page.feed?.rows.length },
    { name: "page has no require/process/module/Buffer", ok: [probes["require"], probes["process"], probes["module"], probes["buffer"]].every((t) => t === "undefined"), got: [probes["require"], probes["process"], probes["module"], probes["buffer"]] },
    { name: "window.memelens has exactly the 5 channels", ok: JSON.stringify(probes["api"]) === JSON.stringify(["feed", "overview", "smart", "token", "wallet"]), got: probes["api"] },
    { name: "window.open is denied", ok: probes["windowOpenDenied"] === true, got: probes["windowOpenDenied"] },
    { name: "network fetch is blocked", ok: probes["fetch"] === "blocked", got: probes["fetch"] },
    { name: "eval is blocked", ok: probes["eval"] === "blocked", got: probes["eval"] },
    { name: "inline script is blocked", ok: probes["inline"] === "blocked", got: probes["inline"] },
    { name: "notification permission is not granted", ok: probes["notification"] !== "granted", got: probes["notification"] },
    { name: "a bad request gets a readable error, not a crash", ok: JSON.stringify(probes["badRequest"]) === JSON.stringify({ ok: false, error: 'overview: unknown field "chain"' }), got: probes["badRequest"] },
    { name: "an unknown chain gets an error reply with no path or stack", ok: probes["unknownToken"]?.ok === false && typeof probes["unknownToken"]?.error === "string" && !/\n|\bat |\/root\//.test(probes["unknownToken"].error), got: probes["unknownToken"] },
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
