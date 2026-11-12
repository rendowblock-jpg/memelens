import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidecarError } from "../src/client";
import { LayoutError, type InstalledInfo } from "../src/layout";
import { ManagerError, SidecarManager, type EngineHandle, type ManagerOptions } from "../src/manager";
import type { BacktestData, BacktestReport } from "../src/types";

const SPEC = {
  version: 1,
  from: 0,
  to: 10_000_000,
  strategy: { kind: "follow-wallets", wallets: ["alice", "bob"], latencyMs: 500, positionQuote: "1000000", takeProfitBps: 5000, stopLossBps: 2000, maxHoldMs: 3_600_000 },
  costs: { feeBps: 100, slippageBps: 50 },
};
const REPORT = { engineVersion: "1.0.0", specHash: "h", dataAsOf: null, positions: [], summary: {} } as unknown as BacktestReport;
const info = (v: string): InstalledInfo => ({ version: v, engineVersion: v, protocol: 1, binary: `/sidecar/versions/${v}/memelens-sidecar` });

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  promise.catch(() => {});
  return { promise, resolve, reject };
}

type Behaviour = (call: Call) => Promise<BacktestReport>;
interface Call { spec: unknown; data: BacktestData; options: Parameters<EngineHandle["backtest"]>[2] }

class FakeEngine implements EngineHandle {
  calls: Call[] = [];
  closed = 0;
  killed = 0;
  behaviour: Behaviour = async () => REPORT;
  pending: Deferred<BacktestReport> | undefined;
  private done!: (v: unknown) => void;
  readonly exited = new Promise<unknown>((r) => (this.done = r));
  /** When set, close() and kill() return but the process "exits" only when the test calls releaseExit(), as a real kill() does. */
  holdExit = false;
  private held: (() => void) | undefined;
  constructor(readonly version: string) {}
  private finish(v: unknown): void {
    if (this.holdExit) this.held = () => this.done(v);
    else this.done(v);
  }
  releaseExit(): void {
    this.held?.();
  }
  backtest(spec: unknown, data: BacktestData, options?: Call["options"]): Promise<BacktestReport> {
    const call = { spec, data, options };
    this.calls.push(call);
    return this.behaviour(call);
  }
  async close(): Promise<void> {
    this.closed++;
    this.pending?.reject(new SidecarError("closed", "the engine was stopped"));
    this.finish({ code: 0, signal: null });
  }
  kill(): void {
    this.killed++;
    this.finish({ code: null, signal: "SIGKILL" });
  }
  die(): void {
    this.done({ code: 1, signal: null });
  }
  /** The next run does not finish until the test says so. */
  hold(): Deferred<BacktestReport> {
    const d = deferred<BacktestReport>();
    this.pending = d;
    this.behaviour = () => d.promise;
    return d;
  }
}

