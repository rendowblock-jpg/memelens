import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ReplayAdapter, Store, ingest, parseFixture } from "@memelens/data";
import { CHANNELS, handle, type Api } from "@memelens/service";
import { loadFeed, loadOverview, loadSmart, loadToken, loadWallet, MIN_CLOSED_TOKENS, pickChain } from "./controller";

// The api below is the real handler over the real pipeline (fixture -> store), as the window sees it through the
// preload script. Expected values come from the fixture by hand (see views.test.tsx for the same data).

const FIXTURE = fileURLToPath(new URL("../../../../packages/data/fixtures/sample.json", import.meta.url));
const store = Store.open(":memory:");
await ingest(store, new ReplayAdapter(parseFixture(JSON.parse(readFileSync(FIXTURE, "utf8")))));
afterAll(() => store.close());

const LATEST = 1_700_020_700_000;

function realApi(seen: { channel: string; request: unknown }[] = []): Api {
  const api: Record<string, (request: unknown) => Promise<unknown>> = {};
  for (const channel of CHANNELS) {
    api[channel] = async (request) => {
      seen.push({ channel, request });
      return handle(store, channel, request);
    };
  }
  return api as unknown as Api;
}

describe("pickChain", () => {
  it("takes the first chain that has data", () => {
    expect(pickChain([{ chain: "a", latestTime: null }, { chain: "b", latestTime: 5 }, { chain: "c", latestTime: 9 }])).toBe("b");
  });
  it("is null when there are no chains or none has data", () => {
    expect(pickChain([])).toBeNull();
    expect(pickChain([{ chain: "a", latestTime: null }])).toBeNull();
  });
  it("counts time 0 as data", () => {
    expect(pickChain([{ chain: "a", latestTime: 0 }])).toBe("a");
  });
});

describe("loading through the real handler", () => {
  it("overview: the chains and their newest data time", async () => {
    const r = await loadOverview(realApi());
    if (r.state !== "ok") throw new Error(r.message);
    expect(r.data.chains.map((c) => [c.chain, c.latestTime])).toEqual([["synthetic", LATEST]]);
  });

  it("feed: five tokens, newest first", async () => {
    const r = await loadFeed(realApi(), "synthetic");
    if (r.state !== "ok") throw new Error(r.message);
    expect(r.data.rows.map((x) => x.token)).toEqual(["TOK5", "TOK4", "TOK3", "TOK2", "TOK1"]);
  });

  it("feed: passes the as-of time on, and an earlier time shows fewer tokens", async () => {
    const seen: { channel: string; request: unknown }[] = [];
    const r = await loadFeed(realApi(seen), "synthetic", 1_700_007_200_000);
    expect(seen).toEqual([{ channel: "feed", request: { chain: "synthetic", asOf: 1_700_007_200_000 } }]);
    if (r.state !== "ok") throw new Error(r.message);
    expect(r.data.rows.map((x) => x.token)).toEqual(["TOK2", "TOK1"]);
  });

  it("feed: leaves asOf out of the request when none is given", async () => {
    const seen: { channel: string; request: unknown }[] = [];
    await loadFeed(realApi(seen), "synthetic");
    expect(seen[0]!.request).toEqual({ chain: "synthetic" });
  });

  it("feed: an unknown chain is an error with the service's own words", async () => {
    const r = await loadFeed(realApi(), "nope");
    expect(r.state).toBe("error");
    if (r.state === "error") expect(r.message).toContain('unknown chain "nope"');
  });

  it("token: detail for a known token", async () => {
    const r = await loadToken(realApi(), "synthetic", "TOK5");
    if (r.state !== "ok") throw new Error(r.message);
    expect(r.data?.info.symbol).toBe("SYN5");
  });

  it("token: an unknown token is ok with no data (not an error)", async () => {
    const r = await loadToken(realApi(), "synthetic", "NOPE");
    expect(r).toEqual({ state: "ok", data: null });
  });

  it("wallet: alice's trades", async () => {
    const r = await loadWallet(realApi(), "synthetic", "alice");
    if (r.state !== "ok") throw new Error(r.message);
    expect(r.data.wallet).toBe("alice");
    expect(r.data.trades).toBeGreaterThan(0);
  });

  it("smart: asks for the window and the minimum from the shared constants, and ranks alice first", async () => {
    const seen: { channel: string; request: unknown }[] = [];
    const r = await loadSmart(realApi(seen), "synthetic", LATEST, "7d");
    expect(seen).toEqual([{ channel: "smart", request: { chain: "synthetic", from: 1_699_415_900_000, to: LATEST, minClosed: MIN_CLOSED_TOKENS } }]);
    if (r.state !== "ok") throw new Error(r.message);
    expect(MIN_CLOSED_TOKENS).toBe(5);
    expect(r.data.report.ranked[0]).toMatchObject({ address: "alice", realised: "5000000", rank: 1 });
  });

  it("smart: a window that ends before any trade ranks nobody and drops nobody silently", async () => {
    const r = await loadSmart(realApi(), "synthetic", 1_000, "all");
    if (r.state !== "ok") throw new Error(r.message);
    expect(r.data.report.ranked).toEqual([]);
  });

  it("smart: a bad time becomes an error value, not a throw", async () => {
    const r = await loadSmart(realApi(), "synthetic", -5, "7d");
    expect(r.state).toBe("error");
  });
});

describe("a broken api never makes a loader throw", () => {
  const throwing = { overview: async () => { throw new Error("secret path /x/y"); } } as unknown as Api;
  const garbage = { overview: async () => "nonsense", feed: async () => null, token: async () => ({ ok: "yes" }) } as unknown as Api;
  const odd = { feed: async () => ({ ok: false, error: 42 }) } as unknown as Api;

  it("a rejected call is 'request failed', without the reason", async () => {
    expect(await loadOverview(throwing)).toEqual({ state: "error", message: "request failed" });
  });
  it("a reply of the wrong shape is reported as unexpected", async () => {
    expect(await loadOverview(garbage)).toEqual({ state: "error", message: "the app gave an unexpected reply" });
    expect(await loadFeed(garbage, "c")).toEqual({ state: "error", message: "the app gave an unexpected reply" });
    expect(await loadToken(garbage, "c", "t")).toEqual({ state: "error", message: "the app gave an unexpected reply" });
  });
  it("an error reply without a text message becomes 'request failed'", async () => {
    expect(await loadFeed(odd, "c")).toEqual({ state: "error", message: "request failed" });
  });
});
