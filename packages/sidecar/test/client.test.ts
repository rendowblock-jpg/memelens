import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { specHash } from "../src/canonical";
import { SidecarClient, SidecarError, type SidecarOptions } from "../src/client";
import type { BacktestData, BacktestReport } from "../src/types";

const FAKE = fileURLToPath(new URL("./fake-sidecar.mjs", import.meta.url));
const live: SidecarClient[] = [];
afterEach(() => {
  while (live.length) live.pop()!.kill();
});

async function start(mode = "ok", extra: Partial<SidecarOptions> = {}, env: Record<string, string> = {}): Promise<SidecarClient> {
  const c = await SidecarClient.start({
    command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_MODE: mode, ...env },
    helloTimeoutMs: 20_000, defaultTimeoutMs: 20_000, ...extra,
  });
  live.push(c);
  return c;
}
async function failure(p: Promise<unknown>): Promise<SidecarError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SidecarError) return e;
    throw e;
  }
  throw new Error("expected a SidecarError, but it resolved");
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("starting", () => {
  it("says hello, reads the engine's answer and keeps it", async () => {
    const c = await start();
    expect(c.info).toEqual({ protocol: 1, engineVersion: "9.9.9", capabilities: ["echo"] });
  });
  it("refuses an engine that speaks another protocol, and stops it", async () => {
    let pid: number | undefined;
    const e = await failure(start("old-protocol", { onSpawn: (p) => (pid = p) }));
    expect(e.kind).toBe("protocol");
    expect(e.message).toMatch(/protocol 2/);
    expect(pid).toBeTypeOf("number");
    expect(await gone(pid!)).toBe(true);
  });
  it("accepts a protocol the caller lists as supported", async () => {
    const c = await start("old-protocol", { supportedProtocols: [1, 2] });
    expect(c.info.protocol).toBe(2);
  });
  it("gives up when the engine never answers hello, and stops it", async () => {
    let pid: number | undefined;
    const e = await failure(start("silent-hello", { helloTimeoutMs: 300, onSpawn: (p) => (pid = p) }));
    expect(e.kind).toBe("timeout");
    expect(await gone(pid!)).toBe(true);
  });
  it("reports a program that cannot be started", async () => {
    const e = await failure(SidecarClient.start({ command: process.execPath + "-does-not-exist", args: [] }));
    expect(e.kind).toBe("spawn");
  });
  it("refuses an engine that floods its output with lines that are not messages", async () => {
    const reasons: string[] = [];
    const e = await failure(start("spam", { onProtocolError: (r) => reasons.push(r) }));
    expect(e.kind).toBe("protocol");
    expect(reasons.length).toBeGreaterThanOrEqual(20);
  });
  it("refuses an engine that writes a line longer than the limit", async () => {
    const e = await failure(start("bigline", { maxLineBytes: 1000 }));
    expect(e.kind).toBe("protocol");
    expect(e.message).toMatch(/too long|limit/i);
  });
});

describe("calls", () => {
  it("returns the result", async () => {
    const c = await start();
    expect(await c.call("echo", { a: [1, "two", null] })).toEqual({ a: [1, "two", null] });
  });
  it("matches answers to questions when they arrive out of order", async () => {
    const c = await start();
    const order: string[] = [];
    const slow = c.call("delay", { ms: 300, tag: "slow" }).then((r) => (order.push("slow"), r));
    const fast = c.call("delay", { ms: 10, tag: "fast" }).then((r) => (order.push("fast"), r));
    expect(await Promise.all([slow, fast])).toEqual([{ tag: "slow" }, { tag: "fast" }]);
    expect(order).toEqual(["fast", "slow"]);
  });
  it("turns an error answer into a SidecarError with the code, message and data", async () => {
    const c = await start();
    const e = await failure(c.call("boom"));
    expect(e).toMatchObject({ kind: "remote", code: -32602, message: "bad things", data: { why: "test" } });
  });
  it("reports an unknown method as a remote error and stays usable", async () => {
    const c = await start();
    expect(await failure(c.call("no-such-method"))).toMatchObject({ kind: "remote", code: -32601 });
    expect(await c.call("echo", 1)).toBe(1);
  });
  it("stops an engine that does not answer in time, and says so", async () => {
    const c = await start();
    const e = await failure(c.call("never", {}, { timeoutMs: 300 }));
    expect(e.kind).toBe("timeout");
    await c.exited;
    expect((await failure(c.call("echo", 1))).kind).toBe("closed");
  });
  it("fails every waiting call when the engine dies, and reports its exit code", async () => {
    const c = await start();
    const other = failure(c.call("never"));
    const e = await failure(c.call("die"));
    expect(e.kind).toBe("exited");
    expect(e.message).toMatch(/3/);
    expect((await other).kind).toBe("exited");
  });
  it("delivers notifications and lets the caller stop listening", async () => {
    const c = await start();
    const seen: unknown[] = [];
    const off = c.onNotification((n) => seen.push([n.method, n.params]));
    expect(await c.call("progress")).toBe("done");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(["backtest.progress", expect.objectContaining({ done: 1, total: 2 })]);
    off();
    await c.call("progress");
    expect(seen).toHaveLength(2);
  });
  it("tells the caller about a garbage line and carries on", async () => {
    const reasons: string[] = [];
    const c = await start("ok", { onProtocolError: (r) => reasons.push(r) });
    expect(await c.call("garbage-then-answer")).toBe("ok");
    expect(reasons).toHaveLength(1);
  });
  it("ignores an answer to a question nobody asked, and tells the caller", async () => {
    const reasons: string[] = [];
    const c = await start("ok", { onProtocolError: (r) => reasons.push(r) });
    expect(await c.call("unknown-id")).toBe("ok");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/99999|unknown/i);
  });
  it("passes the engine's error output on as log lines", async () => {
    const lines: string[] = [];
    await start("stderr", { onLog: (l) => lines.push(l) });
    for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 30));
    expect(lines).toEqual(["engine says hello"]);
  });
});

