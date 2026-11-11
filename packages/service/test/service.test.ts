import { afterEach, describe, expect, it } from "vitest";
import { Store } from "@memelens/data";
import { feed, overview, ServiceError, smartDetail, tokenDetail, walletDetail } from "../src/service";
import { toWire } from "../src/wire";
import { C, closeAll, load, scenario, snap, tok, trade, truncate } from "./scenario";

afterEach(closeAll);

describe("overview", () => {
  it("is empty for an empty database", () => {
    const s = Store.open(":memory:");
    expect(overview(s)).toEqual({ chains: [] });
    s.close();
  });

  it("gives counts and the newest data time per chain, sorted by chain id", async () => {
    const store = await load(scenario());
    const other = scenario();
    other.chain = "base";
    const { ingest, ReplayAdapter } = await import("@memelens/data");
    await ingest(store, new ReplayAdapter({ ...other, trades: [], snapshots: [] }), { now: 1 });
    const o = overview(store);
    expect(o.chains.map((c) => c.chain)).toEqual(["base", "solana"]);
    expect(o.chains[1]).toEqual({ chain: "solana", latestTime: 6000, counts: { tokens: 3, trades: 6, snapshots: 2, rejects: 0 } });
    expect(o.chains[0]!.counts).toEqual({ tokens: 3, trades: 0, snapshots: 0, rejects: 0 });
    expect(o.chains[0]!.latestTime).toBe(3000);
  });

  it("counts rejected items per chain", async () => {
    const store = await load(scenario());
    store.recordReject({ chain: C, kind: "trade", ref: "bad", reason: "x", raw: "{}", at: 1 });
    expect(overview(store).chains[0]!.counts.rejects).toBe(1);
  });
});

describe("feed", () => {
  it("lists tokens newest first with trade count, volume, last price, holders and risk, as of a time", async () => {
    const store = await load(scenario());
    const f = feed(store, C, 3500);
    expect(f.chain).toBe(C);
    expect(f.asOf).toBe(3500);
    expect(f.rows.map((r) => r.token)).toEqual(["C", "B", "A"]);

    const [c, b, a] = f.rows as [typeof f.rows[0], typeof f.rows[0], typeof f.rows[0]];

    expect(c).toMatchObject({ token: "C", symbol: "c", createdAt: 3000, ageMs: 500, trades: 1, volumeQuote: 0n, lastPrice: null, holders: null, top10Share: null });
    expect(c.risk.level).toBe("unknown");

    expect(b).toMatchObject({ token: "B", ageMs: 1500, trades: 1, volumeQuote: 500n, lastPrice: { amount: 50n, quote: 500n }, holders: null, top10Share: null });

    expect(a).toMatchObject({ token: "A", ageMs: 2500, trades: 2, volumeQuote: 1600n, lastPrice: { amount: 40n, quote: 600n }, holders: 12 });
    expect(a.top10Share).toBeCloseTo(470 / 490, 9);
    expect(a.risk.hardFlags).toContain("mintAuthority");
    expect(["high", "critical"]).toContain(a.risk.level);
    expect(a.risk.coverage).toBeGreaterThan(0);
    expect(a.risk.score).toBeGreaterThan(0);
  });

  it("defaults the as-of time to the newest data on the chain and uses the newest snapshot", async () => {
    const store = await load(scenario());
    const f = feed(store, C);
    expect(f.asOf).toBe(6000);
    const a = f.rows.find((r) => r.token === "A")!;
    // t4 is a free transfer: it counts as a trade but is not a price; the last price stays t3.
    expect(a).toMatchObject({ trades: 4, volumeQuote: 1800n, lastPrice: { amount: 10n, quote: 200n }, holders: 3, ageMs: 5000 });
    expect(a.top10Share).toBe(1);
  });

  it("does not list a token before it was created, and is empty (not an error) before anything exists on a known chain", async () => {
    const store = await load(scenario());
    expect(feed(store, C, 1500).rows.map((r) => r.token)).toEqual(["A"]);
    expect(feed(store, C, 1500).rows[0]).toMatchObject({ trades: 0, volumeQuote: 0n, lastPrice: null, holders: null, ageMs: 500 });
    expect(feed(store, C, 999).rows).toEqual([]);
  });

  it("breaks ties between tokens created at the same time by address", async () => {
    const data = scenario();
    data.tokens = [tok("Z", { createdAt: 5 }), tok("M", { createdAt: 5 }), tok("N", { createdAt: 9 })];
    data.trades = [];
    data.snapshots = [];
    const store = await load(data);
    expect(feed(store, C).rows.map((r) => r.token)).toEqual(["N", "M", "Z"]);
  });

  it("refuses a chain with no data", async () => {
    const store = await load(scenario());
    expect(() => feed(store, "nope")).toThrow(ServiceError);
    expect(() => feed(store, "nope")).toThrow(/unknown chain "nope"/);
  });

  it("refuses an as-of time that is not a whole, non-negative number of milliseconds", async () => {
    const store = await load(scenario());
    for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => feed(store, C, bad), String(bad)).toThrow(ServiceError);
      expect(() => tokenDetail(store, C, "A", bad), String(bad)).toThrow(ServiceError);
      expect(() => walletDetail(store, C, "w1", bad), String(bad)).toThrow(ServiceError);
    }
    expect(() => feed(store, C, 0)).not.toThrow();
  });

  it("shows the same risk numbers as the token detail does", async () => {
    const store = await load(scenario());
    for (const row of feed(store, C, 4000).rows) {
      const r = tokenDetail(store, C, row.token, 4000)!.risk.report;
      expect(row.risk, row.token).toEqual({ score: r.score, level: r.level, coverage: r.coverage, hardFlags: r.hardFlags });
    }
    // and they are not all the same number, so a constant would be noticed
    expect(new Set(feed(store, C, 4000).rows.map((r) => r.risk.coverage)).size).toBeGreaterThan(1);
  });

  it("reports an unknown holder count as null when the snapshot has nobody countable", async () => {
    const data = scenario();
    data.snapshots = [snap("A", 3000, [["POOL", 600n]])];
    const store = await load(data);
    const a = feed(store, C, 3500).rows.find((r) => r.token === "A")!;
    expect(a.holders).toBeNull();
    expect(a.top10Share).toBeNull();
  });
});

