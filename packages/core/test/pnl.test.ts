import { describe, expect, it } from "vitest";
import { computePnl, type Mark, type Side, type Trade } from "../src/pnl";

function t(
  id: string,
  time: number,
  token: string,
  side: Side,
  amount: bigint,
  quote: bigint,
  fee?: bigint,
): Trade {
  return fee === undefined
    ? { id, time, token, side, amount, quote }
    : { id, time, token, side, amount, quote, fee };
}

function only(trades: Trade[], options = {}) {
  const r = computePnl(trades, options);
  expect(r.tokens).toHaveLength(1);
  return r.tokens[0]!;
}

describe("computePnl - basics", () => {
  it("returns an empty report for no trades", () => {
    const r = computePnl([]);
    expect(r.tokens).toEqual([]);
    expect(r.totals).toEqual({ realised: 0n, unrealised: 0n, unmarkedTokens: [], unmatchedProceeds: 0n });
  });

  it("a buy alone leaves an open position and no realised PnL", () => {
    const p = only([t("1", 1, "X", "buy", 100n, 1000n)]);
    expect(p.boughtAmount).toBe(100n);
    expect(p.buyCost).toBe(1000n);
    expect(p.openAmount).toBe(100n);
    expect(p.openCost).toBe(1000n);
    expect(p.realised).toBe(0n);
    expect(p.soldAmount).toBe(0n);
  });

  it("buy then full sell at a profit", () => {
    const p = only([t("1", 1, "X", "buy", 100n, 1000n), t("2", 2, "X", "sell", 100n, 1500n)]);
    expect(p.realised).toBe(500n);
    expect(p.realisedCost).toBe(1000n);
    expect(p.realisedProceeds).toBe(1500n);
    expect(p.openAmount).toBe(0n);
    expect(p.openCost).toBe(0n);
    expect(p.unrealised).toBe(0n);
  });

  it("buy then full sell at a loss", () => {
    const p = only([t("1", 1, "X", "buy", 100n, 1000n), t("2", 2, "X", "sell", 100n, 400n)]);
    expect(p.realised).toBe(-600n);
  });

  it("consumes the oldest lot first (FIFO)", () => {
    // lot A: 100 units cost 100; lot B: 100 units cost 300; sell 150 for 600.
    // matched cost = 100 (all of A) + 150 (half of B) = 250.
    const p = only([
      t("1", 1, "X", "buy", 100n, 100n),
      t("2", 2, "X", "buy", 100n, 300n),
      t("3", 3, "X", "sell", 150n, 600n),
    ]);
    expect(p.realisedCost).toBe(250n);
    expect(p.realised).toBe(350n);
    expect(p.openAmount).toBe(50n);
    expect(p.openCost).toBe(150n);
  });

  it("adds buy fees to cost and deducts sell fees from proceeds", () => {
    const p = only([
      t("1", 1, "X", "buy", 100n, 1000n, 10n),
      t("2", 2, "X", "sell", 100n, 1500n, 15n),
    ]);
    expect(p.buyCost).toBe(1010n);
    expect(p.sellProceeds).toBe(1485n);
    expect(p.realised).toBe(475n);
  });

  it("splits a lot exactly when the cost does not divide evenly", () => {
    // 3 units cost 10. Sell 1: matched cost floor(10/3) = 3, lot keeps 2 units / cost 7.
    const first = only([t("1", 1, "X", "buy", 3n, 10n), t("2", 2, "X", "sell", 1n, 5n)]);
    expect(first.realisedCost).toBe(3n);
    expect(first.realised).toBe(2n);
    expect(first.openAmount).toBe(2n);
    expect(first.openCost).toBe(7n);
    // Sell the other 2: the remaining cost 7 is used up exactly, nothing is lost.
    const second = only([
      t("1", 1, "X", "buy", 3n, 10n),
      t("2", 2, "X", "sell", 1n, 5n),
      t("3", 3, "X", "sell", 2n, 9n),
    ]);
    expect(second.realisedCost).toBe(10n);
    expect(second.realised).toBe(4n); // (5 + 9) - 10
    expect(second.openAmount).toBe(0n);
    expect(second.openCost).toBe(0n);
  });

  it("keeps full precision beyond 2^53", () => {
    const big = 10n ** 30n;
    const p = only([t("1", 1, "X", "buy", big, big * 2n), t("2", 2, "X", "sell", big, big * 3n)]);
    expect(p.realised).toBe(big);
  });
});

