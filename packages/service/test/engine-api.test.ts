import type { BacktestReport } from "@memelens/sidecar";
import { describe, expect, it } from "vitest";
import { ENGINE_CHANNELS, EngineUserError, handleEngine, type EngineService, type EngineStatusInfo, type UpdateInfo } from "../src/engine-api";

const REPORT = { engineVersion: "1.0.0", specHash: "h", dataAsOf: null, positions: [], summary: {} } as unknown as BacktestReport;
const STATUS: EngineStatusInfo = { installed: "1.0.0", running: false, busy: false, problem: null, canUpdate: true, offered: null };
const SPEC = { version: 1, from: 0, to: 10 };

interface Calls { name: string; args: unknown[] }
function fakeEngine(over: Partial<EngineService> = {}): { engine: EngineService; calls: Calls[] } {
  const calls: Calls[] = [];
  const note = <T>(name: string, value: T) => (...args: unknown[]): T => (calls.push({ name, args }), value);
  const engine: EngineService = {
    status: note("status", STATUS),
    run: async (...args) => (calls.push({ name: "run", args }), REPORT),
    cancel: note("cancel", true),
    check: async (...args) => (calls.push({ name: "check", args }), { kind: "up-to-date", version: "1.0.0" } as UpdateInfo),
    install: async (...args) => (calls.push({ name: "install", args }), { version: "1.1.0" }),
    ...over,
  };
  return { engine, calls };
}
const error = async (p: Promise<unknown>): Promise<string> => {
  const r = (await p) as { ok: boolean; error?: string };
  expect(r.ok).toBe(false);
  return r.error!;
};

describe("ENGINE_CHANNELS", () => {
  it("are these five, in this order", () => {
    expect([...ENGINE_CHANNELS]).toEqual(["engineStatus", "engineRun", "engineCancel", "engineCheck", "engineInstall"]);
  });
});

describe("handleEngine: the answers", () => {
  it("answers each channel from the matching method of the engine", async () => {
    const { engine, calls } = fakeEngine();
    expect(await handleEngine(engine, "engineStatus", undefined)).toEqual({ ok: true, data: STATUS });
    expect(await handleEngine(engine, "engineRun", { spec: SPEC })).toEqual({ ok: true, data: REPORT });
    expect(await handleEngine(engine, "engineCancel", {})).toEqual({ ok: true, data: { cancelled: true } });
    expect(await handleEngine(engine, "engineCheck", {})).toEqual({ ok: true, data: { kind: "up-to-date", version: "1.0.0" } });
    expect(await handleEngine(engine, "engineInstall", {})).toEqual({ ok: true, data: { version: "1.1.0" } });
    expect(calls.map((c) => c.name)).toEqual(["status", "run", "cancel", "check", "install"]);
  });
  it("passes the spec through untouched, and the chain when there is one", async () => {
    const { engine, calls } = fakeEngine();
    await handleEngine(engine, "engineRun", { spec: SPEC });
    await handleEngine(engine, "engineRun", { spec: SPEC, chain: "solana" });
    expect(calls[0]!.args).toStrictEqual([SPEC, {}]);
    expect(calls[1]!.args).toStrictEqual([SPEC, { chain: "solana" }]);
    expect((calls[0]!.args[0] as object) === SPEC).toBe(true);
  });
  it("reports 'not cancelled' when nothing was running", async () => {
    const { engine } = fakeEngine({ cancel: () => false });
    expect(await handleEngine(engine, "engineCancel", undefined)).toEqual({ ok: true, data: { cancelled: false } });
  });
  it("hands out each kind of check result", async () => {
    for (const info of [{ kind: "older", latest: "1.0.0", current: "2.0.0" }, { kind: "available", version: "3.0.0" }] as UpdateInfo[]) {
      const { engine } = fakeEngine({ check: async () => info });
      expect(await handleEngine(engine, "engineCheck", {})).toEqual({ ok: true, data: info });
    }
  });
});