describe("tokenDetail", () => {
  it("gives info, trades, price, risk with its unavailable reasons, concentration and the top holders", async () => {
    const store = await load(scenario());
    const d = tokenDetail(store, C, "A", 4000)!;
    expect(d.chain).toBe(C);
    expect(d.asOf).toBe(4000);
    expect(d.info).toMatchObject({ token: "A", creator: "CRE", mintAuthorityActive: true, excluded: ["POOL"] });
    expect(d.trades).toBe(3);
    expect(d.lastPrice).toEqual({ amount: 10n, quote: 200n });

    expect(d.risk.snapshotTime).toBe(3000);
    expect(d.risk.report.hardFlags).toContain("mintAuthority");
    expect(d.risk.unavailable.creatorDumps).toMatch(/no data source/);
    expect(d.risk.unavailable.liquidity).toBeDefined();

    expect(d.concentration).not.toBeNull();
    const c = d.concentration!;
    expect(c.snapshotTime).toBe(3000);
    expect(c.snapshotAgeMs).toBe(1000);
    expect(c.value.holders).toBe(12);
    expect(c.value.total).toBe(490n);

    // POOL is not a holder. Ties (10 each) are broken by address, so h1..h7 are in and h8, h9 are out.
    expect(c.topHolders.map((x) => x.address)).toEqual(["CRE", "w1", "w9", "h1", "h2", "h3", "h4", "h5", "h6", "h7"]);
    expect(c.topHolders.map((x) => x.amount)).toEqual([300n, 60n, 40n, 10n, 10n, 10n, 10n, 10n, 10n, 10n]);
    expect(c.topHolders[0]!.share).toBeCloseTo(300 / 490, 9);
    expect(c.topHolders[3]!.share).toBeCloseTo(10 / 490, 9);

    expect(d.recentTrades.map((t) => t.id)).toEqual(["t3", "t2", "t1"]);
  });

  it("leaves out a holder with a zero balance, as the concentration numbers do", async () => {
    const store = await load(scenario());
    const c = tokenDetail(store, C, "A", 6000)!.concentration!;
    expect(c.value.holders).toBe(3);
    expect(c.topHolders.map((h) => h.address)).toEqual(["w2", "CRE", "w1"]);
  });

  it("adds up a duplicated address the way the concentration numbers do", async () => {
    const store = await load(scenario());
    // ingest refuses this shape, but the store itself does not, so the detail view must not be fooled by it
    store.insertSnapshot(C, snap("A", 7000, [["x", 5n], ["x", 7n], ["y", 1n]]));
    const c = tokenDetail(store, C, "A", 7000)!.concentration!;
    expect(c.value.holders).toBe(2);
    expect(c.value.total).toBe(13n);
    expect(c.topHolders.map((h) => [h.address, h.amount])).toEqual([["x", 12n], ["y", 1n]]);
    expect(c.topHolders[0]!.share).toBeCloseTo(12 / 13, 9);
  });

  it("has no concentration and unavailable concentration signals when there is no snapshot", async () => {
    const store = await load(scenario());
    const d = tokenDetail(store, C, "B", 4000)!;
    expect(d.concentration).toBeNull();
    expect(d.risk.snapshotTime).toBeNull();
    expect(d.risk.unavailable.top10Share).toMatch(/no holder snapshot/);
  });

  it("returns at most the 20 newest trades, newest first, ties by id", async () => {
    const data = scenario();
    data.trades = [];
    for (let i = 1; i <= 25; i++) data.trades.push(trade(`x${String(i).padStart(2, "0")}`, { time: 2000 + Math.floor(i / 2), token: "A" }));
    const store = await load(data);
    const d = tokenDetail(store, C, "A", 6000)!;
    expect(d.trades).toBe(25);
    expect(d.recentTrades).toHaveLength(20);
    // times: i=25 -> 2012; i=24 -> 2012; i=23 -> 2011; ... newest first, and within one time the larger id first
    expect(d.recentTrades.slice(0, 4).map((t) => t.id)).toEqual(["x25", "x24", "x23", "x22"]);
    expect(d.recentTrades[19]!.id).toBe("x06");
  });

  it("is null for an unknown token and for a token not yet created", async () => {
    const store = await load(scenario());
    expect(tokenDetail(store, C, "nope", 6000)).toBeNull();
    expect(tokenDetail(store, C, "C", 2999)).toBeNull();
    expect(tokenDetail(store, C, "C", 3000)).not.toBeNull();
  });

  it("refuses a chain with no data", async () => {
    const store = await load(scenario());
    expect(() => tokenDetail(store, "nope", "A")).toThrow(/unknown chain/);
  });
});

