// Measures one thing on one screen state of the preview build, in a real Chromium, and prints it as JSON. It is how a
// claim made by looking at a picture gets checked by numbers (see docs/ui-readings/).
//
//   xvfb-run -a node scripts/probe-page.mjs --path "/?go=backtest&engine=ready" --size 1366x728 [--act click:SEL ...] --eval "JS expression" [--eval ...]
//
// The expression runs in the page and should return a JSON-serialisable value (or a JSON string). Serves
// apps/desktop/dist/preview (run scripts/preview-build.ts first). Uses the same empty Electron window as the audit.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const one = (name, fallback) => all(name)[0] ?? fallback;
const dir = resolve(one("dir", join(root, "apps/desktop/dist/preview")));
const path = one("path", "/");
const [width, height] = one("size", "1366x728").split("x").map(Number);
const expressions = all("eval");
// --act runs real input, in order, before the expressions: click:SELECTOR (a real mouse press on the element's centre),
// focus:SELECTOR (script focus), key:Enter|Tab|... (a real key press), wait:MS.
const actions = all("act");
if (expressions.length === 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
  console.error('usage: node scripts/probe-page.mjs --path "/?go=backtest" --size 1366x728 --eval "JS" [--eval "JS" ...]');
  process.exit(2);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const file = normalize(join(dir, p === "/" ? "index.html" : p));
  try {
    if (!file.startsWith(dir)) throw new Error("outside");
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const cdpPort = 9800 + Math.floor(Math.random() * 150);
const electron = createRequire(join(root, "package.json"))("electron");
const child = spawn(electron, ["--no-sandbox", join(here, "audit-shell.cjs")], { env: { ...process.env, AUDIT_PORT: String(cdpPort) }, stdio: "ignore" });
const stop = () => {
  try {
    child.kill("SIGKILL");
  } catch {}
  server.close();
};
process.on("exit", stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let nextId = 1;
const pending = new Map();
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 30_000);
  });

let code = 0;
try {
  let target;
  for (let i = 0; i < 200 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === "page");
    } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("the Chromium window did not appear");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error("DevTools websocket failed")))));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (p) (pending.delete(msg.id), msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result));
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${server.address().port}${path}` });
  for (let i = 0; i < 200; i++) {
    const r = await cdp("Runtime.evaluate", { expression: "Boolean(document.querySelector('main') && document.querySelector('main').textContent.trim().length > 20 && !document.querySelector('.skeleton'))", returnByValue: true });
    if (r.result.value) break;
    await sleep(100);
  }
  await sleep(500);
  const KEYS = { Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " } };
  for (const action of actions) {
    const at = action.indexOf(":");
    const kind = action.slice(0, at);
    const arg = action.slice(at + 1);
    if (kind === "wait") await sleep(Number(arg));
    else if (kind === "focus") await cdp("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(arg)}).focus()` });
    else if (kind === "key") {
      const k = KEYS[arg];
      if (k === undefined) throw new Error(`unknown key ${arg}`);
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k });
    } else if (kind === "click") {
      const r = await cdp("Runtime.evaluate", { expression: `(() => { const e = document.querySelector(${JSON.stringify(arg)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`, returnByValue: true });
      if (r.result.value === null) throw new Error(`nothing matches ${arg}`);
      const { x, y } = r.result.value;
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    } else throw new Error(`unknown action ${action}`);
    await sleep(400);
  }
  for (const expression of expressions) {
    const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    console.log(typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value));
  }
} catch (e) {
  console.log(`FAIL ${e.message}`);
  code = 1;
}
stop();
process.exit(code);