interface Harness {
  manager: SidecarManager;
  engines: FakeEngine[];
  started: InstalledInfo[];
  logs: string[];
  disk: { current: InstalledInfo | null | Error };
  startError: { value: unknown };
  startGate: { value: Deferred<void> | undefined };
  engineLog: { fn: ((line: string) => void) | undefined };
}
function harness(over: Partial<ManagerOptions> = {}, without: (keyof ManagerOptions)[] = []): Harness {
  const h: Harness = {
    engines: [], started: [], logs: [], disk: { current: info("1.0.0") }, startError: { value: undefined }, startGate: { value: undefined }, engineLog: { fn: undefined },
    manager: undefined as unknown as SidecarManager,
  };
  h.manager = new SidecarManager({
    root: "/sidecar",
    dbPath: "/data/memelens.sqlite",
    chain: "solana",
    platform: "linux",
    idleMs: 1000,
    resolve: () => {
      if (h.disk.current instanceof Error) throw h.disk.current;
      return h.disk.current;
    },
    start: async (i, onLog) => {
      h.started.push(i);
      h.engineLog.fn = onLog;
      if (h.startGate.value) await h.startGate.value.promise;
      if (h.startError.value !== undefined) throw h.startError.value;
      const e = new FakeEngine(i.version);
      h.engines.push(e);
      return e;
    },
    onLog: (l) => h.logs.push(l),
    ...over,
    ...Object.fromEntries(without.map((k) => [k, undefined])),
  } as ManagerOptions);
  return h;
}
async function kind(p: Promise<unknown>): Promise<ManagerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ManagerError) return e;
    throw e;
  }
  throw new Error("expected a ManagerError, but it resolved");
}
async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection, but it resolved");
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("status", () => {
  it("says nothing is installed when there is no current version", () => {
    const h = harness();
    h.disk.current = null;
    expect(h.manager.status()).toEqual({ installed: null, running: false, busy: false, problem: null });
  });
  it("reports the installed version, with nothing running", () => {
    expect(harness().manager.status()).toEqual({ installed: "1.0.0", running: false, busy: false, problem: null });
  });
  it("reports a damaged install as no install, and says why", () => {
    const h = harness();
    h.disk.current = new LayoutError("version 1.0.0: the binary's sha256 does not match the manifest");
    const s = h.manager.status();
    expect(s.installed).toBeNull();
    expect(s.problem).toMatch(/sha256 does not match/);
  });
  it("does not start anything", () => {
    const h = harness();
    h.manager.status();
    expect(h.started).toEqual([]);
  });
});

describe("runBacktest: what stops it before an engine is started", () => {
  it("refuses when nothing is installed", async () => {
    const h = harness();
    h.disk.current = null;
    expect((await kind(h.manager.runBacktest(SPEC))).kind).toBe("not-installed");
    expect(h.started).toEqual([]);
  });
  it("refuses a damaged install, keeps the cause, and never starts the binary", async () => {
    const h = harness();
    const cause = new LayoutError("the binary's sha256 does not match the manifest");
    h.disk.current = cause;
    const e = await kind(h.manager.runBacktest(SPEC));
    expect(e.kind).toBe("damaged");
    expect(e.message).toMatch(/sha256 does not match/);
    expect(e.cause).toBe(cause);
    expect(h.started).toEqual([]);
  });
  it("refuses an invalid spec without starting an engine or even looking at the disk", async () => {
    let looked = 0;
    const h = harness({ resolve: () => (looked++, info("1.0.0")) });
    const e = await kind(h.manager.runBacktest({ ...SPEC, version: 2 }));
    expect(e.kind).toBe("invalid-spec");
    expect(e.message.length).toBeGreaterThan(5);
    expect(h.started).toEqual([]);
    expect(looked).toBe(0);
  });
  it("refuses after shutdown", async () => {
    const h = harness();
    await h.manager.shutdown();
    expect((await kind(h.manager.runBacktest(SPEC))).kind).toBe("closed");
    expect(h.started).toEqual([]);
  });
});