describe("walletDetail", () => {
  it("gives FIFO PnL as of a time, marked at the last price", async () => {
    const store = await load(scenario());
    const w = walletDetail(store, C, "w1", 4000);
    expect(w.wallet).toBe("w1");
    expect(w.trades).toBe(3);
    // A: bought 100 for 1000, sold 40 for 600 -> realised 200; 60 open (cost 600) marked at 20 each = 1200 -> unrealised 600
    // B: bought 50 for 500, marked at 10 each -> unrealised 0
    expect(w.pnl.totals).toMatchObject({ realised: 200n, unrealised: 600n, unmarkedTokens: [] });
    expect(w.pnl.tokens.map((t) => t.token)).toEqual(["A", "B"]);
  });

  it("includes later trades when the as-of time moves on", async () => {
    const store = await load(scenario());
    const w = walletDetail(store, C, "w1");
    expect(w.asOf).toBe(6000);
    expect(w.trades).toBe(4);
    // t4 adds 5 free tokens: 65 open, cost still 600, marked at 20 each = 1300 -> unrealised 700
    expect(w.pnl.totals).toMatchObject({ realised: 200n, unrealised: 700n });
  });

  it("is an empty report, not an error, for a wallet that never traded", async () => {
    const store = await load(scenario());
    const w = walletDetail(store, C, "nobody", 6000);
    expect(w.trades).toBe(0);
    expect(w.pnl.tokens).toEqual([]);
    expect(w.pnl.totals).toMatchObject({ realised: 0n, unrealised: 0n });
  });

  it("refuses a chain with no data", async () => {
    const store = await load(scenario());
    expect(() => walletDetail(store, "nope", "w1")).toThrow(/unknown chain/);
  });
});