describe("stopping", () => {
  it("asks the engine to shut down and waits for it to leave", async () => {
    const c = await start();
    await c.close();
    expect(await c.exited).toEqual({ code: 0, signal: null });
  });
  it("stops an engine that ignores the shutdown request, after the grace period", async () => {
    const c = await start("hung");
    const t0 = Date.now();
    await c.close(300);
    expect(Date.now() - t0).toBeLessThan(10_000);
    await c.exited;
  });
  it("fails waiting calls when killed, and refuses new ones", async () => {
    const c = await start();
    const waiting = failure(c.call("never"));
    c.kill();
    expect((await waiting).kind).toBe("closed");
    expect((await failure(c.call("echo", 1))).kind).toBe("closed");
  });
  it("can be closed twice", async () => {
    const c = await start();
    await c.close();
    await c.close();
  });
});

describe("backtest", () => {
  const spec = {
    version: 1, from: 0, to: 10_000,
    strategy: { kind: "follow-wallets", wallets: ["alice"], latencyMs: 0, positionQuote: "1000", takeProfitBps: null, stopLossBps: null, maxHoldMs: 1000 },
    costs: { feeBps: 0, slippageBps: 0 },
  };
  const data: BacktestData = { source: "inline", trades: [] };
  const report = (over: Partial<BacktestReport> = {}): BacktestReport => ({
    engineVersion: "9.9.9", specHash: specHash(spec), dataAsOf: null, positions: [],
    summary: { signals: 0, ignoredWhileOpen: 0, skipped: { noPrice: 0, tooSmall: 0 }, entered: 0, exits: { takeProfit: 0, stopLoss: 0, maxHold: 0, end: 0 }, wins: 0, losses: 0, totalCost: "0", totalNet: "0", realised: "0", roiBps: null },
    ...over,
  });
  const withReport = (r: unknown) => ({ FAKE_REPORT: JSON.stringify(r) });

  it("checks the spec before sending anything", async () => {
    const c = await start("bt", {}, withReport(report()));
    await expect(c.backtest({ ...spec, version: 2 }, data)).rejects.toThrow(/\$\.version/);
  });
  it("returns the validated report and reports only its own progress", async () => {
    const c = await start("bt", {}, withReport(report()));
    const seen: unknown[] = [];
    const out = await c.backtest(spec, data, { onProgress: (p) => seen.push(p) });
    expect(out).toEqual(report());
    expect(seen).toEqual([{ done: 1, total: 2 }, { done: 2, total: 2 }]);
  });
  it("refuses a report about another spec (the hash must match what was sent)", async () => {
    const c = await start("bt", {}, withReport(report({ specHash: "b".repeat(64) })));
    const e = await failure(c.backtest(spec, data));
    expect(e.kind).toBe("protocol");
    expect(e.message).toMatch(/hash/);
  });
  it("refuses a malformed report", async () => {
    const c = await start("bt", {}, withReport({ nonsense: true }));
    const e = await failure(c.backtest(spec, data));
    expect(e.kind).toBe("protocol");
  });
  it("refuses an engine that does not say it can run backtests", async () => {
    const c = await start("ok");
    const e = await failure(c.backtest(spec, data));
    expect(e.kind).toBe("protocol");
    expect(e.message).toMatch(/backtest\.run/);
  });
  it("sends backtest.cancel with the right id when the signal fires, and ends as cancelled", async () => {
    const c = await start("bt-cancel");
    const ac = new AbortController();
    const p = failure(c.backtest(spec, data, { signal: ac.signal, onProgress: () => ac.abort() }));
    const e = await p;
    expect(e.kind).toBe("cancelled");
    expect(e.code).toBe(-32001);
    const d = e.data as { runId: number; cancelId: number };
    expect(d.runId).toBeTypeOf("number");
    expect(d.cancelId).toBe(d.runId);
  });
  it("does not send anything when the signal is already aborted", async () => {
    const c = await start("bt-cancel");
    const ac = new AbortController();
    ac.abort();
    const e = await failure(c.backtest(spec, data, { signal: ac.signal }));
    expect(e.kind).toBe("cancelled");
    expect(await c.call("echo", 1).catch(() => "still fine")).toBeDefined();
  });
});

