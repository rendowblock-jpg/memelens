import { EngineUserError, type EngineService } from "@memelens/service";
import { ManagerError, SidecarError, UpdateError, type BacktestReport, type CheckResult, type UpdateConfig, type UpdateOffer } from "@memelens/sidecar";
import { describe, expect, it } from "vitest";
import { createEngineService, describeEngineError, sidecarSetup, unavailableEngine, type EngineManager } from "../src/main/engine";

const REPORT = { engineVersion: "1.0.0", specHash: "h", dataAsOf: null, positions: [], summary: {} } as unknown as BacktestReport;
const SPEC = { version: 1 };
const CONFIG = { root: "C:\\Users\\DMR\\AppData\\Local\\MemeLens\\sidecar", baseUrl: "https://example.test/x" } as unknown as UpdateConfig;
const offerOf = (version: string): UpdateOffer => ({ manifest: { engineVersion: version } as UpdateOffer["manifest"], manifestBytes: new Uint8Array([1]), signature: new Uint8Array([2]) });

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  promise.catch(() => {});
  return { promise, resolve, reject };
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Rig {
  service: EngineService;
  runs: Array<{ spec: unknown; options: { chain?: string; signal?: AbortSignal } | undefined; done: Deferred<BacktestReport> }>;
  stops: number;
  checks: number;
  installs: Array<{ offer: UpdateOffer; done: Deferred<{ version: string }> }>;
  logs: string[];
  state: { stopResult: boolean; managerStatus: { installed: string | null; running: boolean; busy: boolean; problem: string | null }; checkResult: CheckResult | Error; order: string[] };
}
function rig(opts: { update?: boolean } = {}): Rig {
  const r = {
    runs: [], stops: 0, checks: 0, installs: [], logs: [],
    state: { stopResult: true, managerStatus: { installed: "1.0.0", running: false, busy: false, problem: null }, checkResult: { kind: "up-to-date", version: "1.0.0" } as CheckResult | Error, order: [] as string[] },
  } as unknown as Rig;
  const manager: EngineManager = {
    status: () => r.state.managerStatus,
    runBacktest: (spec, options) => {
      const done = deferred<BacktestReport>();
      r.runs.push({ spec, options, done });
      return done.promise;
    },
    stopIfIdle: async () => (r.stops++, r.state.order.push("stop"), r.state.stopResult),
  };
  r.service = createEngineService({
    manager,
    ...(opts.update === false
      ? {}
      : {
          update: {
            config: CONFIG,
            check: async () => {
              r.checks++;
              if (r.state.checkResult instanceof Error) throw r.state.checkResult;
              return r.state.checkResult;
            },
            install: (_c, offer) => {
              const done = deferred<{ version: string }>();
              r.installs.push({ offer, done });
              r.state.order.push("install");
              return done.promise;
            },
          },
        }),
    log: (l) => r.logs.push(l),
  });
  return r;
}
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineUserError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal, but it resolved");
}

