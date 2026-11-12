import { describe, expect, it } from "vitest";
import { handleSample, SAMPLE_CHANNELS, SampleUserError, type SampleLoaded, type SampleService } from "../src/sample-api";

const LOADED: SampleLoaded = { chain: "synthetic", tokens: 5, trades: 40 };

function fake(over: Partial<SampleService> = {}): { service: SampleService; calls: () => number } {
  let n = 0;
  const service: SampleService = { load: async () => (n++, LOADED), ...over };
  return { service, calls: () => n };
}

describe("SAMPLE_CHANNELS", () => {
  it("is exactly loadSample", () => {
    expect([...SAMPLE_CHANNELS]).toEqual(["loadSample"]);
  });
});

describe("handleSample: the answer", () => {
  it("loads the sample and returns what was loaded", async () => {
    const { service, calls } = fake();
    expect(await handleSample(service, "loadSample", undefined)).toEqual({ ok: true, data: LOADED });
    expect(calls()).toBe(1);
  });
  it("accepts an empty object and one without a prototype as 'no payload'", async () => {
    for (const payload of [{}, Object.create(null)]) expect((await handleSample(fake().service, "loadSample", payload)).ok).toBe(true);
  });
  it("hands the answer on as plain data", async () => {
    const reply = await handleSample(fake({ load: async () => ({ ...LOADED, tokens: 7 }) }).service, "loadSample", {});
    expect(reply).toEqual({ ok: true, data: { chain: "synthetic", tokens: 7, trades: 40 } });
  });
});

describe("handleSample: what it refuses before the service is asked anything", () => {
  it("refuses every other channel, including the data and engine ones, and anything that is not text", async () => {
    const { service, calls } = fake();
    for (const channel of ["nope", "overview", "engineRun", "", "loadSample ", "LOADSAMPLE", "__proto__", 5, null, undefined, {}, ["loadSample"]]) {
      expect(await handleSample(service, channel, {}), String(channel)).toEqual({ ok: false, error: "unknown channel" });
    }
    expect(calls()).toBe(0);
  });
  it("refuses a payload", async () => {
    const { service, calls } = fake();
    for (const payload of [{ a: 1 }, { path: "C:\\x" }, [], null, 0, "x", true, () => 1]) {
      expect(await handleSample(service, "loadSample", payload), String(payload)).toEqual({ ok: false, error: "loadSample: takes no payload" });
    }
    expect(calls()).toBe(0);
  });
});

describe("handleSample: when the service fails", () => {
  it("shows the message of a SampleUserError and nothing else, without reporting it", async () => {
    const reported: unknown[] = [];
    const service = fake({ load: async () => { throw new SampleUserError("this database already holds data"); } }).service;
    expect(await handleSample(service, "loadSample", {}, (e) => reported.push(e))).toEqual({ ok: false, error: "this database already holds data" });
    expect(reported).toEqual([]);
  });
  it("hides any other error behind 'internal error' and gives it to the sink", async () => {
    const reported: unknown[] = [];
    const secret = new Error("cannot open C:\\Users\\DMR\\AppData\\secret.sqlite");
    const service = fake({ load: async () => { throw secret; } }).service;
    expect(await handleSample(service, "loadSample", {}, (e) => reported.push(e))).toEqual({ ok: false, error: "internal error" });
    expect(reported).toEqual([secret]);
  });
  it("does not throw when the sink throws, or when there is none", async () => {
    const service = fake({ load: async () => { throw new Error("x"); } }).service;
    expect(await handleSample(service, "loadSample", {}, () => { throw new Error("sink broke"); })).toEqual({ ok: false, error: "internal error" });
    expect(await handleSample(service, "loadSample", {})).toEqual({ ok: false, error: "internal error" });
  });
  it("calls an answer that cannot be sent as plain data an internal error", async () => {
    const reported: unknown[] = [];
    const service = fake({ load: async () => ({ ...LOADED, tokens: Number.NaN }) }).service;
    expect(await handleSample(service, "loadSample", {}, (e) => reported.push(e))).toEqual({ ok: false, error: "internal error" });
    expect(reported).toHaveLength(1);
  });
});