describe("handleEngine: what it refuses before the engine is asked anything", () => {
  it("refuses an unknown channel, including the data channels, and one that is not text", async () => {
    const { engine, calls } = fakeEngine();
    for (const channel of ["nope", "overview", "feed", "", "engineStatus ", "ENGINESTATUS", "__proto__", "toString", 5, null, undefined, {}, ["engineStatus"]]) {
      expect(await error(handleEngine(engine, channel, {})), String(channel)).toBe("unknown channel");
    }
    expect(calls).toEqual([]);
  });
  it("refuses a payload on the channels that take none", async () => {
    const { engine, calls } = fakeEngine();
    for (const channel of ["engineStatus", "engineCancel", "engineCheck", "engineInstall"]) {
      for (const payload of [{ a: 1 }, [], null, 0, "x", true, () => 1]) {
        expect(await error(handleEngine(engine, channel, payload)), `${channel} ${String(payload)}`).toBe(`${channel}: takes no payload`);
      }
    }
    expect(calls).toEqual([]);
  });
  it("accepts no payload and an empty object, also one without a prototype", async () => {
    const { engine } = fakeEngine();
    for (const payload of [undefined, {}, Object.create(null)]) {
      expect((await handleEngine(engine, "engineStatus", payload)).ok).toBe(true);
    }
  });
  it("refuses a run without a usable payload", async () => {
    const { engine, calls } = fakeEngine();
    expect(await error(handleEngine(engine, "engineRun", undefined))).toBe("engineRun: payload must be an object");
    for (const payload of [null, 5, "x", [], [SPEC]]) {
      expect(await error(handleEngine(engine, "engineRun", payload)), JSON.stringify(payload)).toBe("engineRun: payload must be an object");
    }
    expect(await error(handleEngine(engine, "engineRun", {}))).toBe("engineRun: spec is required");
    expect(await error(handleEngine(engine, "engineRun", { spec: undefined }))).toBe("engineRun: spec is required");
    for (const spec of [null, 5, "x", [], true]) {
      expect(await error(handleEngine(engine, "engineRun", { spec })), JSON.stringify(spec)).toBe("engineRun: spec must be an object");
    }
    expect(calls).toEqual([]);
  });
  it("refuses a run payload with another field, naming it", async () => {
    const { engine, calls } = fakeEngine();
    expect(await error(handleEngine(engine, "engineRun", { spec: SPEC, path: "C:\\x" }))).toBe('engineRun: unknown field "path"');
    expect(await error(handleEngine(engine, "engineRun", { spec: SPEC, path: 1, data: 2 }))).toBe('engineRun: unknown fields "path", "data"');
    expect(calls).toEqual([]);
  });
  it("refuses a chain that is not plain text", async () => {
    const { engine, calls } = fakeEngine();
    const message = "engineRun: chain must be text of 1 to 200 characters with no spaces";
    for (const chain of ["", "a b", "a\nb", "a\u0000b", "x".repeat(201), 5, null, {}, ["solana"]]) {
      expect(await error(handleEngine(engine, "engineRun", { spec: SPEC, chain })), JSON.stringify(chain)).toBe(message);
    }
    expect((await handleEngine(engine, "engineRun", { spec: SPEC, chain: "x".repeat(200) })).ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["run"]);
  });
  it("treats a chain that is undefined as not given", async () => {
    const { engine, calls } = fakeEngine();
    await handleEngine(engine, "engineRun", { spec: SPEC, chain: undefined });
    expect(calls[0]!.args).toStrictEqual([SPEC, {}]);
  });
});

describe("handleEngine: when the engine fails", () => {
  it("shows the message of an EngineUserError and nothing else", async () => {
    const reported: unknown[] = [];
    const { engine } = fakeEngine({ run: async () => { throw new EngineUserError("the backtest engine is not installed"); } });
    expect(await handleEngine(engine, "engineRun", { spec: SPEC }, (e) => reported.push(e))).toEqual({ ok: false, error: "the backtest engine is not installed" });
    expect(reported).toEqual([]);
  });
  it("hides every other error behind 'internal error' and gives it to the sink", async () => {
    const reported: unknown[] = [];
    const secret = new Error("cannot open C:\\Users\\DMR\\AppData\\secret.sqlite");
    for (const channel of ["engineStatus", "engineRun", "engineCancel", "engineCheck", "engineInstall"]) {
      const boom = async (): Promise<never> => { throw secret; };
      const { engine } = fakeEngine({ status: () => { throw secret; }, run: boom, cancel: () => { throw secret; }, check: boom, install: boom });
      const reply = await handleEngine(engine, channel, channel === "engineRun" ? { spec: SPEC } : {}, (e) => reported.push(e));
      expect(reply, channel).toEqual({ ok: false, error: "internal error" });
    }
    expect(reported).toHaveLength(5);
    expect(reported.every((e) => e === secret)).toBe(true);
  });
  it("does not throw when the sink throws, or when there is no sink", async () => {
    const { engine } = fakeEngine({ status: () => { throw new Error("x"); } });
    expect(await handleEngine(engine, "engineStatus", {}, () => { throw new Error("sink broke"); })).toEqual({ ok: false, error: "internal error" });
    expect(await handleEngine(engine, "engineStatus", {})).toEqual({ ok: false, error: "internal error" });
  });
  it("calls an answer that cannot be sent as plain data an internal error", async () => {
    const reported: unknown[] = [];
    const { engine } = fakeEngine({ status: () => ({ ...STATUS, installed: Number.NaN as unknown as string }) });
    expect(await handleEngine(engine, "engineStatus", {}, (e) => reported.push(e))).toEqual({ ok: false, error: "internal error" });
    expect(reported).toHaveLength(1);
  });
});