describe("describeEngineError", () => {
  it("says something fixed and readable for each manager error", () => {
    expect(describeEngineError(new ManagerError("closed", "x"))).toBe("the app is closing");
    expect(describeEngineError(new ManagerError("busy", "x"))).toBe("a backtest is already running");
    expect(describeEngineError(new ManagerError("not-installed", "x"))).toBe("the backtest engine is not installed");
    expect(describeEngineError(new ManagerError("damaged", "C:\\secret\\path: sha256 differs"))).toBe("the installed engine failed its integrity check; install it again");
    expect(describeEngineError(new ManagerError("start-failed", "cannot start C:\\secret\\engine.exe: EACCES"))).toBe("the engine could not be started");
  });
  it("shows the reason of an invalid spec, since it names only a field of the request", () => {
    expect(describeEngineError(new ManagerError("invalid-spec", "strategy.latencyMs: must be a whole number from 0 to 60000"))).toBe("strategy.latencyMs: must be a whole number from 0 to 60000");
  });
  it("says something fixed for each engine error, whatever the engine wrote", () => {
    expect(describeEngineError(new SidecarError("cancelled", "the backtest was cancelled before it started"))).toBe("the backtest was cancelled");
    expect(describeEngineError(new SidecarError("timeout", "no answer within 600000 ms"))).toBe("the backtest took too long and was stopped");
    expect(describeEngineError(new SidecarError("remote", "C:\\x\\app.sqlite: unable to open", -32002))).toBe("the engine could not read the trade database");
    expect(describeEngineError(new SidecarError("remote", "budget", -32003))).toBe("the backtest is larger than the engine may handle; try a shorter period or fewer wallets");
    for (const kind of ["exited", "closed", "protocol", "spawn"] as const) {
      expect(describeEngineError(new SidecarError(kind, "C:\\secret\\engine.exe went away")), kind).toBe("the engine stopped unexpectedly");
    }
  });
  it("names the field the engine refused, but only when it looks like a field path", () => {
    expect(describeEngineError(new SidecarError("remote", "invalid", -32602, { path: "$.strategy.stopLossBps" }))).toBe("the engine refused the request at $.strategy.stopLossBps");
    expect(describeEngineError(new SidecarError("remote", "invalid", -32602, { path: "$.strategy.wallets[1]" }))).toBe("the engine refused the request at $.strategy.wallets[1]");
    for (const data of [undefined, null, {}, { path: 5 }, { path: "" }, { path: "C:\\Users\\DMR\\x" }, { path: "a/b" }, { path: "a\\b" }, { path: "a:b" }, { path: "a-b" }, { path: "a b" }, { path: "x".repeat(101) }, { path: "$.a\nb" }]) {
      expect(describeEngineError(new SidecarError("remote", "invalid", -32602, data)), JSON.stringify(data)).toBe("the engine refused the request");
    }
  });
  it("says one fixed thing for any other error code from the engine", () => {
    for (const code of [-32700, -32600, -32601, -32010, 7, undefined]) {
      expect(describeEngineError(new SidecarError("remote", "C:\\secret", code)), String(code)).toBe("the engine reported an error");
    }
  });
  it("says something fixed for each update error", () => {
    expect(describeEngineError(new UpdateError("config", "baseUrl https://u:p@x"))).toBe("this build is not set up to fetch engine releases");
    expect(describeEngineError(new UpdateError("download", "cannot download https://h/x: ENOTFOUND"))).toBe("could not download the engine; check the connection and try again");
    expect(describeEngineError(new UpdateError("signature", "key abc"))).toBe("the engine release is not signed by a trusted key; nothing was installed");
    expect(describeEngineError(new UpdateError("manifest", "unknown field"))).toBe("the engine release information is not valid; nothing was installed");
    expect(describeEngineError(new UpdateError("downgrade", "1.0.0 is older than 2.0.0"))).toBe("that engine release is older than the installed one; nothing was installed");
    expect(describeEngineError(new UpdateError("self-test", "hello failed at C:\\x"))).toBe("the new engine failed its self-test; nothing was installed");
    expect(describeEngineError(new UpdateError("install", "EPERM C:\\x"))).toBe("the engine could not be installed; the previous one is unchanged");
  });
  it("does not recognise anything else", () => {
    for (const e of [new Error("x"), new TypeError("x"), "text", 5, null, undefined, {}, { kind: "busy" }]) expect(describeEngineError(e), String(e)).toBeNull();
  });
});

describe("status", () => {
  it("is the manager's status, plus whether this build can update and which version is on offer", async () => {
    const r = rig();
    expect(r.service.status()).toEqual({ installed: "1.0.0", running: false, busy: false, problem: null, canUpdate: true, offered: null });
    r.state.checkResult = { kind: "available", offer: offerOf("1.2.0") };
    await r.service.check();
    expect(r.service.status().offered).toBe("1.2.0");
    r.state.managerStatus = { installed: null, running: true, busy: true, problem: "p" };
    expect(r.service.status()).toEqual({ installed: null, running: true, busy: true, problem: "p", canUpdate: true, offered: "1.2.0" });
  });
  it("says a build without a release source cannot update", () => {
    expect(rig({ update: false }).service.status().canUpdate).toBe(false);
  });
});

