import { SidecarClient, SidecarError } from "./client";
import { resolveCurrent, type InstalledInfo, type Platform } from "./layout";
import { parseBacktestSpec, SpecError } from "./spec";
import type { BacktestData, BacktestReport } from "./types";

// The app's one door to the engine. It decides when the engine runs and when it does not:
//  - it starts the engine only from files that verify right now, and only the version that is current;
//  - it runs one backtest at a time (the engine does too, but the refusal should come from here, at once);
//  - it chooses the data (the app's own database); a caller supplies only the strategy;
//  - it stops an engine that timed out, broke the protocol or surprised it, and starts a fresh one next time;
//  - it stops an idle engine, because the PCs this runs on are small;
//  - on shutdown it leaves no engine behind, even one that is still starting (a child of a Windows process does not die with it).

export type ManagerErrorKind = "closed" | "busy" | "not-installed" | "damaged" | "invalid-spec" | "start-failed";

export class ManagerError extends Error {
  constructor(
    readonly kind: ManagerErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The part of SidecarClient the manager uses. */
export interface EngineHandle {
  backtest(
    spec: unknown,
    data: BacktestData,
    options?: { timeoutMs?: number; onProgress?: (p: { done: number; total: number }) => void; signal?: AbortSignal },
  ): Promise<BacktestReport>;
  close(graceMs?: number): Promise<void>;
  kill(): void;
  readonly exited: Promise<unknown>;
}

export interface ManagerOptions {
  root: string;
  /** The app's SQLite file. Only the app chooses it; a caller of runBacktest cannot. */
  dbPath: string;
  chain: string;
  platform?: Platform;
  /** Replaces layout.resolveCurrent, for tests. */
  resolve?: (root: string, platform?: Platform) => InstalledInfo | null;
  /** Replaces the real process start, for tests. */
  start?: (info: InstalledInfo, onLog: (line: string) => void) => Promise<EngineHandle>;
  /** Stop the engine this long after the last run. Default 60 s. */
  idleMs?: number;
  onLog?: (line: string) => void;
}

export interface EngineStatus {
  /** The current version if it verifies right now, else null. */
  installed: string | null;
  running: boolean;
  busy: boolean;
  /** Why the engine is not usable or what went wrong last. Null when nothing is wrong. */
  problem: string | null;
}

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number }) => void;
  timeoutMs?: number;
}

interface Running {
  handle: EngineHandle;
  version: string;
  /** Set when the manager itself stops the engine, so its exit is not taken for a crash. */
  stopping: boolean;
}

const DEFAULT_IDLE_MS = 60_000;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Starts the real engine and checks that it is the version the verified files promised. */
export async function startEngine(info: InstalledInfo, onLog: (line: string) => void): Promise<EngineHandle> {
  const client = await SidecarClient.start({ command: info.binary, onLog });
  if (client.info.engineVersion !== info.engineVersion) {
    await client.close(1500).catch(() => client.kill());
    throw new SidecarError("protocol", `the engine says it is version ${client.info.engineVersion}, its manifest says ${info.engineVersion}`);
  }
  return client;
}

export class SidecarManager {
  private engine: Running | null = null;
  private starting: Promise<unknown> | null = null;
  private busy = false;
  private closed = false;
  private problem: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleMs: number;
  private readonly resolve: (root: string, platform?: Platform) => InstalledInfo | null;
  private readonly startFn: (info: InstalledInfo, onLog: (line: string) => void) => Promise<EngineHandle>;

  constructor(private readonly options: ManagerOptions) {
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new RangeError("idleMs must be a positive whole number");
    this.idleMs = idleMs;
    this.resolve = options.resolve ?? resolveCurrent;
    this.startFn = options.start ?? startEngine;
  }

  status(): EngineStatus {
    let installed: string | null = null;
    let problem = this.problem;
    try {
      installed = this.resolve(this.options.root, this.options.platform)?.version ?? null;
    } catch (e) {
      problem = message(e);
    }
    return { installed, running: this.engine !== null, busy: this.busy, problem };
  }

