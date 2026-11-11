import { CHANNELS } from "@memelens/service";
import { describe, expect, it } from "vitest";
import { createApi, PRELOAD_CHANNELS } from "../src/preload/api";

describe("PRELOAD_CHANNELS", () => {
  it("is the same list as the service package's, in the same order", () => {
    expect([...PRELOAD_CHANNELS]).toEqual([...CHANNELS]);
  });
});

describe("createApi", () => {
  it("has one function per channel and nothing else", () => {
    const api = createApi(async () => undefined);
    expect(Object.keys(api).sort()).toEqual([...CHANNELS].sort());
    for (const name of CHANNELS) expect(typeof api[name], name).toBe("function");
  });

  it("is frozen", () => {
    const api = createApi(async () => undefined);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it("sends each call over its own channel with the request unchanged, and returns the reply as it came", async () => {
    const calls: Array<[string, unknown]> = [];
    const reply = { ok: true, data: { marker: 1 } };
    const api = createApi(async (channel, payload) => {
      calls.push([channel, payload]);
      return reply;
    });
    const requests: Record<string, unknown> = {
      overview: {},
      feed: { chain: "c", asOf: 5 },
      token: { chain: "c", token: "t" },
      wallet: { chain: "c", wallet: "w" },
      smart: { chain: "c", from: 1, to: 2 },
    };
    for (const name of CHANNELS) {
      const got = await (api[name] as (r: unknown) => Promise<unknown>)(requests[name]);
      expect(got, name).toBe(reply);
    }
    expect(calls).toEqual(CHANNELS.map((name) => [name, requests[name]]));
  });

  it("turns a failed call into an error reply without leaking the reason", async () => {
    const api = createApi(async () => {
      throw new Error("C:\\secret\\path exploded");
    });
    for (const name of CHANNELS) {
      const got = await (api[name] as (r: unknown) => Promise<unknown>)({});
      expect(got, name).toEqual({ ok: false, error: "request failed" });
    }
  });

  it("turns a call that throws before returning a promise into an error reply too", async () => {
    const api = createApi(() => {
      throw new Error("sync boom");
    });
    expect(await api.overview({})).toEqual({ ok: false, error: "request failed" });
  });

  it("does not let one call's failure affect the next", async () => {
    let n = 0;
    const api = createApi(async () => {
      if (n++ === 0) throw new Error("first fails");
      return { ok: true, data: 2 };
    });
    expect(await api.overview({})).toEqual({ ok: false, error: "request failed" });
    expect(await api.overview({})).toEqual({ ok: true, data: 2 });
  });
});
