import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { encodeMessage, LineDecoder, MAX_LINE_BYTES } from "./codec";
import { specHash } from "./canonical";
import { parseBacktestReport, ReportError } from "./report";
import { parseBacktestSpec } from "./spec";
import type { BacktestData, BacktestReport, HelloResult } from "./types";

export type ErrorKind = "remote" | "timeout" | "exited" | "closed" | "protocol" | "spawn" | "cancelled";

export class SidecarError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface SidecarOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** The environment of the engine. Default: only what `sidecarEnv` allows from this process. */
  env?: Record<string, string | undefined>;
  supportedProtocols?: readonly number[];
  helloTimeoutMs?: number;
  defaultTimeoutMs?: number;
  maxLineBytes?: number;
  /** Lines that are not valid messages tolerated before the engine is stopped. Default 20. */
  maxProtocolErrors?: number;
  clientName?: string;
  clientVersion?: string;
  onLog?: (line: string) => void;
  onProtocolError?: (reason: string) => void;
  onSpawn?: (pid: number | undefined) => void;
}

export interface Notification {
  method: string;
  params: unknown;
}

/** The part of this process's environment the engine is given: enough to run, none of the app's other settings. */
export function sidecarEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const keep = ["SystemRoot", "SYSTEMROOT", "SystemDrive", "TEMP", "TMP", "TMPDIR"];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = source[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

const LOG_LINE_MAX = 8192;
const CANCELLED_CODE = -32001;

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: SidecarError): void;
  timer: NodeJS.Timeout | undefined;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

/** Checks the shape of a backtest data source before it is sent. */
function checkData(data: BacktestData): void {
  if (typeof data !== "object" || data === null) throw new TypeError("data must be an object");
  if (data.source === "inline") {
    if (!Array.isArray(data.trades)) throw new TypeError("data.trades must be a list");
  } else if (data.source === "sqlite") {
    if (typeof data.path !== "string" || data.path === "" || !/^([A-Za-z]:[\\/]|\\\\|\/)/.test(data.path)) throw new TypeError("data.path must be an absolute path");
    if (typeof data.chain !== "string" || data.chain === "") throw new TypeError("data.chain must be non-empty text");
  } else {
    throw new TypeError('data.source must be "inline" or "sqlite"');
  }
}

export class SidecarClient {
  private helloResult: HelloResult | undefined;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder: LineDecoder;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Set<(n: Notification) => void>();
  private nextId = 1;
  private protocolErrors = 0;
  private ended = false;
  private closing = false;
  private fatal: SidecarError | undefined;
  private exitInfo: { code: number | null; signal: string | null } | undefined;
  private stderrBuffer = "";

