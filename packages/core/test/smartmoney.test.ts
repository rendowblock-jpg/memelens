import { describe, expect, it } from "vitest";
import { computePnl, type Side, type Trade } from "../src/pnl";
import { rankSmartMoney, scoreWallet, wilsonLowerBound, type WalletTrades } from "../src/smartmoney";

function t(id: string, time: number, token: string, side: Side, amount: bigint, quote: bigint): Trade {
  return { id, time, token, side, amount, quote };
}

const WIDE = { from: 0, to: 1000 };

/** One buy and one sell per token. Token i makes exactly pnls[i] (quote units). */
function roundTrips(address: string, pnls: bigint[]): WalletTrades {
  const trades: Trade[] = [];
  pnls.forEach((pnl, i) => {
    trades.push(t(`${address}-b${i}`, 10 * i + 1, `T${i}`, "buy", 10n, 1000n));
    trades.push(t(`${address}-s${i}`, 10 * i + 2, `T${i}`, "sell", 10n, 1000n + pnl));
  });
  return { address, trades };
}

describe("wilsonLowerBound", () => {
  // Reference values computed independently (python, z = 1.96).
  it.each([
    [7, 10, 0.396778],
    [70, 100, 0.604151],
    [3, 3, 0.438503],
    [5, 5, 0.565518],
    [1, 2, 0.094531],
    [2, 3, 0.20766],
  ])("%i wins of %i -> %f", (wins, n, expected) => {
    expect(wilsonLowerBound(wins, n)).toBeCloseTo(expected, 3);
  });

  it("0 wins gives 0, and no sample gives null", () => {
    expect(wilsonLowerBound(0, 5)).toBeCloseTo(0, 9);
    expect(wilsonLowerBound(0, 0)).toBeNull();
  });

  it("a perfect record is worth more with a bigger sample", () => {
    expect(wilsonLowerBound(30, 30)!).toBeGreaterThan(wilsonLowerBound(3, 3)!);
    expect(wilsonLowerBound(3, 3)!).toBeLessThan(0.5);
  });

  it("rejects impossible counts", () => {
    expect(() => wilsonLowerBound(4, 3)).toThrow(RangeError);
    expect(() => wilsonLowerBound(-1, 3)).toThrow(RangeError);
    expect(() => wilsonLowerBound(1.5, 3)).toThrow(RangeError);
    expect(() => wilsonLowerBound(1, -3)).toThrow(RangeError);
  });
});