describe("runBacktest: a normal run", () => {
  it("starts the installed engine, gives it the spec and the app's database, and returns its report", async () => {
    const h = harness();
    const report = await h.manager.runBacktest(SPEC);
    expect(report).toBe(REPORT);
    expect(h.started).toEqual([info("1.0.0")]);
    const call = h.engines[0]!.calls[0]!;
    expect(call.spec).toEqual(SPEC);
    expect(call.data).toEqual({ source: "sqlite", path: "/data/memelens.sqlite", chain: "solana" });
  });
  it("passes the abort signal, the progress callback and the time limit on", async () => {
    const h = harness();
    const signal = new AbortController().signal;
    const onProgress = (): void => {};
    await h.manager.runBacktest(SPEC, { signal, onProgress, timeoutMs: 1234 });
    const o = h.engines[0]!.calls[0]!.options!;
    expect(o.signal).toBe(signal);
    expect(o.onProgress).toBe(onProgress);
    expect(o.timeoutMs).toBe(1234);
  });
  it("uses the same engine for the next run", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    await h.manager.runBacktest(SPEC);
    expect(h.started).toHaveLength(1);
    expect(h.engines[0]!.calls).toHaveLength(2);
  });
  it("reports running while an engine is alive and busy only during a run", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    expect(h.manager.status()).toMatchObject({ running: true, busy: false });
    const held = h.engines[0]!.hold();
    const run = h.manager.runBacktest(SPEC);
    await tick();
    expect(h.manager.status()).toMatchObject({ running: true, busy: true });
    held.resolve(REPORT);
    await run;
    expect(h.manager.status()).toMatchObject({ running: true, busy: false });
  });
  it("runs one backtest at a time: a second is refused at once and does not disturb the first", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    const held = h.engines[0]!.hold();
    const first = h.manager.runBacktest(SPEC);
    await tick();
    expect((await kind(h.manager.runBacktest(SPEC))).kind).toBe("busy");
    expect(h.engines[0]!.calls).toHaveLength(2); // the earlier run and the first of these two, not the refused one
    held.resolve(REPORT);
    expect(await first).toBe(REPORT);
    h.engines[0]!.behaviour = async () => REPORT;
    expect(await h.manager.runBacktest(SPEC)).toBe(REPORT);
  });
  it("refuses a second call made in the same instant as the first, before any engine exists", async () => {
    const h = harness();
    const a = h.manager.runBacktest(SPEC);
    const b = h.manager.runBacktest(SPEC);
    expect((await kind(b)).kind).toBe("busy");
    await a;
    expect(h.started).toHaveLength(1);
  });
  it("frees itself after a failed run", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.behaviour = async () => {
      throw new SidecarError("remote", "bad", -32602);
    };
    await failure(h.manager.runBacktest(SPEC));
    expect(h.manager.status().busy).toBe(false);
    h.engines[0]!.behaviour = async () => REPORT;
    expect(await h.manager.runBacktest(SPEC)).toBe(REPORT);
  });
});

describe("runBacktest: the installed version changes or breaks while an engine is running", () => {
  it("stops the old engine and starts the new version", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.disk.current = info("1.1.0");
    await h.manager.runBacktest(SPEC);
    expect(h.started.map((i) => i.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(h.engines[0]!.closed).toBe(1);
    expect(h.engines[1]!.calls).toHaveLength(1);
    expect(h.engines[0]!.calls).toHaveLength(1);
  });
  it("keeps the running engine when the version is unchanged", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.disk.current = info("1.0.0");
    await h.manager.runBacktest(SPEC);
    expect(h.engines[0]!.closed).toBe(0);
  });
  it("refuses a run when the files no longer verify, and stops the engine that is still running", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.disk.current = new LayoutError("the binary's sha256 does not match the manifest");
    expect((await kind(h.manager.runBacktest(SPEC))).kind).toBe("damaged");
    expect(h.engines[0]!.closed).toBe(1);
    expect(h.engines[0]!.calls).toHaveLength(1);
    expect(h.manager.status().running).toBe(false);
  });
  it("refuses a run when the install was removed, and stops the engine", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.disk.current = null;
    expect((await kind(h.manager.runBacktest(SPEC))).kind).toBe("not-installed");
    expect(h.engines[0]!.closed).toBe(1);
  });
});

