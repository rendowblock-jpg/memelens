// Builds apps/desktop/dist/preview: the built renderer plus a stand-in for window.memelens whose answers were
// produced by the real handler over the sample fixture. For inspecting the design with browser tools only; it is
// never shipped, and it is not the app (no Electron, no CSP). usage: node --import tsx scripts/preview-build.ts
//
// With MEMELENS_SIDECAR_BIN set (a built engine), the Backtest result is a REAL report from that engine over the sample;
// without it the result state is not available in the preview. Every screen state is reachable by URL:
//   ?db=empty                      the first-run screen (loadSample then fills the database)
//   ?go=backtest&engine=none|ready|problem   the Backtest screen with no engine / an installed one / a broken one
//   ?go=backtest&engine=ready&run=1          fills the form with the values the packaged check uses and runs it
//   ?go=backtest&engine=ready&run=1&fail=1   the same, but the run fails
//   ?go=tok1 | ?go=smart | ?go=wallet-alice  as before
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplayAdapter, Store, ingest, parseFixture } from "@memelens/data";
import { handle, handleEngine } from "@memelens/service";
import { activate, binaryName, currentPlatform, SidecarClient, SidecarManager } from "@memelens/sidecar";
import { createEngineService } from "../apps/desktop/src/main/engine";
import { buildSpec, DEFAULT_FORM } from "../apps/desktop/src/renderer/backtest";
import { MIN_CLOSED_TOKENS } from "../apps/desktop/src/renderer/controller";
import { smartWindow, type SmartSpan } from "../apps/desktop/src/renderer/model";
import { quoteFor } from "../apps/desktop/src/renderer/quote";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "apps/desktop/dist/preview");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "apps/desktop/dist/renderer"), out, { recursive: true });

const fixture = JSON.parse(readFileSync(join(root, "packages/data/fixtures/sample.json"), "utf8"));
const store = Store.open(":memory:");
await ingest(store, new ReplayAdapter(parseFixture(fixture)));
const chain: string = fixture.chain;
const latest = store.latestTime(chain)!;

const replies: Record<string, unknown> = {};
const key = (channel: string, request: object): string => `${channel}|${JSON.stringify(request)}`;
const ask = (channel: string, request: object): void => {
  replies[key(channel, request)] = handle(store, channel, request);
};
ask("overview", {});
ask("feed", { chain });
for (const t of fixture.tokens) ask("token", { chain, token: t.token });
for (const w of new Set<string>(fixture.trades.map((t: { wallet: string }) => t.wallet))) ask("wallet", { chain, wallet: w });
for (const span of ["1d", "7d", "30d", "all"] as SmartSpan[]) ask("smart", { chain, ...smartWindow(latest, span), minClosed: MIN_CLOSED_TOKENS });
store.close();