describe("scoreWallet", () => {
  it("scores a whole history: realised, cost, hit rate, roi, trade count", () => {
    const w: WalletTrades = {
      address: "w",
      trades: [
        t("1", 1, "A", "buy", 10n, 1000n),
        t("2", 2, "A", "sell", 10n, 1500n), // +500
        t("3", 3, "B", "buy", 10n, 1000n),
        t("4", 4, "B", "sell", 10n, 400n), // -600
        t("5", 5, "C", "buy", 10n, 100n), // still open
      ],
    };
    const s = scoreWallet(w, WIDE);
    expect(s.address).toBe("w");
    expect(s.realised).toBe(-100n);
    expect(s.realisedCost).toBe(2000n);
    expect(s.closedTokens).toBe(2); // C is open, not closed
    expect(s.wins).toBe(1);
    expect(s.hitRate).toBe(0.5);
    expect(s.hitRateLow).toBeCloseTo(0.094531, 3);
    expect(s.roi).toBeCloseTo(-0.05, 9);
    expect(s.unmatchedProceeds).toBe(0n);
    expect(s.trades).toBe(5);
  });

  const x = [
    t("1", 1, "X", "buy", 10n, 100n),
    t("2", 2, "X", "sell", 5n, 60n), // before the window below
    t("3", 6, "X", "sell", 5n, 80n), // inside it
  ];

  it("counts only PnL realised inside the window, but uses buys from before it", () => {
    const s = scoreWallet({ address: "w", trades: x }, { from: 5, to: 10 });
    expect(s.realised).toBe(30n); // 80 - half of the 100 cost basis
    expect(s.realisedCost).toBe(50n);
    expect(s.closedTokens).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.trades).toBe(1);
  });

  it("an earlier sell still uses up the oldest lot, even though it is outside the window", () => {
    const early = scoreWallet({ address: "w", trades: x }, { from: 0, to: 3 });
    expect(early.realised).toBe(10n); // 60 - 50
    expect(early.trades).toBe(2);
  });

  it("window edges are inclusive", () => {
    const s = scoreWallet({ address: "w", trades: x }, { from: 6, to: 6 });
    expect(s.trades).toBe(1);
    expect(s.realised).toBe(30n);
  });

  it("never looks past the end of the window", () => {
    const withFuture = [...x, t("4", 50, "X", "buy", 1000n, 1n), t("5", 51, "X", "sell", 1000n, 10n ** 9n)];
    expect(scoreWallet({ address: "w", trades: withFuture }, { from: 5, to: 10 })).toEqual(
      scoreWallet({ address: "w", trades: x }, { from: 5, to: 10 }),
    );
  });

  it("a sell with no known buy is reported as unmatched and is not a closed token", () => {
    const s = scoreWallet({ address: "w", trades: [t("1", 6, "X", "sell", 10n, 500n)] }, { from: 5, to: 10 });
    expect(s.realised).toBe(0n);
    expect(s.closedTokens).toBe(0);
    expect(s.hitRate).toBeNull();
    expect(s.hitRateLow).toBeNull();
    expect(s.roi).toBeNull();
    expect(s.unmatchedProceeds).toBe(500n);
    expect(s.trades).toBe(1);
  });

  it("break-even is not a win", () => {
    const s = scoreWallet(roundTrips("w", [0n]), WIDE);
    expect(s.closedTokens).toBe(1);
    expect(s.wins).toBe(0);
    expect(s.hitRate).toBe(0);
  });

  it("roi is null when the cost basis is zero", () => {
    const s = scoreWallet(
      { address: "w", trades: [t("1", 1, "X", "buy", 10n, 0n), t("2", 2, "X", "sell", 10n, 100n)] },
      WIDE,
    );
    expect(s.realised).toBe(100n);
    expect(s.realisedCost).toBe(0n);
    expect(s.roi).toBeNull();
    expect(s.wins).toBe(1);
  });

  it("a wallet with no trades scores zero", () => {
    const s = scoreWallet({ address: "w", trades: [] }, WIDE);
    expect(s).toEqual({
      address: "w",
      realised: 0n,
      realisedCost: 0n,
      closedTokens: 0,
      wins: 0,
      hitRate: null,
      hitRateLow: null,
      roi: null,
      unmatchedProceeds: 0n,
      trades: 0,
    });
  });

  it("rejects a bad window and bad trades", () => {
    const w = roundTrips("w", [1n]);
    expect(() => scoreWallet(w, { from: 5, to: 4 })).toThrow(RangeError);
    expect(() => scoreWallet(w, { from: 0.5, to: 4 })).toThrow(RangeError);
    expect(() => scoreWallet(w, { from: 0, to: Number.NaN })).toThrow(RangeError);
    expect(() => scoreWallet({ address: "w", trades: [t("1", 1, "X", "buy", 0n, 1n)] }, WIDE)).toThrow(RangeError);
    expect(() => scoreWallet({ address: "", trades: [] }, WIDE)).toThrow(RangeError);
  });
});

describe("rankSmartMoney", () => {
  const wallets = [
    roundTrips("W1", [200n, 200n, 200n, 200n, 200n]), // +1000, 5 closed
    roundTrips("W2", [500n, 500n, 500n, 500n, 500n, 500n]), // +3000, 6 closed
    roundTrips("W3", [5000n, 4999n]), // +9999 but only 2 closed
    roundTrips("W4", [-100n, -100n, -100n, -100n, -100n]), // -500
    roundTrips("W5", [100n, -100n, 0n, 50n, -50n]), // exactly 0
  ];

  it("ranks qualified, profitable wallets by realised PnL and explains everyone else", () => {
    const r = rankSmartMoney(wallets, WIDE);
    expect(r.ranked.map((w) => [w.rank, w.address, w.realised])).toEqual([
      [1, "W2", 3000n],
      [2, "W1", 1000n],
    ]);
    expect(r.unranked.map((w) => [w.address, w.reason])).toEqual([
      ["W3", "too-few-closed-tokens"],
      ["W4", "not-profitable"],
      ["W5", "not-profitable"],
    ]);
  });

  it("minClosedTokens is configurable", () => {
    const r = rankSmartMoney(wallets, { ...WIDE, minClosedTokens: 2 });
    expect(r.ranked.map((w) => w.address)).toEqual(["W3", "W2", "W1"]);
  });

  it("breaks equal PnL by hit rate, then by address", () => {
    const steady = roundTrips("zz", [100n, 100n, 100n, 100n, 200n]); // +600, 5 of 5 wins
    const lucky = roundTrips("aa", [400n, 400n, 400n, -300n, -300n]); // +600, 3 of 5 wins
    const twinB = roundTrips("b", [100n, 100n, 100n, 100n, 200n]);
    const twinA = roundTrips("a", [100n, 100n, 100n, 100n, 200n]);
    const r = rankSmartMoney([lucky, steady, twinB, twinA], WIDE);
    expect(r.ranked.map((w) => w.address)).toEqual(["a", "b", "zz", "aa"]);
    expect(r.ranked.map((w) => w.rank)).toEqual([1, 2, 3, 4]);
  });

  it("does not depend on the order of the wallets", () => {
    expect(rankSmartMoney([...wallets].reverse(), WIDE)).toEqual(rankSmartMoney(wallets, WIDE));
  });

  it("handles no wallets, and a wallet with no trades", () => {
    expect(rankSmartMoney([], WIDE)).toEqual({ ranked: [], unranked: [] });
    const r = rankSmartMoney([{ address: "empty", trades: [] }], WIDE);
    expect(r.unranked.map((w) => [w.address, w.reason])).toEqual([["empty", "too-few-closed-tokens"]]);
  });

  it("only sees the window", () => {
    // W2's six wins happen at times 2..52. A window that ends at 22 sees three of them.
    const r = rankSmartMoney([wallets[1]!], { from: 0, to: 22, minClosedTokens: 1 });
    expect(r.ranked[0]!.closedTokens).toBe(3);
    expect(r.ranked[0]!.realised).toBe(1500n);
  });

  it("rejects duplicate addresses and bad options", () => {
    expect(() => rankSmartMoney([wallets[0]!, wallets[0]!], WIDE)).toThrow(RangeError);
    expect(() => rankSmartMoney(wallets, { ...WIDE, minClosedTokens: 0 })).toThrow(RangeError);
    expect(() => rankSmartMoney(wallets, { ...WIDE, minClosedTokens: 1.5 })).toThrow(RangeError);
    expect(() => rankSmartMoney(wallets, { from: 9, to: 1 })).toThrow(RangeError);
  });
});