  private constructor(private readonly options: Required<Pick<SidecarOptions, "defaultTimeoutMs" | "maxProtocolErrors" | "maxLineBytes">> & SidecarOptions, child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.decoder = new LineDecoder({ maxLineBytes: options.maxLineBytes });
    this.exited = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        this.onClose(code, signal);
        resolve({ code, signal });
      });
    });
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.stdin.on("error", () => {
      // A broken pipe means the engine is gone; 'close' reports it.
    });
  }

  get info(): HelloResult {
    if (this.helloResult === undefined) throw new SidecarError("closed", "the engine has not said hello");
    return this.helloResult;
  }

  /** Starts the engine, says hello and checks the protocol. On any failure the engine is stopped before this rejects. */
  static async start(options: SidecarOptions): Promise<SidecarClient> {
    const supported = options.supportedProtocols ?? [1];
    const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: (options.env ?? sidecarEnv()) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const spawnFailed = new Promise<SidecarError>((resolve) => child.once("error", (e) => resolve(new SidecarError("spawn", `cannot start ${options.command}: ${e.message}`))));
    if (child.pid === undefined) {
      options.onSpawn?.(undefined);
      throw await spawnFailed;
    }
    options.onSpawn?.(child.pid);
    const client = new SidecarClient(
      { ...options, defaultTimeoutMs: options.defaultTimeoutMs ?? 120_000, maxProtocolErrors: options.maxProtocolErrors ?? 20, maxLineBytes: options.maxLineBytes ?? MAX_LINE_BYTES },
      child,
    );
    try {
      const result = await client.request("hello", {
        client: { name: options.clientName ?? "memelens", version: options.clientVersion ?? "0.0.0" },
        protocols: [...supported],
      }, helloTimeoutMs).promise;
      const hello = SidecarClient.parseHello(result);
      if (!supported.includes(hello.protocol)) {
        throw new SidecarError("protocol", `the engine speaks protocol ${hello.protocol}; this app supports ${supported.join(", ")}`);
      }
      client.helloResult = hello;
      return client;
    } catch (e) {
      client.kill();
      await client.exited;
      throw e;
    }
  }

  private static parseHello(v: unknown): HelloResult {
    if (typeof v !== "object" || v === null) throw new SidecarError("protocol", "the engine's hello answer is not an object");
    const r = v as Record<string, unknown>;
    if (!isInt(r["protocol"]) || r["protocol"] < 1) throw new SidecarError("protocol", "hello: protocol must be a whole number from 1");
    if (typeof r["engineVersion"] !== "string" || r["engineVersion"] === "") throw new SidecarError("protocol", "hello: engineVersion must be non-empty text");
    const caps = r["capabilities"];
    if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string")) throw new SidecarError("protocol", "hello: capabilities must be a list of text");
    return { protocol: r["protocol"], engineVersion: r["engineVersion"], capabilities: [...caps] as string[] };
  }

  // ------------------------------------------------------------ requests
  private request(method: string, params: unknown, timeoutMs: number, allowClosing = false): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.ended || (this.closing && !allowClosing)) {
        reject(this.fatal ?? new SidecarError("closed", "the engine is not running"));
        return;
      }
      const entry: Pending = { method, resolve, reject, timer: undefined };
      entry.timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new SidecarError("timeout", `${method} did not answer within ${timeoutMs} ms; the engine was stopped`));
        this.kill();
      }, timeoutMs);
      this.pending.set(id, entry);
      try {
        this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, this.options.maxLineBytes));
      } catch (e) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(new SidecarError("protocol", `cannot send ${method}: ${(e as Error).message}`));
      }
    });
    return { id, promise };
  }

  call(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    return this.request(method, params, options.timeoutMs ?? this.options.defaultTimeoutMs).promise;
  }

  onNotification(handler: (n: Notification) => void): () => void {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  }

  // ------------------------------------------------------------ incoming
  private onData(chunk: Buffer): void {
    for (const line of this.decoder.push(chunk)) {
      if (this.ended) return;
      if (line.kind === "too-long") {
        this.failFatally(new SidecarError("protocol", `the engine wrote a line longer than the limit (${line.bytes}+ bytes, limit ${this.options.maxLineBytes})`));
        return;
      }
      if (line.kind === "invalid") {
        if (this.protocolError(`a line from the engine is ${line.reason}: ${JSON.stringify(line.preview)}`)) return;
        continue;
      }
      if (this.handleMessage(line.value)) return;
    }
  }

  /** Returns true if the engine was stopped. */
  private handleMessage(m: Record<string, unknown>): boolean {
    if (m["jsonrpc"] !== "2.0") return this.protocolError('a message from the engine lacks "jsonrpc": "2.0"');
    const hasId = Object.hasOwn(m, "id");
    if (typeof m["method"] === "string") {
      if (hasId) return this.protocolError(`the engine sent a request (${m["method"]}); only notifications are allowed from it`);
      this.notify({ method: m["method"], params: m["params"] });
      return false;
    }
    const id = m["id"];
    if (!isInt(id)) return this.protocolError(`a reply from the engine has no usable id (${JSON.stringify(id)}): ${JSON.stringify((m["error"] as { message?: unknown } | undefined)?.message ?? "")}`);
    const entry = this.pending.get(id);
    if (entry === undefined) return this.protocolError(`a reply from the engine is for unknown id ${id}`);
    const hasResult = Object.hasOwn(m, "result");
    const hasError = Object.hasOwn(m, "error");
    if (hasResult === hasError) return this.protocolError(`the reply for id ${id} must have exactly one of result and error`);
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (hasResult) {
      entry.resolve(m["result"]);
      return false;
    }
    const e = m["error"] as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null || !isInt(e["code"]) || typeof e["message"] !== "string") {
      entry.reject(new SidecarError("protocol", `the error reply for id ${id} is malformed`));
      return this.protocolError(`the error reply for id ${id} is malformed`);
    }
    entry.reject(new SidecarError("remote", e["message"], e["code"], e["data"]));
    return false;
  }

  private notify(n: Notification): void {
    for (const h of [...this.handlers]) {
      try {
        h(n);
      } catch (e) {
        this.options.onLog?.(`a notification handler threw: ${(e as Error).message}`);
      }
    }
  }

  /** Counts a protocol error; stops the engine at the limit. Returns true if it was stopped. */
  private protocolError(reason: string): boolean {
    this.protocolErrors++;
    this.options.onProtocolError?.(reason);
    if (this.protocolErrors >= this.options.maxProtocolErrors) {
      this.failFatally(new SidecarError("protocol", `the engine sent ${this.protocolErrors} invalid messages; last: ${reason}`));
      return true;
    }
    return false;
  }

  private failFatally(error: SidecarError): void {
    if (this.fatal === undefined) this.fatal = error;
    this.kill();
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.stderrBuffer.indexOf("\n")) !== -1) {
      this.emitLog(this.stderrBuffer.slice(0, nl));
      this.stderrBuffer = this.stderrBuffer.slice(nl + 1);
    }
    if (this.stderrBuffer.length > LOG_LINE_MAX) {
      this.emitLog(this.stderrBuffer);
      this.stderrBuffer = "";
    }
  }

  private emitLog(line: string): void {
    const text = line.replace(/\r$/, "");
    if (text !== "") this.options.onLog?.(text);
  }

  private onClose(code: number | null, signal: string | null): void {
    this.ended = true;
    this.exitInfo = { code, signal };
    if (this.stderrBuffer !== "") this.emitLog(this.stderrBuffer);
    this.stderrBuffer = "";
    const error =
      this.fatal ??
      (this.closing
        ? new SidecarError("closed", "the engine was stopped")
        : new SidecarError("exited", `the engine exited with ${signal !== null ? `signal ${signal}` : `code ${code}`}`));
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
  }

  // ------------------------------------------------------------ stopping
  /** Asks the engine to shut down, waits `graceMs`, then stops it. Safe to call twice. */
  async close(graceMs = 2000): Promise<void> {
    if (this.ended) return;
    if (!this.closing) {
      this.closing = true;
      const answer = this.request("shutdown", undefined, graceMs, true).promise.catch(() => undefined);
      await Promise.race([answer, this.exited]);
      if (!this.ended) this.child.stdin.end();
    }
    const timer = setTimeout(() => this.kill(), graceMs);
    await this.exited;
    clearTimeout(timer);
  }

  kill(): void {
    this.closing = true;
    if (this.ended) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  // ------------------------------------------------------------ backtest
  /**
   * Runs a backtest. The spec is checked here first; the report is checked on the way back (shape, sums, the spec hash
   * and the engine version), so a faulty or hostile engine cannot hand the app a number the app has not verified.
   */
  async backtest(
    specInput: unknown,
    data: BacktestData,
    options: { timeoutMs?: number; onProgress?: (p: { done: number; total: number }) => void; signal?: AbortSignal; cancelGraceMs?: number } = {},
  ): Promise<BacktestReport> {
    const spec = parseBacktestSpec(specInput);
    checkData(data);
    if (!this.info.capabilities.includes("backtest.run")) throw new SidecarError("protocol", "this engine does not offer backtest.run");
    const { signal } = options;
    if (signal?.aborted) throw new SidecarError("cancelled", "the backtest was cancelled before it started");

    const run = this.request("backtest.run", { spec, data }, options.timeoutMs ?? this.options.defaultTimeoutMs);
    const off = this.onNotification((n) => {
      if (n.method !== "backtest.progress" || options.onProgress === undefined) return;
      const p = n.params as Record<string, unknown> | null;
      if (typeof p === "object" && p !== null && p["id"] === run.id && isInt(p["done"]) && isInt(p["total"])) {
        options.onProgress({ done: p["done"], total: p["total"] });
      }
    });
    const onAbort = (): void => {
      const grace = setTimeout(() => this.kill(), options.cancelGraceMs ?? 5000);
      void run.promise.then(() => clearTimeout(grace), () => clearTimeout(grace));
      this.request("backtest.cancel", { id: run.id }, options.cancelGraceMs ?? 5000, true).promise.catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let result: unknown;
      try {
        result = await run.promise;
      } catch (e) {
        if (e instanceof SidecarError && e.kind === "remote" && e.code === CANCELLED_CODE) throw new SidecarError("cancelled", e.message, e.code, e.data);
        throw e;
      }
      let report: BacktestReport;
      try {
        report = parseBacktestReport(result);
      } catch (e) {
        if (e instanceof ReportError) throw new SidecarError("protocol", `the engine's report is not valid: ${e.message}`);
        throw e;
      }
      const expected = specHash(spec);
      if (report.specHash !== expected) throw new SidecarError("protocol", `the report is about another spec: its hash is ${report.specHash}, the spec sent has ${expected}`);
      if (report.engineVersion !== this.info.engineVersion) {
        throw new SidecarError("protocol", `the report says engine ${report.engineVersion} but the engine said ${this.info.engineVersion} at hello`);
      }
      return report;
    } finally {
      off();
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