describe("run", () => {
  it("gives the spec and the chain to the manager and returns its report", async () => {
    const r = rig();
    const p = r.service.run(SPEC, { chain: "base" });
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.spec).toBe(SPEC);
    expect(r.runs[0]!.options!.chain).toBe("base");
    r.runs[0]!.done.resolve(REPORT);
    expect(await p).toBe(REPORT);
  });
  it("leaves the chain out when none is given, so the manager's own is used", async () => {
    const r = rig();
    const p = r.service.run(SPEC, {});
    expect(Object.hasOwn(r.runs[0]!.options!, "chain")).toBe(false);
    r.runs[0]!.done.resolve(REPORT);
    await p;
  });
  it("turns an expected error into a readable refusal, and keeps the original in the log", async () => {
    const r = rig();
    const p = r.service.run(SPEC, {});
    r.runs[0]!.done.reject(new ManagerError("not-installed", "no engine is installed at C:\\x"));
    expect(await refusal(p)).toBe("the backtest engine is not installed");
    expect(r.logs.join("\n")).toContain("no engine is installed at C:\\x");
  });
  it("lets an unexpected error through unchanged, for the caller to report as internal", async () => {
    const r = rig();
    const boom = new TypeError("bug");
    const p = r.service.run(SPEC, {});
    r.runs[0]!.done.reject(boom);
    await expect(p).rejects.toBe(boom);
  });
  it("runs one backtest at a time: a second is refused before the manager hears of it, and the first goes on", async () => {
    const r = rig();
    const first = r.service.run(SPEC, {});
    expect(await refusal(r.service.run(SPEC, {}))).toBe("a backtest is already running");
    expect(r.runs).toHaveLength(1);
    r.runs[0]!.done.resolve(REPORT);
    expect(await first).toBe(REPORT);
    const third = r.service.run(SPEC, {});
    expect(r.runs).toHaveLength(2);
    r.runs[1]!.done.resolve(REPORT);
    await third;
  });
  it("is free again after a failed run", async () => {
    const r = rig();
    const p = r.service.run(SPEC, {});
    r.runs[0]!.done.reject(new SidecarError("timeout", "slow"));
    await refusal(p);
    const q = r.service.run(SPEC, {});
    expect(r.runs).toHaveLength(2);
    r.runs[1]!.done.resolve(REPORT);
    await q;
  });
  it("is refused while the engine is being updated", async () => {
    const r = rig();
    r.state.checkResult = { kind: "available", offer: offerOf("1.1.0") };
    await r.service.check();
    const install = r.service.install();
    await tick();
    expect(await refusal(r.service.run(SPEC, {}))).toBe("the engine is being updated; try again in a moment");
    expect(r.runs).toHaveLength(0);
    r.installs[0]!.done.resolve({ version: "1.1.0" });
    await install;
    const p = r.service.run(SPEC, {});
    r.runs[0]!.done.resolve(REPORT);
    await p;
  });
});

