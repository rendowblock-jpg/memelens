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

// ---------------------------------------------------------------------------------------------------------------------
// The manager on the real engine: the default start path (verify, launch, hello, version check) that its unit tests replace.
import { ManagerError, SidecarManager } from "../src/manager";

/** Puts the real engine into a fresh install folder under `folder`, with a manifest that names `claimed` as its version. */
function installReal(folder: string, claimed: string): { root: string; binary: string } {
  const root = tmp();
  const dir = join(root, "versions", folder);
  mkdirSync(dir, { recursive: true });
  const platform = currentPlatform();
  const binary = join(dir, binaryName(platform));
  copyFileSync(BIN!, binary);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifestVersion: 1, engineVersion: claimed, protocol: 1, file: binaryName(platform), size: statSync(binary).size, sha256: sha(readFileSync(binary)) }));
  activate(root, folder);
  return { root, binary };
}
async function realVersion(): Promise<string> {
  const c = await engine();
  try {
    return c.info.engineVersion;
  } finally {
    await c.close();
  }
}
const FOLLOW = {
  version: 1, from: 1_699_000_000_000, to: 1_700_100_000_000,
  strategy: { kind: "follow-wallets", wallets: ["alice", "carol"], latencyMs: 0, positionQuote: "1000000", takeProfitBps: 5000, stopLossBps: 2000, maxHoldMs: 3_600_000 },
  costs: { feeBps: 30, slippageBps: 100 },
};