  async runBacktest(specInput: unknown, options: RunOptions = {}): Promise<BacktestReport> {
    if (this.closed) throw new ManagerError("closed", "the engine manager has been shut down");
    if (this.busy) throw new ManagerError("busy", "a backtest is already running");
    this.busy = true; // set before the first await, so a second call in the same instant is refused
    this.clearIdle();
    try {
      let spec;
      try {
        spec = parseBacktestSpec(specInput);
      } catch (e) {
        if (e instanceof SpecError) throw new ManagerError("invalid-spec", e.message, { cause: e });
        throw e;
      }
      const info = await this.currentOrStop();
      const engine = await this.engineFor(info);
      const data: BacktestData = { source: "sqlite", path: this.options.dbPath, chain: this.options.chain };
      const run: Parameters<EngineHandle["backtest"]>[2] = {};
      if (options.timeoutMs !== undefined) run.timeoutMs = options.timeoutMs;
      if (options.onProgress !== undefined) run.onProgress = options.onProgress;
      if (options.signal !== undefined) run.signal = options.signal;
      try {
        const report = await engine.handle.backtest(spec, data, run);
        this.problem = null;
        return report;
      } catch (e) {
        this.afterFailure(engine, e);
        throw e;
      }
    } finally {
      this.busy = false;
      if (this.engine !== null && !this.closed) this.armIdle();
    }
  }

  /** Stops the engine, including one that is still starting. Safe to call twice. */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.clearIdle();
    if (this.starting !== null) await this.starting.catch(() => undefined);
    await this.stopEngine();
  }

  // ------------------------------------------------------------ internals
  /** The verified current install. If there is none, or it no longer verifies, a running engine is stopped as well. */
  private async currentOrStop(): Promise<InstalledInfo> {
    let info: InstalledInfo | null;
    try {
      info = this.resolve(this.options.root, this.options.platform);
    } catch (e) {
      await this.stopEngine();
      throw new ManagerError("damaged", `the installed engine does not verify: ${message(e)}`, { cause: e });
    }
    if (info === null) {
      await this.stopEngine();
      throw new ManagerError("not-installed", "no engine is installed");
    }
    return info;
  }

  private async engineFor(info: InstalledInfo): Promise<Running> {
    if (this.engine !== null && this.engine.version === info.version) return this.engine;
    await this.stopEngine(); // an older version is still running
    const starting = this.begin(info);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      this.starting = null;
    }
  }

  private async begin(info: InstalledInfo): Promise<Running> {
    let handle: EngineHandle;
    try {
      handle = await this.startFn(info, (line) => this.options.onLog?.(`engine: ${line}`));
    } catch (e) {
      this.problem = `the engine could not be started: ${message(e)}`;
      throw new ManagerError("start-failed", `the engine could not be started: ${message(e)}`, { cause: e });
    }
    if (this.closed) {
      await handle.close().catch(() => handle.kill());
      throw new ManagerError("closed", "the engine manager was shut down while the engine was starting");
    }
    const running: Running = { handle, version: info.version, stopping: false };
    this.engine = running;
    void handle.exited.then(() => {
      if (this.engine === running) this.engine = null;
      if (!running.stopping) this.options.onLog?.(`the engine ${info.version} exited`);
    });
    return running;
  }

  private afterFailure(engine: Running, e: unknown): void {
    if (e instanceof SidecarError) {
      // The engine answered, so it is healthy: the problem is in the request, not in the engine.
      if (e.kind === "remote" || e.kind === "cancelled") return;
      if (e.kind === "exited" || e.kind === "closed") {
        if (this.engine === engine) this.engine = null;
        if (!engine.stopping) this.problem = `the engine stopped during the run: ${e.message}`;
        return;
      }
      this.problem = `the engine was stopped after a failed run: ${e.message}`;
    } else {
      this.problem = `the engine was stopped after an unexpected error: ${message(e)}`;
    }
    this.killEngine(engine);
  }

  private killEngine(engine: Running): void {
    engine.stopping = true;
    if (this.engine === engine) this.engine = null;
    engine.handle.kill();
  }

  private async stopEngine(): Promise<void> {
    const engine = this.engine;
    if (engine === null) return;
    this.engine = null;
    engine.stopping = true;
    try {
      await engine.handle.close();
    } catch {
      engine.handle.kill();
    }
  }

  private armIdle(): void {
    this.clearIdle();
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.busy) void this.stopEngine();
    }, this.idleMs);
    timer.unref?.(); // an idle timer must not keep the app alive
    this.idleTimer = timer;
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
