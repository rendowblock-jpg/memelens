import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { ReplayAdapter, Store, ingest, parseFixture } from "@memelens/data";
import { ENGINE_CHANNELS, handle, handleEngine, type Api } from "@memelens/service";
import { activate, binaryName, currentPlatform, SidecarClient, SidecarManager, type WireWalletTrade } from "@memelens/sidecar";
import { createEngineService } from "../main/engine";
import { blockedReason, buildSpec, DEFAULT_FORM } from "./backtest";
import { BacktestResult } from "./backtest-views";
import { loadEngineStatus, loadOverview, runEngineBacktest } from "./controller";
import { quoteFor } from "./quote";

// The whole screen pipeline on the REAL engine: the form's text becomes a spec (backtest.ts), it travels through the real
// request handler (handleEngine), the engine service and the manager to a real engine process that reads the app's own
// SQLite file, and the report it returns is drawn by the real view. Skipped without MEMELENS_SIDECAR_BIN, so the public
// CI needs no private source; the private repository's pipeline runs it on Windows and Linux.
const BIN = process.env["MEMELENS_SIDECAR_BIN"];
const run = BIN === undefined ? describe.skip : describe;

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "memelens-ui-e2e-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Puts the real engine into a fresh install folder, verified by a manifest, and makes it current. */
async function installReal(): Promise<string> {
  const probe = await SidecarClient.start({ command: BIN!, helloTimeoutMs: 20_000 });
  const version = probe.info.engineVersion;
  await probe.close();
  const root = tmp();
  const dir = join(root, "versions", version);
  mkdirSync(dir, { recursive: true });
  const platform = currentPlatform();
  const target = join(dir, binaryName(platform));
  copyFileSync(BIN!, target);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifestVersion: 1, engineVersion: version, protocol: 1, file: binaryName(platform), size: statSync(target).size, sha256: sha(readFileSync(target)) }));
  activate(root, version);
  return root;
}

/** The window's api over the real engine handler, as the preload script would give it. */
function windowApi(service: ReturnType<typeof createEngineService>, store: Store): Api {
  const api: Record<string, (request: unknown) => Promise<unknown>> = {};
  for (const channel of ENGINE_CHANNELS) api[channel] = async (request) => handleEngine(service, channel, request);
  api["overview"] = async (request) => handle(store, "overview", request);
  return api as unknown as Api;
}

const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/data/fixtures/sample.json", import.meta.url)), "utf8"));
const SOL = quoteFor("solana");