describe("computePnl - sells without a known buy", () => {
  it("reports the uncovered part as unmatched and keeps it out of realised", () => {
    // buy 100 for 1000, sell 150 for 3000: 100 units matched (proceeds 2000), 50 unmatched (proceeds 1000).
    const r = computePnl([t("1", 1, "X", "buy", 100n, 1000n), t("2", 2, "X", "sell", 150n, 3000n)]);
    const p = r.tokens[0]!;
    expect(p.realisedProceeds).toBe(2000n);
    expect(p.realisedCost).toBe(1000n);
    expect(p.realised).toBe(1000n);
    expect(p.unmatchedSoldAmount).toBe(50n);
    expect(p.unmatchedProceeds).toBe(1000n);
    expect(p.openAmount).toBe(0n);
    expect(r.totals.unmatchedProceeds).toBe(1000n);
  });

  it("a sell with nothing held is entirely unmatched", () => {
    const p = only([t("1", 1, "X", "sell", 10n, 500n)]);
    expect(p.realised).toBe(0n);
    expect(p.unmatchedSoldAmount).toBe(10n);
    expect(p.unmatchedProceeds).toBe(500n);
    expect(p.openAmount).toBe(0n);
  });
});

describe("computePnl - tokens and totals", () => {
  it("keeps tokens independent, sorts them by token, and sums totals", () => {
    const r = computePnl([
      t("1", 1, "Y", "buy", 10n, 100n),
      t("2", 2, "X", "buy", 10n, 100n),
      t("3", 3, "Y", "sell", 10n, 150n),
      t("4", 4, "X", "sell", 10n, 70n),
    ]);
    expect(r.tokens.map((p) => p.token)).toEqual(["X", "Y"]);
    expect(r.tokens[0]!.realised).toBe(-30n);
    expect(r.tokens[1]!.realised).toBe(50n);
    expect(r.totals.realised).toBe(20n);
  });
});

describe("computePnl - ordering and time", () => {
  it("sorts by time regardless of input order", () => {
    const sorted = [t("1", 1, "X", "buy", 10n, 100n), t("2", 2, "X", "sell", 10n, 150n)];
    expect(computePnl([sorted[1]!, sorted[0]!])).toEqual(computePnl(sorted));
  });

  it("breaks same-time ties by id, ascending", () => {
    const buyFirst = only([t("a", 5, "X", "buy", 10n, 100n), t("b", 5, "X", "sell", 10n, 150n)]);
    expect(buyFirst.realised).toBe(50n);
    const sellFirst = only([t("b", 5, "X", "buy", 10n, 100n), t("a", 5, "X", "sell", 10n, 150n)]);
    expect(sellFirst.realised).toBe(0n);
    expect(sellFirst.unmatchedSoldAmount).toBe(10n);
  });

  it("asOf ignores later trades (inclusive of asOf itself)", () => {
    const all = [
      t("1", 1, "X", "buy", 10n, 100n),
      t("2", 2, "X", "sell", 10n, 150n),
      t("3", 3, "X", "buy", 10n, 900n),
    ];
    expect(computePnl(all, { asOf: 2 })).toEqual(computePnl(all.slice(0, 2)));
    expect(computePnl(all, { asOf: 0 }).tokens).toEqual([]);
  });

  it("does not mutate its input", () => {
    const trades = Object.freeze([
      Object.freeze(t("2", 2, "X", "sell", 10n, 150n)),
      Object.freeze(t("1", 1, "X", "buy", 10n, 100n)),
    ]);
    expect(() => computePnl(trades)).not.toThrow();
    expect(trades.map((x) => x.id)).toEqual(["2", "1"]);
  });
});

describe("computePnl - unrealised", () => {
  const buy = t("1", 1, "X", "buy", 100n, 1000n);

  it("values open tokens at the mark", () => {
    const marks = new Map<string, Mark>([["X", { amount: 100n, quote: 1500n }]]);
    const r = computePnl([buy], { marks });
    expect(r.tokens[0]!.unrealised).toBe(500n);
    expect(r.totals.unrealised).toBe(500n);
    expect(r.totals.unmarkedTokens).toEqual([]);
  });

  it("rounds the mark value down", () => {
    // 50 open of 100 bought for 1000 -> cost 500. Mark: 3 units = 10 quote -> 50*10/3 = 166.
    const marks = new Map<string, Mark>([["X", { amount: 3n, quote: 10n }]]);
    const r = computePnl([buy, t("2", 2, "X", "sell", 50n, 0n)], { marks });
    expect(r.tokens[0]!.openCost).toBe(500n);
    expect(r.tokens[0]!.unrealised).toBe(166n - 500n);
  });

  it("is null, and listed as unmarked, when something is open without a mark", () => {
    const r = computePnl([buy]);
    expect(r.tokens[0]!.unrealised).toBeNull();
    expect(r.totals.unrealised).toBe(0n);
    expect(r.totals.unmarkedTokens).toEqual(["X"]);
  });

  it("is 0n and not unmarked when nothing is open", () => {
    const r = computePnl([buy, t("2", 2, "X", "sell", 100n, 1200n)]);
    expect(r.tokens[0]!.unrealised).toBe(0n);
    expect(r.totals.unmarkedTokens).toEqual([]);
  });

  it("ignores marks for tokens that were never traded", () => {
    const marks = new Map<string, Mark>([["Z", { amount: 1n, quote: 1n }]]);
    expect(computePnl([], { marks }).tokens).toEqual([]);
  });
});