describe("runBacktest: when the engine fails", () => {
  const remote = new SidecarError("remote", "the data has no trades", -32010);
  it("passes an engine's own error on unchanged and keeps the healthy engine", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.behaviour = async () => {
      throw remote;
    };
    expect(await failure(h.manager.runBacktest(SPEC))).toBe(remote);
    expect(h.engines[0]!.killed).toBe(0);
    expect(h.engines[0]!.closed).toBe(0);
    expect(h.manager.status()).toMatchObject({ running: true, problem: null });
  });
  it("keeps the engine after a cancelled run", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    const cancelled = new SidecarError("cancelled", "cancelled", -32001);
    h.engines[0]!.behaviour = async () => {
      throw cancelled;
    };
    expect(await failure(h.manager.runBacktest(SPEC))).toBe(cancelled);
    expect(h.engines[0]!.killed).toBe(0);
    expect(h.manager.status().problem).toBeNull();
  });
  for (const k of ["timeout", "protocol"] as const) {
    it(`stops an engine that failed with '${k}', says why, and starts a fresh one next time`, async () => {
      const h = harness();
      const err = new SidecarError(k, `the engine ${k}`);
      await h.manager.runBacktest(SPEC);
      h.engines[0]!.behaviour = async () => {
        throw err;
      };
      expect(await failure(h.manager.runBacktest(SPEC))).toBe(err);
      expect(h.engines[0]!.killed).toBe(1);
      expect(h.manager.status()).toMatchObject({ running: false, busy: false });
      expect(h.manager.status().problem).toContain(`the engine ${k}`);
      expect(await h.manager.runBacktest(SPEC)).toBe(REPORT);
      expect(h.started).toHaveLength(2);
      expect(h.manager.status().problem).toBeNull();
    });
  }
  it("drops an engine that died during the run, says why, and starts a fresh one next time", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    const err = new SidecarError("exited", "the engine exited with code 3");
    h.engines[0]!.behaviour = async () => {
      h.engines[0]!.die();
      throw err;
    };
    expect(await failure(h.manager.runBacktest(SPEC))).toBe(err);
    expect(h.manager.status()).toMatchObject({ running: false, busy: false });
    expect(h.manager.status().problem).toContain("exited with code 3");
    expect(h.manager.status().problem).toMatch(/^the engine stopped during the run/);
    expect(h.engines[0]!.killed).toBe(0); // it was already dead
    expect(await h.manager.runBacktest(SPEC)).toBe(REPORT);
    expect(h.started).toHaveLength(2);
  });
  it("stops the engine after an error it does not recognise", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    const err = new TypeError("something unexpected");
    h.engines[0]!.behaviour = async () => {
      throw err;
    };
    expect(await failure(h.manager.runBacktest(SPEC))).toBe(err);
    expect(h.engines[0]!.killed).toBe(1);
    expect(h.manager.status().problem).toContain("something unexpected");
  });
  it("notices an idle engine that died, and starts a fresh one without complaint", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.die();
    await tick();
    expect(h.manager.status().running).toBe(false);
    expect(await h.manager.runBacktest(SPEC)).toBe(REPORT);
    expect(h.started).toHaveLength(2);
    expect(h.manager.status().problem).toBeNull();
  });
  it("does not mistake the stopping of an old engine for the death of its replacement", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.disk.current = info("1.1.0");
    await h.manager.runBacktest(SPEC);
    await tick();
    expect(h.manager.status().running).toBe(true);
    h.engines[0]!.die(); // the old one, long gone
    await tick();
    expect(h.manager.status().running).toBe(true);
  });
});

describe("runBacktest: when the engine cannot be started", () => {
  it("reports it as start-failed with the cause, says why in the status, and tries again next time", async () => {
    const h = harness();
    const cause = new SidecarError("spawn", "cannot start /sidecar/versions/1.0.0/memelens-sidecar: EACCES");
    h.startError.value = cause;
    const e = await kind(h.manager.runBacktest(SPEC));
    expect(e.kind).toBe("start-failed");
    expect(e.message).toMatch(/EACCES/);
    expect(e.cause).toBe(cause);
    expect(h.manager.status()).toMatchObject({ running: false, busy: false });
    expect(h.manager.status().problem).toMatch(/EACCES/);
    h.startError.value = undefined;
    expect(await h.manager.runBacktest(SPEC)).toBe(REPORT);
    expect(h.started).toHaveLength(2);
    expect(h.manager.status().problem).toBeNull();
  });
});