function plain(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

run("the backtest screen on the real engine", () => {
  it("turns the form into a report the view can draw, and the report equals the engine's own answer for the same trades", async () => {
    const root = await installReal();
    const path = join(tmp(), "app.sqlite");
    const store = Store.open(path);
    const manager = new SidecarManager({ root, dbPath: path, chain: FIXTURE.chain, idleMs: 5000 });
    try {
      await ingest(store, new ReplayAdapter(parseFixture(FIXTURE)));
      const api = windowApi(createEngineService({ manager, log: () => {} }), store);

      const status = await loadEngineStatus(api);
      if (status.state !== "ok") throw new Error(status.message);
      expect(status.data.installed).not.toBeNull();
      expect(status.data.canUpdate).toBe(false);
      expect(blockedReason(status.data, null, null)).toBeNull();

      const overview = await loadOverview(api);
      if (overview.state !== "ok") throw new Error(overview.message);
      const latest = overview.data.chains.find((c) => c.chain === FIXTURE.chain)!.latestTime!;

      const built = buildSpec({ ...DEFAULT_FORM, wallets: "alice\ncarol", positionSize: "0.001", takeProfitPct: "50", stopLossPct: "20", maxHoldHours: "1", feePct: "0.3", slippagePct: "1" }, latest, SOL);
      if (!built.ok) throw new Error(JSON.stringify(built.errors));

      const result = await runEngineBacktest(api, built.spec, FIXTURE.chain);
      if (result.state !== "ok") throw new Error(result.message);
      const report = result.data;
      expect(report.summary.entered).toBeGreaterThan(0); // not an empty comparison

      // The same spec and the same trades, given to the engine directly.
      const inline: WireWalletTrade[] = FIXTURE.trades.map((t: any) => ({ id: t.id, time: t.time, token: t.token, side: t.side, amount: t.amount, quote: t.quote, wallet: t.wallet }));
      const direct = await SidecarClient.start({ command: BIN!, helloTimeoutMs: 20_000 });
      try {
        expect(report).toEqual(await direct.backtest(built.spec, { source: "inline", trades: inline }));
      } finally {
        await direct.close();
      }

      const html = renderToStaticMarkup(<BacktestResult report={report} quote={SOL} />);
      expect(html).not.toContain("bt-empty");
      const rows = [...(/<table[^>]*aria-label="Backtest positions"[^>]*>(.*?)<\/table>/s.exec(html)?.[1] ?? "").matchAll(/<tr/g)].length - 1; // minus the header row
      expect(rows).toBe(Math.min(report.positions.length, 50));
      expect(plain(html)).toContain(`Engine ${report.engineVersion}`);
      expect(plain(html)).toContain(`${report.summary.entered} position`);
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it("says nothing was entered, instead of showing zeros, when no chosen wallet traded", async () => {
    const root = await installReal();
    const path = join(tmp(), "app.sqlite");
    const store = Store.open(path);
    const manager = new SidecarManager({ root, dbPath: path, chain: FIXTURE.chain });
    try {
      await ingest(store, new ReplayAdapter(parseFixture(FIXTURE)));
      const api = windowApi(createEngineService({ manager, log: () => {} }), store);
      const built = buildSpec({ ...DEFAULT_FORM, wallets: "nobody-at-all" }, 1_700_020_700_000, SOL);
      if (!built.ok) throw new Error(JSON.stringify(built.errors));
      const result = await runEngineBacktest(api, built.spec, FIXTURE.chain);
      if (result.state !== "ok") throw new Error(result.message);
      expect(result.data.summary.entered).toBe(0);
      const html = renderToStaticMarkup(<BacktestResult report={result.data} quote={SOL} />);
      expect(html).toContain('data-testid="bt-empty"');
      expect(plain(html)).toContain("Return on cost —");
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it("tells the window, in a fixed sentence, that the database could not be read", async () => {
    const root = await installReal();
    const manager = new SidecarManager({ root, dbPath: join(tmp(), "missing.sqlite"), chain: "x" });
    const store = Store.open(":memory:");
    try {
      const api = windowApi(createEngineService({ manager, log: () => {} }), store);
      const built = buildSpec({ ...DEFAULT_FORM, wallets: "alice" }, 1_700_020_700_000, SOL);
      if (!built.ok) throw new Error(JSON.stringify(built.errors));
      expect(await runEngineBacktest(api, built.spec)).toEqual({ state: "error", message: "the engine could not read the trade database" });
      // and the engine is still usable afterwards
      const status = await loadEngineStatus(api);
      expect(status).toMatchObject({ state: "ok", data: { problem: null } });
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it("says no engine is installed when the folder is empty", async () => {
    const store = Store.open(":memory:");
    const manager = new SidecarManager({ root: tmp(), dbPath: ":memory:", chain: "x" });
    try {
      const api = windowApi(createEngineService({ manager, log: () => {} }), store);
      const built = buildSpec({ ...DEFAULT_FORM, wallets: "alice" }, 1_700_020_700_000, SOL);
      if (!built.ok) throw new Error(JSON.stringify(built.errors));
      expect(await runEngineBacktest(api, built.spec)).toEqual({ state: "error", message: "the backtest engine is not installed" });
      const status = await loadEngineStatus(api);
      if (status.state !== "ok") throw new Error(status.message);
      expect(blockedReason(status.data, null, null)).toBe("No engine is installed, so a backtest cannot run.");
    } finally {
      await manager.shutdown();
      store.close();
    }
  });
});