describe("computePnl - validation", () => {
  const ok = t("1", 1, "X", "buy", 1n, 1n);
  it.each([
    ["zero amount", { ...ok, amount: 0n }],
    ["negative amount", { ...ok, amount: -1n }],
    ["negative quote", { ...ok, quote: -1n }],
    ["negative fee", { ...ok, fee: -1n }],
    ["bad side", { ...ok, side: "hold" as Side }],
    ["empty token", { ...ok, token: "" }],
    ["NaN time", { ...ok, time: Number.NaN }],
    ["fractional time", { ...ok, time: 1.5 }],
  ])("rejects %s", (_name, bad) => {
    expect(() => computePnl([bad])).toThrow(RangeError);
  });

  it("rejects numbers where bigints are required (JSON callers)", () => {
    expect(() => computePnl([{ ...ok, amount: 5 as unknown as bigint }])).toThrow(TypeError);
    expect(() => computePnl([{ ...ok, quote: "5" as unknown as bigint }])).toThrow(TypeError);
    expect(() => computePnl([{ ...ok, fee: 1 as unknown as bigint }])).toThrow(TypeError);
  });

  it("rejects duplicate ids", () => {
    expect(() => computePnl([ok, { ...ok, time: 2 }])).toThrow(RangeError);
  });

  it("validates trades even after asOf", () => {
    expect(() => computePnl([ok, { ...ok, id: "2", time: 9, amount: 0n }], { asOf: 1 })).toThrow(RangeError);
  });

  it("rejects a non-finite asOf and invalid marks", () => {
    expect(() => computePnl([ok], { asOf: Number.NaN })).toThrow(RangeError);
    const badAmount = new Map<string, Mark>([["X", { amount: 0n, quote: 1n }]]);
    expect(() => computePnl([ok], { marks: badAmount })).toThrow(RangeError);
    const badQuote = new Map<string, Mark>([["X", { amount: 1n, quote: -1n }]]);
    expect(() => computePnl([ok], { marks: badQuote })).toThrow(RangeError);
  });
});

// --- property tests: seeded, so a failure is reproducible -------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTrades(rand: () => number): Trade[] {
  const n = 1 + Math.floor(rand() * 30);
  const tokens = ["A", "B", "C"].slice(0, 1 + Math.floor(rand() * 3));
  const out: Trade[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `t${i}`,
      time: Math.floor(rand() * 12), // few distinct times -> many ties
      token: tokens[Math.floor(rand() * tokens.length)]!,
      side: rand() < 0.5 ? "buy" : "sell",
      amount: BigInt(1 + Math.floor(rand() * 1000)),
      quote: BigInt(Math.floor(rand() * 100000)),
      fee: BigInt(Math.floor(rand() * 50)),
    });
  }
  return out;
}

function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe("computePnl - properties (300 seeded random histories)", () => {
  const runs = Array.from({ length: 300 }, (_, i) => i + 1);

  it("conserves cost, proceeds and token amounts exactly", () => {
    for (const seed of runs) {
      const trades = randomTrades(mulberry32(seed));
      for (const p of computePnl(trades).tokens) {
        const ctx = `seed ${seed} token ${p.token}`;
        expect(p.buyCost, ctx).toBe(p.realisedCost + p.openCost);
        expect(p.sellProceeds, ctx).toBe(p.realisedProceeds + p.unmatchedProceeds);
        expect(p.realised, ctx).toBe(p.realisedProceeds - p.realisedCost);
        expect(p.boughtAmount - p.soldAmount + p.unmatchedSoldAmount, ctx).toBe(p.openAmount);
        expect(p.openAmount >= 0n && p.openCost >= 0n && p.unmatchedSoldAmount >= 0n, ctx).toBe(true);
        expect(p.openAmount === 0n ? p.openCost === 0n : true, ctx).toBe(true);
      }
    }
  });

  it("does not depend on input order", () => {
    for (const seed of runs) {
      const rand = mulberry32(seed);
      const trades = randomTrades(rand);
      expect(computePnl(shuffle(trades, rand)), `seed ${seed}`).toEqual(computePnl(trades));
    }
  });

  it("asOf equals computing on the truncated history", () => {
    for (const seed of runs) {
      const rand = mulberry32(seed);
      const trades = randomTrades(rand);
      const asOf = Math.floor(rand() * 12);
      const truncated = trades.filter((x) => x.time <= asOf);
      expect(computePnl(trades, { asOf }), `seed ${seed}`).toEqual(computePnl(truncated));
    }
  });

  it("one token's PnL does not depend on other tokens' trades", () => {
    for (const seed of runs) {
      const trades = randomTrades(mulberry32(seed));
      const full = computePnl(trades);
      for (const p of full.tokens) {
        const alone = computePnl(trades.filter((x) => x.token === p.token));
        expect(alone.tokens, `seed ${seed} token ${p.token}`).toEqual([p]);
      }
    }
  });
});