describe("the idle timeout", () => {
  it("stops the engine after the idle time, and not a moment before", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.engines[0]!.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.engines[0]!.closed).toBe(1);
    expect(h.manager.status().running).toBe(false);
  });
  it("starts a fresh engine after an idle stop", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    await vi.advanceTimersByTimeAsync(5000);
    await h.manager.runBacktest(SPEC);
    expect(h.started).toHaveLength(2);
  });
  it("restarts the wait when another run begins", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    await vi.advanceTimersByTimeAsync(800);
    await h.manager.runBacktest(SPEC);
    await vi.advanceTimersByTimeAsync(800); // 1600 since the first run, 800 since the second
    expect(h.engines[0]!.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.engines[0]!.closed).toBe(1);
  });
  it("never stops an engine in the middle of a run, however long it takes", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    const held = h.engines[0]!.hold();
    const run = h.manager.runBacktest(SPEC);
    await tick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.engines[0]!.closed).toBe(0);
    held.resolve(REPORT);
    await run;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.engines[0]!.closed).toBe(1);
  });
  it("also waits after a run that failed but left a healthy engine", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.behaviour = async () => {
      throw new SidecarError("remote", "x", -32602);
    };
    await failure(h.manager.runBacktest(SPEC));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.engines[0]!.closed).toBe(1);
  });
  it("uses 60 seconds when no time is given", async () => {
    const h = harness({}, ["idleMs"]);
    await h.manager.runBacktest(SPEC);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.engines[0]!.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.engines[0]!.closed).toBe(1);
  });
  it("refuses a time that makes no sense", () => {
    for (const idleMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => harness({ idleMs }), String(idleMs)).toThrow(RangeError);
    }
  });
  it("does not keep the process alive", async () => {
    let unref = 0;
    const real = globalThis.setTimeout;
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms);
      const original = t.unref.bind(t);
      t.unref = () => (unref++, original());
      return t;
    }) as unknown as typeof setTimeout);
    try {
      const h = harness({ idleMs: 50 });
      await h.manager.runBacktest(SPEC);
      expect(unref).toBeGreaterThanOrEqual(1);
      await h.manager.shutdown();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("shutdown", () => {
  it("stops a running engine once, and is safe to call again", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    await h.manager.shutdown();
    await h.manager.shutdown();
    expect(h.engines[0]!.closed).toBe(1);
    expect(h.manager.status().running).toBe(false);
  });
  it("does nothing, and starts nothing, when no engine was ever started", async () => {
    const h = harness();
    await h.manager.shutdown();
    expect(h.started).toEqual([]);
  });
  it("cancels the idle timer", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    await h.manager.shutdown();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.engines[0]!.closed).toBe(1);
  });
  it("stops an engine in the middle of a run, and that run ends with the engine's own 'closed' error", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.hold();
    const run = h.manager.runBacktest(SPEC);
    await tick();
    await h.manager.shutdown();
    const e = await failure(run);
    expect(e).toBeInstanceOf(SidecarError);
    expect((e as SidecarError).kind).toBe("closed");
    expect(h.engines[0]!.closed).toBe(1);
    expect(h.engines[0]!.killed).toBe(0); // it was asked to stop, not killed
    expect(h.manager.status().problem).toBeNull(); // and a stop we asked for is not a problem
    expect(h.logs.filter((l) => l.includes("exited"))).toEqual([]);
  });
  it("does not leave an engine running when it is called while the engine is still starting", async () => {
    const h = harness();
    h.startGate.value = deferred<void>();
    const run = h.manager.runBacktest(SPEC);
    await tick();
    const stopping = h.manager.shutdown();
    h.startGate.value.resolve();
    await stopping;
    expect(h.engines[0]!.closed).toBe(1); // already closed when shutdown returns: the app may quit right now
    expect((await kind(run)).kind).toBe("closed");
    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]!.closed).toBe(1);
    expect(h.engines[0]!.calls).toEqual([]);
  });
});

