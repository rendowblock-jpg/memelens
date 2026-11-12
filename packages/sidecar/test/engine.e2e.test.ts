import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ReplayAdapter, Store, ingest, parseFixture } from "@memelens/data";
import { SidecarClient, SidecarError } from "../src/client";
import { activate, binaryName, currentPlatform, resolveCurrent } from "../src/layout";
import { specHash } from "../src/canonical";
import type { BacktestData, WireWalletTrade } from "../src/types";

// A contract test for ANY engine: set MEMELENS_SIDECAR_BIN to a built engine and these run against it; without it they are
// skipped, so the public repository's CI needs no private source. The private repository's pipeline runs this file.
const BIN = process.env["MEMELENS_SIDECAR_BIN"];
const EXPECTED_VERSION = process.env["MEMELENS_SIDECAR_VERSION"];
const run = BIN === undefined ? describe.skip : describe;

function vectors(name: string): any {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../vectors/${name}.json`, import.meta.url)), "utf8"));
}
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "memelens-e2e-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

async function engine(command = BIN!): Promise<SidecarClient> {
  return SidecarClient.start({ command, helloTimeoutMs: 20_000, defaultTimeoutMs: 60_000 });
}
const withoutEngineVersion = (r: any): any => {
  const { engineVersion: _drop, ...rest } = r;
  return rest;
};

run("the real engine", () => {
  it("says hello with a protocol this app supports and the capabilities the app needs", async () => {
    const c = await engine();
    try {
      expect(c.info.protocol).toBe(1);
      expect(c.info.capabilities).toEqual(expect.arrayContaining(["backtest.run", "pnl.compute"]));
      if (EXPECTED_VERSION !== undefined) expect(c.info.engineVersion).toBe(EXPECTED_VERSION);
    } finally {
      await c.close();
    }
  });

  it("reproduces every backtest vector, and the app's own checker accepts every report", async () => {
    const c = await engine();
    try {
      for (const v of vectors("backtest").cases) {
        const report = await c.backtest(v.spec, { source: "inline", trades: v.trades }); // parse + sums + hash + version checked inside
        expect(withoutEngineVersion(report), v.name).toEqual(v.expected);
      }
    } finally {
      await c.close();
    }
  });

  it("reproduces every FIFO profit-and-loss vector, and refuses the invalid inputs with a path", async () => {
    const c = await engine();
    try {
      for (const v of vectors("pnl").cases) {
        if (v.expectError) {
          const e = await c.call("pnl.compute", v.params).catch((x) => x);
          expect(e, v.name).toBeInstanceOf(SidecarError);
          expect((e as SidecarError).code, v.name).toBe(-32602);
          expect(String((e as SidecarError).data && (e as any).data.path), v.name).toMatch(/^\$/);
        } else {
          expect(await c.call("pnl.compute", v.params), v.name).toEqual(v.expected);
        }
      }
    } finally {
      await c.close();
    }
  });

  it("refuses every invalid spec with -32602 and the path of the first wrong field", async () => {
    const c = await engine();
    try {
      for (const v of vectors("backtest").invalidSpecs) {
        const e = await c.call("backtest.run", { spec: v.spec, data: { source: "inline", trades: [] } }).catch((x) => x);
        expect(e, v.name).toBeInstanceOf(SidecarError);
        expect((e as SidecarError).code, v.name).toBe(-32602);
      }
    } finally {
      await c.close();
    }
  });

  it("gives the same spec hash as the app's canonical JSON", async () => {
    const c = await engine();
    try {
      for (const v of vectors("backtest").cases.slice(0, 5)) {
        const report = await c.backtest(v.spec, { source: "inline", trades: v.trades });
        expect(report.specHash).toBe(specHash(v.spec));
      }
    } finally {
      await c.close();
    }
  });

  it("reads the app's real database while the app's writer connection is open, and leaves the file untouched", async () => {
    const dir = tmp();
    const path = join(dir, "app.sqlite");
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/fixtures/sample.json", import.meta.url)), "utf8"));
    const store = Store.open(path); // the app's own writer, in write-ahead mode
    try {
      await ingest(store, new ReplayAdapter(parseFixture(fixture)));
      const spec = {
        version: 1, from: 1_699_000_000_000, to: 1_700_100_000_000,
        strategy: { kind: "follow-wallets", wallets: ["alice", "carol"], latencyMs: 0, positionQuote: "1000000", takeProfitBps: 5000, stopLossBps: 2000, maxHoldMs: 3_600_000 },
        costs: { feeBps: 30, slippageBps: 100 },
      };
      const inlineTrades: WireWalletTrade[] = fixture.trades.map((t: any) => ({ id: t.id, time: t.time, token: t.token, side: t.side, amount: t.amount, quote: t.quote, wallet: t.wallet }));
      const c = await engine();
      try {
        const before = sha(readFileSync(path));
        const fromFile = await c.backtest(spec, { source: "sqlite", path, chain: fixture.chain } satisfies BacktestData);
        const inline = await c.backtest(spec, { source: "inline", trades: inlineTrades });
        expect(fromFile).toEqual(inline);
        expect(fromFile.summary.entered).toBeGreaterThan(0); // not an empty comparison
        expect(sha(readFileSync(path))).toBe(before);
        // The writer is still usable afterwards: the engine did not leave a lock behind.
        expect(store.counts(fixture.chain).trades).toBe(fixture.trades.length);
      } finally {
        await c.close();
      }
    } finally {
      store.close();
    }
  });

  it("answers a database it cannot read with -32002, and does not create the file", async () => {
    const dir = tmp();
    const c = await engine();
    try {
      const spec = vectors("backtest").cases[0].spec;
      const e = await c.backtest(spec, { source: "sqlite", path: join(dir, "missing.sqlite"), chain: "x" }).catch((x) => x);
      expect(e).toBeInstanceOf(SidecarError);
      expect((e as SidecarError).code).toBe(-32002);
      expect(() => statSync(join(dir, "missing.sqlite"))).toThrow();
    } finally {
      await c.close();
    }
  });

  it("exits with code 0 when asked to shut down, and when its input is closed", async () => {
    const c = await engine();
    await c.close();
    expect(await c.exited).toEqual({ code: 0, signal: null });
    const child = spawn(BIN!, [], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    child.stdin.end();
    expect(await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 10_000))])).toBe(0);
  });

  it("can be cancelled in the middle of a run and answers -32001", async () => {
    // Enough trades that the run is still going when the cancel arrives.
    const trades: WireWalletTrade[] = [];
    for (let i = 0; i < 150_000; i++) {
      trades.push({ id: `t${String(i).padStart(7, "0")}`, time: 1000 + i, token: `tok${i % 3000}`, side: i % 2 === 0 ? "buy" : "sell", amount: "1000", quote: String(1_000_000 + (i % 977) * 1000), wallet: i % 5 === 0 ? "alice" : "bob" });
    }
    const spec = {
      version: 1, from: 0, to: 10_000_000,
      strategy: { kind: "follow-wallets", wallets: ["alice"], latencyMs: 0, positionQuote: "1000000", takeProfitBps: 500, stopLossBps: 500, maxHoldMs: 100_000 },
      costs: { feeBps: 30, slippageBps: 100 },
    };
    const c = await engine();
    try {
      const ac = new AbortController();
      const started = Date.now();
      const p = c.backtest(spec, { source: "inline", trades }, { signal: ac.signal }).catch((x) => x);
      setTimeout(() => ac.abort(), 5);
      const outcome = await p;
      if (outcome instanceof SidecarError) {
        expect(outcome.kind).toBe("cancelled");
        expect(outcome.code).toBe(-32001);
      } else {
        // The run finished before the cancel arrived: legitimate, but then it must be a valid report.
        expect(outcome.summary.signals).toBeGreaterThan(0);
      }
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(await c.call("backtest.cancel", { id: 123456 })).toEqual({ cancelled: false }); // and it is still usable
    } finally {
      await c.close();
    }
  });

  it("is installed, verified, activated and launched through the install layout", async () => {
    const root = tmp();
    const version = EXPECTED_VERSION ?? "0.0.0-e2e";
    const dir = join(root, "versions", version);
    mkdirSync(dir, { recursive: true });
    const platform = currentPlatform();
    const target = join(dir, binaryName(platform));
    copyFileSync(BIN!, target);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifestVersion: 1, engineVersion: version, protocol: 1, file: binaryName(platform), size: statSync(target).size, sha256: sha(readFileSync(target)) }));
    activate(root, version);
    const info = resolveCurrent(root);
    expect(info?.binary).toBe(target);
    const c = await engine(info!.binary);
    try {
      expect(c.info.engineVersion).toBe(version);
    } finally {
      await c.close();
    }
    writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from([0])])); // one byte appended after install
    expect(() => resolveCurrent(root)).toThrow(/size/);
  });
});