// --- properties --------------------------------------------------------------

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

function randomWallet(rand: () => number): WalletTrades {
  const n = 1 + Math.floor(rand() * 30);
  const tokens = ["A", "B", "C", "D"].slice(0, 1 + Math.floor(rand() * 4));
  const trades: Trade[] = [];
  for (let i = 0; i < n; i++) {
    trades.push({
      id: `t${i}`,
      time: Math.floor(rand() * 12),
      token: tokens[Math.floor(rand() * tokens.length)]!,
      side: rand() < 0.5 ? "buy" : "sell",
      amount: BigInt(1 + Math.floor(rand() * 1000)),
      quote: BigInt(Math.floor(rand() * 100000)),
    });
  }
  return { address: "w", trades };
}

describe("scoreWallet - properties (300 seeded random wallets)", () => {
  const runs = Array.from({ length: 300 }, (_, i) => i + 1);

  it("adjacent windows add up to the combined window", () => {
    for (const seed of runs) {
      const rand = mulberry32(seed);
      const w = randomWallet(rand);
      const a = Math.floor(rand() * 4);
      const b = a + Math.floor(rand() * 4);
      const c = b + 1 + Math.floor(rand() * 5); // c >= b + 1, so [b+1, c] is a valid window
      const first = scoreWallet(w, { from: a, to: b });
      const second = scoreWallet(w, { from: b + 1, to: c });
      const whole = scoreWallet(w, { from: a, to: c });
      expect(first.realised + second.realised, `seed ${seed}`).toBe(whole.realised);
      expect(first.realisedCost + second.realisedCost, `seed ${seed}`).toBe(whole.realisedCost);
      expect(first.unmatchedProceeds + second.unmatchedProceeds, `seed ${seed}`).toBe(whole.unmatchedProceeds);
      expect(first.trades + second.trades, `seed ${seed}`).toBe(whole.trades);
    }
  });

  it("a window over all of history matches computePnl", () => {
    for (const seed of runs) {
      const w = randomWallet(mulberry32(seed));
      const s = scoreWallet(w, { from: 0, to: 11 });
      const p = computePnl(w.trades);
      expect(s.realised, `seed ${seed}`).toBe(p.totals.realised);
      expect(s.unmatchedProceeds, `seed ${seed}`).toBe(p.totals.unmatchedProceeds);
      expect(s.trades).toBe(w.trades.length);
    }
  });

  it("wins never exceed closed tokens; hit rate is within 0..1 and its lower bound never exceeds it", () => {
    for (const seed of runs) {
      const s = scoreWallet(randomWallet(mulberry32(seed)), { from: 0, to: 11 });
      expect(s.wins).toBeLessThanOrEqual(s.closedTokens);
      if (s.hitRate === null) {
        expect(s.closedTokens).toBe(0);
        expect(s.hitRateLow).toBeNull();
      } else {
        expect(s.hitRate).toBeGreaterThanOrEqual(0);
        expect(s.hitRate).toBeLessThanOrEqual(1);
        expect(s.hitRateLow!).toBeLessThanOrEqual(s.hitRate + 1e-12);
      }
    }
  });
});