describe("an engine that has been told to stop but has not finished exiting", () => {
  it("is not used again after it was killed, and its late exit does not disturb its replacement", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    const old = h.engines[0]!;
    old.holdExit = true;
    old.behaviour = async () => {
      throw new SidecarError("timeout", "too slow");
    };
    await failure(h.manager.runBacktest(SPEC));
    expect(old.killed).toBe(1);
    expect(h.manager.status().running).toBe(false); // gone for our purposes, though its process is still exiting
    expect(await h.manager.runBacktest(SPEC)).toBe(REPORT);
    expect(h.started).toHaveLength(2);
    expect(old.calls).toHaveLength(2); // the run that timed out and the one before it, and nothing since
    expect(h.engines[1]!.calls).toHaveLength(1);

    old.releaseExit(); // the old process finally exits
    await tick();
    expect(h.manager.status().running).toBe(true);
    await h.manager.shutdown();
    expect(h.engines[1]!.closed).toBe(1); // the replacement was still known, so it was closed
  });
  it("is not used again after an idle stop", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.holdExit = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.engines[0]!.closed).toBe(1);
    expect(h.manager.status().running).toBe(false);
    await h.manager.runBacktest(SPEC);
    expect(h.started).toHaveLength(2);
    expect(h.engines[0]!.calls).toHaveLength(1);
  });
  it("is not used again after it was stopped for an update", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.holdExit = true;
    h.disk.current = info("1.1.0");
    await h.manager.runBacktest(SPEC);
    h.disk.current = info("1.0.0"); // rolled back to the version that is still exiting
    await h.manager.runBacktest(SPEC);
    expect(h.started.map((i) => i.version)).toEqual(["1.0.0", "1.1.0", "1.0.0"]);
    expect(h.engines[0]!.calls).toHaveLength(1);
  });
});

describe("stopping an engine", () => {
  it("kills an engine that will not close", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.close = async () => {
      throw new Error("stuck");
    };
    await h.manager.shutdown();
    expect(h.engines[0]!.killed).toBe(1);
    expect(h.manager.status().running).toBe(false);
  });
  it("kills an engine that will not close when the idle time is up", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.close = async () => {
      throw new Error("stuck");
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.engines[0]!.killed).toBe(1);
  });
  it("logs an engine that exits by itself, and says nothing about one it stopped", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engines[0]!.die();
    await tick();
    expect(h.logs.filter((l) => l.includes("exited"))).toEqual(["the engine 1.0.0 exited"]);

    const quiet = harness();
    await quiet.manager.runBacktest(SPEC);
    await vi.advanceTimersByTimeAsync(1000); // stopped for being idle
    quiet.disk.current = info("2.0.0");
    await quiet.manager.runBacktest(SPEC);
    quiet.disk.current = info("2.1.0");
    await quiet.manager.runBacktest(SPEC); // the 2.0.0 engine stopped for the update
    await quiet.manager.shutdown();
    await tick();
    expect(quiet.logs.filter((l) => l.includes("exited"))).toEqual([]);

    const timeout = harness();
    await timeout.manager.runBacktest(SPEC);
    timeout.engines[0]!.behaviour = async () => {
      throw new SidecarError("timeout", "too slow");
    };
    await failure(timeout.manager.runBacktest(SPEC));
    await tick();
    expect(timeout.logs.filter((l) => l.includes("exited"))).toEqual([]);
  });
});

describe("the engine's log", () => {
  it("is passed to the app's log, marked as coming from the engine", async () => {
    const h = harness();
    await h.manager.runBacktest(SPEC);
    h.engineLog.fn!("loaded 3 trades");
    expect(h.logs).toContain("engine: loaded 3 trades");
  });
});