run("the manager on the real engine", () => {
  it("runs a backtest on the app's real database through the installed engine, stops it when idle, and starts a fresh one for the next run", async () => {
    const version = await realVersion();
    const { root } = installReal(version, version);
    const dir = tmp();
    const path = join(dir, "app.sqlite");
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/fixtures/sample.json", import.meta.url)), "utf8"));
    const store = Store.open(path);
    const manager = new SidecarManager({ root, dbPath: path, chain: fixture.chain, idleMs: 400 });
    try {
      await ingest(store, new ReplayAdapter(parseFixture(fixture)));
      expect(manager.status()).toMatchObject({ installed: version, running: false, busy: false, problem: null });
      const first = await manager.runBacktest(FOLLOW);
      expect(first.engineVersion).toBe(version);
      expect(first.summary.entered).toBeGreaterThan(0); // not an empty comparison
      expect(manager.status()).toMatchObject({ running: true, busy: false });

      const inline: WireWalletTrade[] = fixture.trades.map((t: any) => ({ id: t.id, time: t.time, token: t.token, side: t.side, amount: t.amount, quote: t.quote, wallet: t.wallet }));
      const direct = await engine();
      try {
        expect(first).toEqual(await direct.backtest(FOLLOW, { source: "inline", trades: inline }));
      } finally {
        await direct.close();
      }

      await new Promise((r) => setTimeout(r, 1200)); // idle for longer than idleMs
      expect(manager.status().running).toBe(false);
      expect(await manager.runBacktest(FOLLOW)).toEqual(first);
      expect(manager.status().running).toBe(true);
    } finally {
      await manager.shutdown();
      store.close();
    }
    expect(manager.status().running).toBe(false);
  });

  it("reports an engine's own refusal as the engine's error and keeps the engine for the next run", async () => {
    const version = await realVersion();
    const { root } = installReal(version, version);
    const manager = new SidecarManager({ root, dbPath: join(tmp(), "missing.sqlite"), chain: "x", idleMs: 5000 });
    try {
      const e = await manager.runBacktest(FOLLOW).catch((x) => x);
      expect(e).toBeInstanceOf(SidecarError);
      expect((e as SidecarError).kind).toBe("remote");
      expect((e as SidecarError).code).toBe(-32002);
      expect(manager.status()).toMatchObject({ running: true, problem: null });
    } finally {
      await manager.shutdown();
    }
  });

  it("refuses an engine whose verified files promise one version while the program says another, and leaves no process running", async () => {
    const { root } = installReal("9.9.9", "9.9.9");
    const manager = new SidecarManager({ root, dbPath: join(tmp(), "x.sqlite"), chain: "x" });
    const e = await manager.runBacktest(FOLLOW).catch((x) => x);
    expect(e).toBeInstanceOf(ManagerError);
    expect((e as ManagerError).kind).toBe("start-failed");
    expect((e as ManagerError).message).toMatch(/says it is version/);
    expect(manager.status()).toMatchObject({ running: false });
    expect(manager.status().problem).toMatch(/says it is version/);
    await manager.shutdown();
  });

  it("does not launch a binary that changed after it was installed", async () => {
    const version = await realVersion();
    const { root, binary } = installReal(version, version);
    writeFileSync(binary, Buffer.concat([readFileSync(binary), Buffer.from([0])]));
    const manager = new SidecarManager({ root, dbPath: join(tmp(), "x.sqlite"), chain: "x" });
    const e = await manager.runBacktest(FOLLOW).catch((x) => x);
    expect(e).toBeInstanceOf(ManagerError);
    expect((e as ManagerError).kind).toBe("damaged");
    expect(manager.status()).toMatchObject({ installed: null, running: false });
    await manager.shutdown();
  });

  it("says plainly that no engine is installed", async () => {
    const manager = new SidecarManager({ root: tmp(), dbPath: join(tmp(), "x.sqlite"), chain: "x" });
    const e = await manager.runBacktest(FOLLOW).catch((x) => x);
    expect(e).toBeInstanceOf(ManagerError);
    expect((e as ManagerError).kind).toBe("not-installed");
    expect(manager.status()).toEqual({ installed: null, running: false, busy: false, problem: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The whole chain on real binaries: the Go release tool signs, a local server serves, the app's updater checks, downloads,
// verifies, installs and starts the engine. Needs the engine (MEMELENS_SIDECAR_BIN), the release tool
// (MEMELENS_RELEASE_BIN) and the version the engine was built with (MEMELENS_SIDECAR_VERSION).
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { checkForUpdate, installUpdate, type UpdateConfig } from "../src/updater";
import { readPointer, listInstalled } from "../src/layout";

const RELEASE_BIN = process.env["MEMELENS_RELEASE_BIN"];
const chain = BIN === undefined || RELEASE_BIN === undefined || EXPECTED_VERSION === undefined ? describe.skip : describe;

function goTarget(): { goos: string; goarch: string } {
  const goos = { win32: "windows", linux: "linux", darwin: "darwin" }[process.platform as string];
  const goarch = { x64: "amd64", arm64: "arm64" }[process.arch as string];
  if (goos === undefined || goarch === undefined) throw new Error(`no Go target for ${process.platform}/${process.arch}`);
  return { goos, goarch };
}

/** Makes a key and a signed release of the real engine under `version`. Returns the release folder and the public key. */
function publish(version: string, keyFile?: string): { out: string; keyFile: string; pub: Uint8Array } {
  const out = tmp();
  const key = keyFile ?? join(tmp(), "key.pem");
  let pubText: string;
  if (keyFile === undefined) {
    const said = execFileSync(RELEASE_BIN!, ["keygen", "-out", key], { encoding: "utf8" });
    pubText = /public-key: (\S+)/.exec(said)![1]!;
  } else {
    pubText = "";
  }
  const { goos, goarch } = goTarget();
  execFileSync(RELEASE_BIN!, ["publish", "-binary", BIN!, "-version", version, "-key", key, "-out", out, "-goos", goos, "-goarch", goarch], { encoding: "utf8" });
  return { out, keyFile: key, pub: new Uint8Array(Buffer.from(pubText, "base64url")) };
}

async function serve(dir: string, tamper?: (path: string, bytes: Buffer) => Buffer): Promise<{ base: string; close(): Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      if (path.includes("..")) throw new Error("no");
      let bytes: Buffer = await readFile(join(dir, path.replace(/^\/releases\//, "")));
      if (tamper) bytes = tamper(path, bytes);
      res.writeHead(200, { "content-length": bytes.length });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

function updaterConfig(root: string, base: string, pub: Uint8Array): UpdateConfig {
  return { root, baseUrl: base, publicKeys: [pub], allowedHosts: ["127.0.0.1"], allowInsecureLoopback: true, timeoutMs: 60_000 };
}

chain("an engine release signed by the Go tool, installed by the app's updater", () => {
  it("is found, downloaded, verified, installed, started, and then reported up to date", async () => {
    const rel = publish(EXPECTED_VERSION!);
    const srv = await serve(rel.out);
    try {
      const root = tmp();
      const cfg = updaterConfig(root, srv.base, rel.pub);
      const found = await checkForUpdate(cfg);
      expect(found.kind).toBe("available");
      if (found.kind !== "available") return;
      expect(found.offer.manifest.engineVersion).toBe(EXPECTED_VERSION);
      const info = await installUpdate(cfg, found.offer); // runs the real engine's hello as the self-test
      expect(info.version).toBe(EXPECTED_VERSION);
      expect(readPointer(root, "current")).toEqual({ version: EXPECTED_VERSION });
      expect(listInstalled(root)).toEqual([EXPECTED_VERSION]);
      // the installed copy really is the engine: start it from the layout and run a vector through it
      const c = await engine(resolveCurrent(root)!.binary);
      try {
        const v = vectors("backtest").cases[0];
        expect(withoutEngineVersion(await c.backtest(v.spec, { source: "inline", trades: v.trades }))).toEqual(v.expected);
      } finally {
        await c.close();
      }
      expect(await checkForUpdate(cfg)).toEqual({ kind: "up-to-date", version: EXPECTED_VERSION });
    } finally {
      await srv.close();
    }
  });

  it("refuses a binary changed on its way (one flipped byte), and installs nothing", async () => {
    const rel = publish(EXPECTED_VERSION!);
    const srv = await serve(rel.out, (path, bytes) => {
      if (!/memelens-sidecar(\.exe)?$/.test(path)) return bytes;
      const copy = Buffer.from(bytes);
      copy[copy.length >> 1] = copy[copy.length >> 1]! ^ 1;
      return copy;
    });
    try {
      const root = tmp();
      const cfg = updaterConfig(root, srv.base, rel.pub);
      const found = await checkForUpdate(cfg);
      if (found.kind !== "available") throw new Error("expected an update");
      await expect(installUpdate(cfg, found.offer)).rejects.toMatchObject({ kind: "download" });
      expect(listInstalled(root)).toEqual([]);
      expect(readPointer(root, "current")).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("refuses a release signed by a key the app does not trust", async () => {
    const rel = publish(EXPECTED_VERSION!);
    const stranger = publish(EXPECTED_VERSION!);
    const srv = await serve(rel.out);
    try {
      await expect(checkForUpdate(updaterConfig(tmp(), srv.base, stranger.pub))).rejects.toMatchObject({ kind: "signature" });
    } finally {
      await srv.close();
    }
  });

  it("refuses a release whose manifest promises a version the binary does not report (the self-test catches it), and removes it", async () => {
    const rel = publish("9.9.9"); // the engine inside says EXPECTED_VERSION
    const srv = await serve(rel.out);
    try {
      const root = tmp();
      const cfg = updaterConfig(root, srv.base, rel.pub);
      const found = await checkForUpdate(cfg);
      if (found.kind !== "available") throw new Error("expected an update");
      await expect(installUpdate(cfg, found.offer)).rejects.toMatchObject({ kind: "self-test" });
      expect(listInstalled(root)).toEqual([]);
      expect(readPointer(root, "current")).toBeNull();
    } finally {
      await srv.close();
    }
  });
});