describe("smartDetail", () => {
  it("ranks profitable wallets with enough closed tokens and lists the rest with a reason", async () => {
    const store = await load(scenario());
    const r = smartDetail(store, C, { from: 0, to: 6000, minClosed: 1 });
    expect(r).toMatchObject({ chain: C, from: 0, to: 6000 });
    expect(r.report.ranked).toHaveLength(1);
    expect(r.report.ranked[0]).toMatchObject({ address: "w1", rank: 1, realised: 200n, closedTokens: 1, wins: 1, hitRate: 1 });
    expect(r.report.unranked.map((w) => [w.address, w.reason])).toEqual([
      ["w2", "too-few-closed-tokens"],
      ["w3", "too-few-closed-tokens"],
    ]);
  });

  it("uses the core default of 5 closed tokens when none is given", async () => {
    const store = await load(scenario());
    const r = smartDetail(store, C, { from: 0, to: 6000 });
    expect(r.report.ranked).toEqual([]);
    expect(r.report.unranked.find((w) => w.address === "w1")!.reason).toBe("too-few-closed-tokens");
  });

  it("never looks at trades after the window end", async () => {
    const store = await load(scenario());
    const r = smartDetail(store, C, { from: 0, to: 2999, minClosed: 1 });
    expect(r.report.ranked).toEqual([]); // t2 (the sell) is at 3000
    expect(r.report.unranked.map((w) => w.address)).toEqual(["w1"]); // only w1 had traded by 2999
  });

  it("refuses a bad window or minimum with its own error (not whatever core happens to throw)", async () => {
    const store = await load(scenario());
    expect(() => smartDetail(store, C, { from: 10, to: 5 })).toThrow(ServiceError);
    expect(() => smartDetail(store, C, { from: 10, to: 5 })).toThrow(/from.*to/);
    expect(() => smartDetail(store, C, { from: -1, to: 5 })).toThrow(ServiceError);
    expect(() => smartDetail(store, C, { from: 0.5, to: 5 })).toThrow(ServiceError);
    expect(() => smartDetail(store, C, { from: 0, to: 5.5 })).toThrow(ServiceError);
    expect(() => smartDetail(store, C, { from: 0, to: 5, minClosed: 0 })).toThrow(ServiceError);
    expect(() => smartDetail(store, C, { from: 0, to: 5, minClosed: 0 })).toThrow(/minClosed/);
    expect(() => smartDetail(store, C, { from: 0, to: 5, minClosed: 1.5 })).toThrow(ServiceError);
    expect(() => smartDetail(store, "nope", { from: 0, to: 5 })).toThrow(ServiceError);
    expect(() => smartDetail(store, "nope", { from: 0, to: 5 })).toThrow(/unknown chain/);
  });

  it("accepts a window of a single instant, and includes trades exactly on it", async () => {
    const store = await load(scenario());
    const r = smartDetail(store, C, { from: 3000, to: 3000, minClosed: 1 });
    // t2 (w1 sells 40 for 600 against 100 bought for 1000) happens at exactly 3000
    expect(r.report.ranked).toHaveLength(1);
    expect(r.report.ranked[0]).toMatchObject({ address: "w1", realised: 200n, closedTokens: 1 });
  });
});

describe("no look-ahead", () => {
  const times = [1000, 1500, 2500, 3000, 3500, 4000, 5000, 6000];

  it("every view as of T is identical on the full data and on data that stops at T", async () => {
    const full = await load(scenario());
    for (const t of times) {
      const cut = await load(truncate(scenario(), t));
      expect(toWire(feed(full, C, t)), `feed @${t}`).toEqual(toWire(feed(cut, C, t)));
      for (const token of ["A", "B", "C"]) {
        expect(toWire(tokenDetail(full, C, token, t)), `token ${token} @${t}`).toEqual(toWire(tokenDetail(cut, C, token, t)));
      }
      for (const w of ["w1", "w2", "w3"]) {
        expect(toWire(walletDetail(full, C, w, t)), `wallet ${w} @${t}`).toEqual(toWire(walletDetail(cut, C, w, t)));
      }
      expect(toWire(smartDetail(full, C, { from: 0, to: t, minClosed: 1 })), `smart @${t}`).toEqual(
        toWire(smartDetail(cut, C, { from: 0, to: t, minClosed: 1 })),
      );
    }
  });

  it("the views really do change over time, so the check above can fail", async () => {
    const full = await load(scenario());
    const seen = new Set(times.map((t) => JSON.stringify(toWire(feed(full, C, t)))));
    expect(seen.size).toBe(times.length);
  });
});

describe("wire safety", () => {
  it("every view converts to JSON-safe data", async () => {
    const store = await load(scenario());
    expect(() => toWire(overview(store))).not.toThrow();
    expect(() => toWire(feed(store, C))).not.toThrow();
    for (const token of ["A", "B", "C"]) expect(() => toWire(tokenDetail(store, C, token))).not.toThrow();
    expect(() => toWire(walletDetail(store, C, "w1"))).not.toThrow();
    expect(() => toWire(smartDetail(store, C, { from: 0, to: 6000, minClosed: 1 }))).not.toThrow();
  });
});