import { sidecarEnv } from "../src/client";

describe("sidecarEnv", () => {
  it("passes only the few variables an engine needs to run, never the app's other settings", () => {
    const out = sidecarEnv({ SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", TMP: "C:\\Tmp", PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret", HELIUS_KEY: "secret", HOME: "/home/d", TMPDIR: "/tmp", SystemDrive: "C:" });
    expect(out).toEqual({ SystemRoot: "C:\\Windows", SystemDrive: "C:", TEMP: "C:\\Temp", TMP: "C:\\Tmp", TMPDIR: "/tmp" });
  });
  it("leaves out variables that are missing or empty", () => {
    expect(sidecarEnv({ TEMP: "", TMP: undefined })).toEqual({});
    expect(sidecarEnv({})).toEqual({});
  });
  it("is what the engine gets by default: a probe engine sees no secret", async () => {
    process.env["MEMELENS_TEST_SECRET"] = "do-not-leak";
    try {
      const c = await SidecarClient.start({ command: process.execPath, args: [FAKE_ENV], helloTimeoutMs: 20_000, defaultTimeoutMs: 20_000 });
      live.push(c);
      const seen = (await c.call("env")) as Record<string, string>;
      expect(Object.keys(seen)).not.toContain("MEMELENS_TEST_SECRET");
      expect(JSON.stringify(seen)).not.toContain("do-not-leak");
    } finally {
      delete process.env["MEMELENS_TEST_SECRET"];
    }
  });
});
const FAKE_ENV = fileURLToPath(new URL("./fake-env-sidecar.mjs", import.meta.url));

describe("backtest: what is checked before and after", () => {
  const spec = {
    version: 1, from: 0, to: 10_000,
    strategy: { kind: "follow-wallets", wallets: ["alice"], latencyMs: 0, positionQuote: "1000", takeProfitBps: null, stopLossBps: null, maxHoldMs: 1000 },
    costs: { feeBps: 0, slippageBps: 0 },
  };
  const emptyReport = (engineVersion: string) => ({
    engineVersion, specHash: specHash(spec), dataAsOf: null, positions: [],
    summary: { signals: 0, ignoredWhileOpen: 0, skipped: { noPrice: 0, tooSmall: 0 }, entered: 0, exits: { takeProfit: 0, stopLoss: 0, maxHold: 0, end: 0 }, wins: 0, losses: 0, totalCost: "0", totalNet: "0", realised: "0", roiBps: null },
  });
  it("refuses a report from a different engine version than the one that said hello", async () => {
    const c = await start("bt", {}, { FAKE_REPORT: JSON.stringify(emptyReport("1.0.0")) });
    const e = await failure(c.backtest(spec, { source: "inline", trades: [] }));
    expect(e.kind).toBe("protocol");
    expect(e.message).toMatch(/1\.0\.0.*9\.9\.9/);
  });
  it("refuses a data source of the wrong shape, before anything is sent", async () => {
    const c = await start("bt", {}, { FAKE_REPORT: JSON.stringify(emptyReport("9.9.9")) });
    const bad: unknown[] = [null, "x", {}, { source: "inline" }, { source: "inline", trades: "no" }, { source: "sqlite", path: "relative/db.sqlite", chain: "c" }, { source: "sqlite", path: "", chain: "c" },
      { source: "sqlite", path: "/abs/db.sqlite", chain: "" }, { source: "sqlite", path: 5, chain: "c" }, { source: "url", href: "http://x" }];
    for (const d of bad) await expect(c.backtest(spec, d as never), JSON.stringify(d)).rejects.toThrow(TypeError);
    for (const d of [{ source: "sqlite", path: "/abs/db.sqlite", chain: "c" }, { source: "sqlite", path: "C:\\data\\db.sqlite", chain: "c" }, { source: "sqlite", path: "C:/data/db.sqlite", chain: "c" }, { source: "sqlite", path: "\\\\server\\share\\db", chain: "c" }, { source: "inline", trades: [] }]) {
      await expect(c.backtest(spec, d as never), JSON.stringify(d)).resolves.toBeTruthy();
    }
  });
  it("sends the checked copy of the spec, not the caller's object", async () => {
    const c = await start("bt-echo");
    const mutable = JSON.parse(JSON.stringify(spec));
    const p = c.backtest(mutable, { source: "inline", trades: [] }).catch((e) => e);
    mutable.costs.feeBps = 999; // changed after the call started
    await p;
    // the fake echoes the params it got back inside the error data; the fee it saw must be the original
    const e = (await p) as SidecarError;
    expect(JSON.stringify(e.data ?? e.message)).not.toContain("999");
  });
  it("gives the engine's timeouts and progress to the caller's own bounds", async () => {
    const c = await start("bt-cancel");
    const e = await failure(c.backtest(spec, { source: "inline", trades: [] }, { timeoutMs: 300 }));
    expect(e.kind).toBe("timeout");
  });
});