/** A real engine run over the sample, or null when no engine binary was given. */
async function bakeReport(): Promise<unknown> {
  const bin = process.env["MEMELENS_SIDECAR_BIN"];
  if (bin === undefined || !existsSync(bin)) return null;
  const work = mkdtempSync(join(tmpdir(), "memelens-preview-"));
  try {
    const probe = await SidecarClient.start({ command: bin, helloTimeoutMs: 20_000 });
    const version = probe.info.engineVersion;
    await probe.close();
    const dir = join(work, "engine", "versions", version);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, binaryName(currentPlatform()));
    copyFileSync(bin, target);
    const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifestVersion: 1, engineVersion: version, protocol: 1, file: binaryName(currentPlatform()), size: statSync(target).size, sha256 }));
    activate(join(work, "engine"), version);
    const path = join(work, "app.sqlite");
    const file = Store.open(path);
    await ingest(file, new ReplayAdapter(parseFixture(fixture)));
    const manager = new SidecarManager({ root: join(work, "engine"), dbPath: path, chain, idleMs: 5000 });
    try {
      const built = buildSpec({ ...DEFAULT_FORM, wallets: "alice carol", positionSize: "0.001" }, latest, quoteFor(chain));
      if (!built.ok) throw new Error(JSON.stringify(built.errors));
      const reply = await handleEngine(createEngineService({ manager, log: () => {} }), "engineRun", { spec: built.spec, chain });
      if (!reply.ok) throw new Error(reply.error);
      return reply.data;
    } finally {
      await manager.shutdown();
      file.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
const report = await bakeReport();

const shim = `// PREVIEW ONLY. Answers were produced by the real handler over the sample fixture.
const replies = ${JSON.stringify(replies)};
const REPORT = ${JSON.stringify(report)};
const SAMPLE = ${JSON.stringify({ chain, tokens: fixture.tokens.length, trades: fixture.trades.length })};
const sorted = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
const ask = (channel) => async (request) => replies[channel + "|" + JSON.stringify(request)] ?? { ok: false, error: "not in the preview data" };
const q = new URLSearchParams(location.search);
const go = q.get("go");
const emptyDb = q.get("db") === "empty";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const when = (sel, then) => { const t = setInterval(() => { const el = document.querySelector(sel); if (el) { clearInterval(t); then(el); } }, 50); };
const rail = (name) => [...document.querySelectorAll(".rail-item")].find((b) => b.textContent.includes(name));
const setField = (id, value) => {
  const el = document.getElementById(id);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
if (go === "tok1") when(".token-panel .gauge", () => document.querySelector('tr[data-token="TOK1"] button').click());
else if (go === "smart" || (go && go.startsWith("wallet-"))) when(".rail-item", () => {
  rail("Smart").click();
  if (go.startsWith("wallet-")) when("table.smart-ranked", () => [...document.querySelectorAll("button.wallet")].find((x) => x.textContent === go.slice(7)).click());
});
else if (go === "backtest") when(".rail-item", () => {
  rail("Backtest").click();
  if (q.get("run") === "1") when("#bt-wallets", async () => {
    await wait(300);
    setField("bt-wallets", "alice carol");
    setField("bt-positionSize", "0.001");
    await wait(100);
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Run backtest").click();
  });
});

// The engine as the main process would report it. Checking for an update offers 0.1.2; installing it takes a moment.
let loaded = !emptyDb;
let engine = q.get("engine") ?? "none";
let offered = null;
const status = () => ({
  installed: engine === "ready" ? "0.1.2" : null,
  running: false,
  busy: false,
  problem: engine === "problem" ? "The installed engine did not pass its check, so it was not started. Install it again with Check for update." : null,
  canUpdate: true,
  offered,
});
const ok = (data) => ({ ok: true, data });
const api = {
  overview: async (request) => (loaded ? ask("overview")(request) : ok({ chains: [] })),
  feed: ask("feed"), token: ask("token"), wallet: ask("wallet"), smart: ask("smart"),
  loadSample: async () => { await wait(500); loaded = true; return ok(SAMPLE); },
  engineStatus: async () => ok(status()),
  engineCheck: async () => { await wait(400); offered = "0.1.2"; return ok({ kind: "available", version: "0.1.2" }); },
  engineInstall: async () => { await wait(900); engine = "ready"; offered = null; return ok({ version: "0.1.2" }); },
  engineCancel: async () => ok({ cancelled: false }),
  engineRun: async () => {
    await wait(900);
    if (q.get("fail") === "1") return { ok: false, error: "The engine stopped before it answered. Nothing was changed." };
    return REPORT === null ? { ok: false, error: "The preview was built without an engine, so there is no real report to show." } : ok(REPORT);
  },
};
window.memelens = Object.freeze(api);
`;
writeFileSync(join(out, "preview-data.js"), shim);
const html = readFileSync(join(out, "index.html"), "utf8").replace('<script type="module" src="main.js">', '<script src="preview-data.js"></script>\n    <script type="module" src="main.js">');
writeFileSync(join(out, "index.html"), html);
console.log("preview built:", out, Object.keys(replies).length, "replies");