describe("cancel", () => {
  it("is false when nothing runs", () => {
    expect(rig().service.cancel()).toBe(false);
  });
  it("aborts the signal the manager was given, and says so once", async () => {
    const r = rig();
    const p = r.service.run(SPEC, {});
    const signal = r.runs[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    expect(r.service.cancel()).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(r.service.cancel()).toBe(false); // already told to stop
    r.runs[0]!.done.reject(new SidecarError("cancelled", "cancelled"));
    expect(await refusal(p)).toBe("the backtest was cancelled");
    expect(r.service.cancel()).toBe(false);
  });
  it("does not cancel the next run", async () => {
    const r = rig();
    const p = r.service.run(SPEC, {});
    r.service.cancel();
    r.runs[0]!.done.reject(new SidecarError("cancelled", "cancelled"));
    await refusal(p);
    const q = r.service.run(SPEC, {});
    expect(r.runs[1]!.options!.signal!.aborted).toBe(false);
    r.runs[1]!.done.resolve(REPORT);
    await q;
  });
});

describe("check", () => {
  it("says no release source when the build has none", async () => {
    const r = rig({ update: false });
    expect(await refusal(r.service.check())).toBe("this build is not set up to fetch engine releases");
    expect(await refusal(r.service.install())).toBe("this build is not set up to fetch engine releases");
  });
  it("reports up to date and older, without an offer", async () => {
    const r = rig();
    r.state.checkResult = { kind: "up-to-date", version: "1.0.0" };
    expect(await r.service.check()).toEqual({ kind: "up-to-date", version: "1.0.0" });
    r.state.checkResult = { kind: "older", latest: "0.9.0", current: "1.0.0" };
    expect(await r.service.check()).toEqual({ kind: "older", latest: "0.9.0", current: "1.0.0" });
    expect(r.service.status().offered).toBeNull();
  });
  it("reports an available version without handing out the signed bytes, and remembers the offer", async () => {
    const r = rig();
    r.state.checkResult = { kind: "available", offer: offerOf("1.2.0") };
    const info = await r.service.check();
    expect(info).toEqual({ kind: "available", version: "1.2.0" });
    expect(Object.keys(info).sort()).toEqual(["kind", "version"]);
    expect(r.service.status().offered).toBe("1.2.0");
  });
  it("forgets an offer when a later check finds nothing to install", async () => {
    const r = rig();
    r.state.checkResult = { kind: "available", offer: offerOf("1.2.0") };
    await r.service.check();
    r.state.checkResult = { kind: "up-to-date", version: "1.2.0" };
    await r.service.check();
    expect(r.service.status().offered).toBeNull();
  });
  it("keeps the earlier offer when a check fails", async () => {
    const r = rig();
    r.state.checkResult = { kind: "available", offer: offerOf("1.2.0") };
    await r.service.check();
    r.state.checkResult = new UpdateError("download", "offline");
    expect(await refusal(r.service.check())).toBe("could not download the engine; check the connection and try again");
    expect(r.service.status().offered).toBe("1.2.0");
  });
  it("is allowed while a backtest runs", async () => {
    const r = rig();
    const p = r.service.run(SPEC, {});
    expect(await r.service.check()).toEqual({ kind: "up-to-date", version: "1.0.0" });
    r.runs[0]!.done.resolve(REPORT);
    await p;
  });
});

describe("install", () => {
  async function offered(r: Rig, version = "1.2.0"): Promise<void> {
    r.state.checkResult = { kind: "available", offer: offerOf(version) };
    await r.service.check();
  }
  it("asks for a check first when there is no offer", async () => {
    const r = rig();
    expect(await refusal(r.service.install())).toBe("check for an update first");
    expect(r.installs).toEqual([]);
    expect(r.stops).toBe(0);
  });
  it("stops an idle engine, installs the offered release, forgets the offer and reports the version", async () => {
    const r = rig();
    await offered(r);
    const p = r.service.install();
    await tick();
    expect(r.state.order).toEqual(["stop", "install"]); // the files are free before they are replaced
    expect(r.installs[0]!.offer.manifest.engineVersion).toBe("1.2.0");
    r.installs[0]!.done.resolve({ version: "1.2.0" });
    expect(await p).toEqual({ version: "1.2.0" });
    expect(r.service.status().offered).toBeNull();
  });
  it("refuses while a backtest runs, installs nothing, and keeps the offer", async () => {
    const r = rig();
    await offered(r);
    const run = r.service.run(SPEC, {});
    expect(await refusal(r.service.install())).toBe("a backtest is running; wait for it to finish, then install");
    expect(r.installs).toEqual([]);
    expect(r.stops).toBe(0);
    expect(r.service.status().offered).toBe("1.2.0");
    r.runs[0]!.done.resolve(REPORT);
    await run;
  });
  it("refuses when the manager says the engine is busy after all, and releases the install lock", async () => {
    const r = rig();
    await offered(r);
    r.state.stopResult = false;
    expect(await refusal(r.service.install())).toBe("a backtest is running; wait for it to finish, then install");
    expect(r.installs).toEqual([]);
    r.state.stopResult = true;
    const p = r.service.install();
    await tick();
    expect(r.installs).toHaveLength(1);
    r.installs[0]!.done.resolve({ version: "1.2.0" });
    await p;
  });
  it("does not run two installs at once", async () => {
    const r = rig();
    await offered(r);
    const first = r.service.install();
    await tick();
    expect(await refusal(r.service.install())).toBe("the engine is being updated; try again in a moment");
    expect(r.installs).toHaveLength(1);
    r.installs[0]!.done.resolve({ version: "1.2.0" });
    await first;
  });
  it("turns a failed install into a readable refusal, keeps the offer, and is usable again", async () => {
    const r = rig();
    await offered(r);
    const p = r.service.install();
    await tick();
    r.installs[0]!.done.reject(new UpdateError("self-test", "hello failed"));
    expect(await refusal(p)).toBe("the new engine failed its self-test; nothing was installed");
    expect(r.service.status().offered).toBe("1.2.0");
    const q = r.service.run(SPEC, {});
    r.runs[0]!.done.resolve(REPORT);
    await q;
  });
  it("lets an unexpected error through and still releases the lock", async () => {
    const r = rig();
    await offered(r);
    const boom = new TypeError("bug");
    const p = r.service.install();
    await tick();
    r.installs[0]!.done.reject(boom);
    await expect(p).rejects.toBe(boom);
    const q = r.service.install();
    await tick();
    expect(r.installs).toHaveLength(2);
    r.installs[1]!.done.resolve({ version: "1.2.0" });
    await q;
  });
  it("does not install the same offer twice", async () => {
    const r = rig();
    await offered(r);
    const p = r.service.install();
    await tick();
    r.installs[0]!.done.resolve({ version: "1.2.0" });
    await p;
    expect(await refusal(r.service.install())).toBe("check for an update first");
  });
});

describe("sidecarSetup", () => {
  const WIN = { LOCALAPPDATA: "C:\\Users\\DMR\\AppData\\Local" };
  it("is the per-user folder", () => {
    expect(sidecarSetup(WIN, "C:\\Users\\DMR", "win32")).toEqual({ root: "C:\\Users\\DMR\\AppData\\Local\\MemeLens\\sidecar" });
    expect(sidecarSetup({}, "/home/d", "linux")).toEqual({ root: "/home/d/.local/share/memelens/sidecar" });
  });
  it("is the folder MEMELENS_SIDECAR_DIR names", () => {
    expect(sidecarSetup({ ...WIN, MEMELENS_SIDECAR_DIR: "D:\\engines" }, "C:\\Users\\DMR", "win32")).toEqual({ root: "D:\\engines" });
  });
  it("says the engine is unavailable, and why, when the folder cannot be worked out", () => {
    const missing = sidecarSetup({}, "C:\\Users\\DMR", "win32");
    expect(missing).toEqual({ unavailable: "LOCALAPPDATA is not set to an absolute path" });
    const relative = sidecarSetup({ ...WIN, MEMELENS_SIDECAR_DIR: "secret-relative-folder" }, "C:\\Users\\DMR", "win32") as { unavailable: string };
    expect(relative.unavailable).toMatch(/MEMELENS_SIDECAR_DIR/);
    expect(relative.unavailable).not.toContain("secret-relative-folder"); // the value is never repeated
  });
  it("uses this machine's platform when none is given", () => {
    const got = sidecarSetup(process.platform === "win32" ? { LOCALAPPDATA: "C:\\x" } : {}, process.platform === "win32" ? "C:\\h" : "/home/d");
    expect("root" in got).toBe(true);
  });
  it("does not hide a bug: an error that is not about the folder is thrown", () => {
    const env = new Proxy({}, { get: () => { throw new TypeError("bug"); } }) as Record<string, string | undefined>;
    expect(() => sidecarSetup(env, "/home/d", "linux")).toThrow(TypeError);
  });
});

describe("unavailableEngine", () => {
  const e = unavailableEngine("LOCALAPPDATA is not set to an absolute path");
  it("shows the reason as the problem, with nothing installed", () => {
    expect(e.status()).toEqual({ installed: null, running: false, busy: false, problem: "LOCALAPPDATA is not set to an absolute path", canUpdate: false, offered: null });
  });
  it("refuses to run, check and install, giving the reason", async () => {
    for (const call of [() => e.run(SPEC, {}), () => e.check(), () => e.install()]) {
      expect(await refusal(call())).toBe("the backtest engine is unavailable: LOCALAPPDATA is not set to an absolute path");
    }
  });
  it("has nothing to cancel", () => {
    expect(e.cancel()).toBe(false);
  });
});
