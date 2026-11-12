import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "@memelens/data";
import { CHANNELS, handle, STORE_CHANNELS } from "../src/api";
import { ENGINE_CHANNELS } from "../src/engine-api";
import { feed, overview, smartDetail, tokenDetail, walletDetail } from "../src/service";
import { toWire } from "../src/wire";
import { C, closeAll, load, scenario } from "./scenario";

afterEach(closeAll);

/** A store whose connection is already closed, so every query fails. Not shared with the other tests. */
function closedStore(): Store {
  const s = Store.open(":memory:");
  s.close();
  return s;
}

function ok(r: ReturnType<typeof handle>): unknown {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.data;
}
function err(r: ReturnType<typeof handle>): string {
  if (r.ok) throw new Error("expected an error, got ok");
  return r.error;
}

describe("handle: the five channels", () => {
  it("lists exactly these data channels", () => {
    expect([...STORE_CHANNELS]).toEqual(["overview", "feed", "token", "wallet", "smart"]);
  });

  it("lists every channel the window can use: the data channels, then the engine channels, each once", () => {
    expect([...CHANNELS]).toEqual([...STORE_CHANNELS, ...ENGINE_CHANNELS]);
    expect(new Set(CHANNELS).size).toBe(CHANNELS.length);
  });

  it("does not answer an engine channel: those go through handleEngine", async () => {
    const store = await load(scenario());
    for (const channel of ENGINE_CHANNELS) expect(handle(store, channel, {}), channel).toEqual({ ok: false, error: "unknown channel" });
  });

  it("answers each one with the service result converted to JSON-safe data", async () => {
    const store = await load(scenario());
    expect(ok(handle(store, "overview", undefined))).toEqual(toWire(overview(store)));
    expect(ok(handle(store, "feed", { chain: C, asOf: 3500 }))).toEqual(toWire(feed(store, C, 3500)));
    expect(ok(handle(store, "feed", { chain: C }))).toEqual(toWire(feed(store, C)));
    expect(ok(handle(store, "token", { chain: C, token: "A", asOf: 4000 }))).toEqual(toWire(tokenDetail(store, C, "A", 4000)));
    expect(ok(handle(store, "wallet", { chain: C, wallet: "w1", asOf: 4000 }))).toEqual(toWire(walletDetail(store, C, "w1", 4000)));
    expect(ok(handle(store, "smart", { chain: C, from: 0, to: 6000, minClosed: 1 }))).toEqual(
      toWire(smartDetail(store, C, { from: 0, to: 6000, minClosed: 1 })),
    );
  });

  it("sends amounts as decimal strings and the whole reply survives JSON", async () => {
    const store = await load(scenario());
    const r = handle(store, "feed", { chain: C, asOf: 3500 });
    const a = (ok(r) as { rows: Array<{ token: string; volumeQuote: unknown; lastPrice: { amount: unknown } }> }).rows.find((x) => x.token === "A")!;
    expect(a.volumeQuote).toBe("1600");
    expect(a.lastPrice.amount).toBe("40");
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("answers an unknown token with ok and null, not an error", async () => {
    const store = await load(scenario());
    expect(handle(store, "token", { chain: C, token: "nope" })).toEqual({ ok: true, data: null });
  });

  it("accepts as-of 0 and an explicit undefined for an optional field", async () => {
    const store = await load(scenario());
    expect(ok(handle(store, "feed", { chain: C, asOf: 0 }))).toMatchObject({ asOf: 0, rows: [] });
    expect(ok(handle(store, "feed", { chain: C, asOf: undefined }))).toMatchObject({ asOf: 6000 });
    expect(ok(handle(store, "smart", { chain: C, from: 0, to: 10, minClosed: undefined }))).toBeDefined();
  });
});

describe("handle: the channel", () => {
  it("refuses anything that is not one of the five names, including names an object lookup would find", async () => {
    const store = await load(scenario());
    for (const bad of ["nope", "", "Feed", " feed", "feed ", "feed2", "feedback", "overviews", "feed\n", "constructor", "__proto__", "toString", "hasOwnProperty", 5, null, undefined, {}, [], Symbol("feed")]) {
      expect(err(handle(store, bad, { chain: C })), String(typeof bad === "symbol" ? "symbol" : JSON.stringify(bad))).toMatch(/unknown channel/);
    }
  });
});

describe("handle: the payload", () => {
  it("overview takes nothing: undefined or an empty object, no more", async () => {
    const store = await load(scenario());
    expect(handle(store, "overview", undefined).ok).toBe(true);
    expect(handle(store, "overview", {}).ok).toBe(true);
    expect(err(handle(store, "overview", { chain: C }))).toMatch(/overview.*chain/);
    expect(err(handle(store, "overview", null))).toMatch(/overview/);
    expect(err(handle(store, "overview", 5))).toMatch(/overview/);
  });

  it("must be a plain object for every other channel", async () => {
    const store = await load(scenario());
    for (const channel of ["feed", "token", "wallet", "smart"]) {
      for (const bad of [undefined, null, [], [{ chain: C }], "solana", 5, true, () => 1, new Map(), Object.create({ chain: C })]) {
        expect(err(handle(store, channel, bad)), `${channel} ${String(bad)}`).toMatch(new RegExp(`^${channel}: .*object`));
      }
    }
  });

  it("accepts an object with no prototype (a plain dictionary)", async () => {
    const store = await load(scenario());
    const payload = Object.assign(Object.create(null) as Record<string, unknown>, { chain: C, asOf: 3500 });
    expect(ok(handle(store, "feed", payload))).toEqual(toWire(feed(store, C, 3500)));
  });

  it("refuses keys it does not know and names them", async () => {
    const store = await load(scenario());
    expect(err(handle(store, "feed", { chain: C, extra: 1 }))).toMatch(/feed: unknown field "extra"/);
    expect(err(handle(store, "feed", { chain: C, a: 1, b: 2 }))).toMatch(/"a".*"b"/);
    expect(err(handle(store, "wallet", { chain: C, wallet: "w1", token: "A" }))).toMatch(/unknown field "token"/);
    const polluted = JSON.parse('{"chain":"solana","__proto__":{"x":1}}');
    expect(err(handle(store, "feed", polluted))).toMatch(/unknown field "__proto__"/);
  });

  it("names a missing required field", async () => {
    const store = await load(scenario());
    expect(err(handle(store, "feed", {}))).toMatch(/feed: chain is required/);
    expect(err(handle(store, "token", { chain: C }))).toMatch(/token: token is required/);
    expect(err(handle(store, "wallet", { chain: C }))).toMatch(/wallet: wallet is required/);
    expect(err(handle(store, "smart", { chain: C, to: 5 }))).toMatch(/smart: from is required/);
    expect(err(handle(store, "smart", { chain: C, from: 5 }))).toMatch(/smart: to is required/);
  });

  it("checks text fields: a string of 1 to 200 characters with no spaces or control characters", async () => {
    const store = await load(scenario());
    const bad = [5, null, true, [], {}, "", " ", "a b", " a", "a ", "a\nb", "a\u0000b", "a\tb", "x".repeat(201)];
    for (const v of bad) {
      expect(err(handle(store, "feed", { chain: v })), `chain ${JSON.stringify(v)}`).toMatch(/feed: chain must be text/);
      expect(err(handle(store, "token", { chain: C, token: v })), `token ${JSON.stringify(v)}`).toMatch(/token: token must be text/);
      expect(err(handle(store, "wallet", { chain: C, wallet: v })), `wallet ${JSON.stringify(v)}`).toMatch(/wallet: wallet must be text/);
    }
    expect(handle(store, "feed", { chain: "x".repeat(200) }).ok).toBe(false); // valid shape, but no such chain: an ordinary error
    expect(err(handle(store, "feed", { chain: "x".repeat(200) }))).toMatch(/unknown chain/);
  });

  it("checks number fields: whole, 0 or more, within the safe range", async () => {
    const store = await load(scenario());
    const bad = ["5", null, true, [], {}, -1, 0.5, NaN, Infinity, -Infinity, 2 ** 53, 1e300];
    for (const v of bad) {
      const label = typeof v === "number" ? String(v) : JSON.stringify(v);
      expect(err(handle(store, "feed", { chain: C, asOf: v })), `asOf ${label}`).toMatch(/feed: asOf must be a whole number/);
      expect(err(handle(store, "token", { chain: C, token: "A", asOf: v })), `asOf ${label}`).toMatch(/token: asOf must be a whole number/);
      expect(err(handle(store, "wallet", { chain: C, wallet: "w1", asOf: v })), `asOf ${label}`).toMatch(/wallet: asOf must be a whole number/);
      expect(err(handle(store, "smart", { chain: C, from: v, to: 5 })), `from ${label}`).toMatch(/smart: from must be a whole number/);
      expect(err(handle(store, "smart", { chain: C, from: 0, to: v })), `to ${label}`).toMatch(/smart: to must be a whole number/);
    }
    for (const v of ["1", null, true, 0, 0.5, -1, NaN, Infinity]) {
      expect(err(handle(store, "smart", { chain: C, from: 0, to: 5, minClosed: v })), `minClosed ${String(v)}`).toMatch(/smart: minClosed must be a whole number of at least 1/);
    }
    expect(handle(store, "smart", { chain: C, from: 0, to: Number.MAX_SAFE_INTEGER, minClosed: 1 }).ok).toBe(true);
  });
});

describe("handle: failures", () => {
  it("passes a service error on as a readable message", async () => {
    const store = await load(scenario());
    expect(err(handle(store, "feed", { chain: "nope" }))).toMatch(/unknown chain "nope"/);
    expect(err(handle(store, "smart", { chain: C, from: 10, to: 5 }))).toMatch(/from must not be after to/);
  });

  it("turns an unexpected failure into 'internal error', tells the sink, and leaks nothing", async () => {
    const store = closedStore();
    const sink = vi.fn();
    const r = handle(store, "feed", { chain: C }, sink);
    expect(r).toEqual({ ok: false, error: "internal error" });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("does not call the sink for ordinary, expected errors", async () => {
    const store = await load(scenario());
    const sink = vi.fn();
    handle(store, "feed", { chain: "nope" }, sink);
    handle(store, "feed", {}, sink);
    handle(store, "nope", {}, sink);
    expect(sink).not.toHaveBeenCalled();
  });

  it("never throws, even when reading the payload throws or the sink itself throws", async () => {
    const store = await load(scenario());
    const hostile = {
      get chain(): string {
        throw new Error("boom");
      },
    };
    expect(handle(store, "feed", hostile)).toEqual({ ok: false, error: "internal error" });
    expect(
      handle(closedStore(), "feed", { chain: C }, () => {
        throw new Error("sink broke");
      }),
    ).toEqual({ ok: false, error: "internal error" });
  });
});
