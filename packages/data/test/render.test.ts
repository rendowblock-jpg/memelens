import { scoreRisk, type PnlReport, type SmartMoneyReport, type TokenPnl, type WalletScore } from "@memelens/core";
import { describe, expect, it } from "vitest";
import { fmtAge, fmtInt, fmtIso, fmtPct, renderConcentration, renderPnl, renderRisk, renderSmart, table } from "../src/render";

describe("fmtInt", () => {
  it("groups digits in threes and keeps the sign", () => {
    expect(fmtInt(0n)).toBe("0");
    expect(fmtInt(7n)).toBe("7");
    expect(fmtInt(999n)).toBe("999");
    expect(fmtInt(1000n)).toBe("1,000");
    expect(fmtInt(1234567n)).toBe("1,234,567");
    expect(fmtInt(100000n)).toBe("100,000");
    expect(fmtInt(-1n)).toBe("-1");
    expect(fmtInt(-1000n)).toBe("-1,000");
    expect(fmtInt(-123456n)).toBe("-123,456");
  });

  it("is exact far beyond 2^53", () => {
    expect(fmtInt(10n ** 30n)).toBe("1,000,000,000,000,000,000,000,000,000,000");
    expect(fmtInt(-(2n ** 70n))).toBe("-1,180,591,620,717,411,303,424");
  });
});

describe("fmtPct, fmtIso, fmtAge", () => {
  it("shows one decimal and a dash for null", () => {
    expect(fmtPct(0.5)).toBe("50.0%");
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(1)).toBe("100.0%");
    expect(fmtPct(0.56552)).toBe("56.6%");
    expect(fmtPct(null)).toBe("-");
  });

  it("formats a time as ISO-8601 UTC", () => {
    expect(fmtIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(fmtIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("formats a duration with its two largest units", () => {
    const cases: Array<[number, string]> = [
      [0, "0s"],
      [999, "0s"],
      [1000, "1s"],
      [59_000, "59s"],
      [60_000, "1m"],
      [90_000, "1m 30s"],
      [3_599_000, "59m 59s"],
      [3_600_000, "1h"],
      [3_660_000, "1h 1m"],
      [7_500_000, "2h 5m"],
      [86_399_000, "23h 59m"],
      [86_400_000, "1d"],
      [90_000_000, "1d 1h"],
      [3 * 86_400_000 + 4 * 3_600_000 + 59 * 60_000, "3d 4h"],
    ];
    for (const [ms, text] of cases) expect(fmtAge(ms), String(ms)).toBe(text);
  });
});

describe("table", () => {
  it("pads left columns on the right and right columns on the left, two spaces apart", () => {
    expect(table(["a", "bb"], [["x", "1"], ["yy", "22"]], ["l", "r"])).toBe("a   bb\nx    1\nyy  22");
  });

  it("does not leave trailing spaces", () => {
    expect(table(["a", "b"], [["x", "long"]], ["l", "l"])).toBe("a  b\nx  long");
  });

  it("sizes each column to its widest cell, header included", () => {
    expect(table(["wallet", "n"], [["a", "1"]], ["l", "r"])).toBe("wallet  n\na       1");
  });
});

function tokenPnl(over: Partial<TokenPnl>): TokenPnl {
  return {
    token: "T",
    boughtAmount: 0n,
    soldAmount: 0n,
    buyCost: 0n,
    sellProceeds: 0n,
    realisedCost: 0n,
    realisedProceeds: 0n,
    realised: 0n,
    openAmount: 0n,
    openCost: 0n,
    unmatchedSoldAmount: 0n,
    unmatchedProceeds: 0n,
    unrealised: 0n,
    ...over,
  };
}

describe("renderPnl", () => {
  const closed: PnlReport = {
    tokens: [tokenPnl({ token: "A", realised: 1500n })],
    totals: { realised: 1500n, unrealised: 0n, unmarkedTokens: [], unmatchedProceeds: 0n },
  };

  it("shows the header, one row per token and the totals", () => {
    const out = renderPnl("w1", "solana", 1_700_000_000_000, closed);
    expect(out).toContain("PnL of w1 on solana, as of 2023-11-14T22:13:20.000Z");
    expect(out).toContain("raw quote units");
    expect(out).toMatch(/^A\s+1,500\s+0\s+0\s+0$/m);
    expect(out).toContain("total realised 1,500, unrealised 0");
  });

  it("leaves out the optional lines when they do not apply", () => {
    const out = renderPnl("w1", "solana", 0, closed);
    expect(out).not.toContain("no known buy");
    expect(out).not.toContain("no mark price");
    expect(out).not.toContain("last trade");
  });

  it("says when a position has no mark, and when sells had no known buy", () => {
    const report: PnlReport = {
      tokens: [tokenPnl({ token: "A", openAmount: 3n, openCost: 30n, unrealised: null })],
      totals: { realised: 0n, unrealised: 0n, unmarkedTokens: ["A"], unmatchedProceeds: 7n },
    };
    const out = renderPnl("w1", "solana", 0, report);
    expect(out).toMatch(/^A\s+0\s+3\s+30\s+no mark$/m);
    expect(out).toContain("no mark price for: A");
    expect(out).toContain("sells with no known buy, left out of realised: 7");
    expect(out).toContain("last trade");
  });

  it("names the wallet and the time when there are no trades", () => {
    const out = renderPnl("w1", "solana", 1_700_000_000_000, { tokens: [], totals: closed.totals });
    expect(out).toContain("no trades for w1 at or before 2023-11-14T22:13:20.000Z");
    expect(out).not.toContain("total realised");
  });
});

describe("renderConcentration", () => {
  it("lists the top shares in numeric order and shows the snapshot's age", () => {
    const out = renderConcentration("TOK", "solana", 1_700_000_300_000, 1_700_000_000_000, 300_000, {
      holders: 4,
      total: 2000n,
      topShare: { 20: 1, 1: 0.5, 10: 1, 5: 0.9 },
      hhi: 0.345,
      gini: 0.25,
    });
    expect(out).toContain("Concentration of TOK on solana, as of 2023-11-14T22:18:20.000Z");
    expect(out).toContain("holder snapshot taken 2023-11-14T22:13:20.000Z (5m before the as-of time)");
    expect(out).toContain("holders counted 4, counted supply 2,000 raw units");
    expect(out).toContain("top 1: 50.0%   top 5: 90.0%   top 10: 100.0%   top 20: 100.0%");
    expect(out).toContain("HHI 0.345   Gini 0.250");
  });
});

describe("renderRisk", () => {
  it("with nothing known: level UNKNOWN, zero coverage, and every signal under 'not known' with its reason", () => {
    const report = scoreRisk({});
    const out = renderRisk("TOK", "solana", 0, null, report, { liquidity: "no liquidity data yet" });
    expect(out).toContain("level UNKNOWN");
    expect(out).toContain("coverage 0.0%");
    expect(out).toContain("no holder snapshot was available");
    expect(out).not.toContain("known signals");
    expect(out).not.toContain("hard flags");
    expect(out).toMatch(/^liquidity\s+no liquidity data yet$/m);
    expect(out).toMatch(/^hhi\s+not known$/m);
  });

  it("with an active mint authority: lists the hard flag and the signal as known", () => {
    const report = scoreRisk({ mintAuthorityActive: true, freezeAuthorityActive: false });
    const out = renderRisk("TOK", "solana", 1_700_000_000_000, 1_699_999_000_000, report, {});
    expect(out).toContain("hard flags (force the level to at least high): mintAuthority");
    expect(out).toContain("known signals");
    expect(out).toMatch(/^mintAuthority\s+true\b/m);
    expect(out).toMatch(/^freezeAuthority\s+false\b/m);
    expect(out).toContain("holder snapshot taken 2023-11-14T21:56:40.000Z");
    expect(out).toContain(`score ${report.score.toFixed(1)} of 100`);
  });
});

function score(address: string, over: Partial<WalletScore> = {}): WalletScore {
  return {
    address,
    realised: 0n,
    realisedCost: 0n,
    closedTokens: 0,
    wins: 0,
    hitRate: null,
    hitRateLow: null,
    roi: null,
    unmatchedProceeds: 0n,
    trades: 0,
    ...over,
  };
}

describe("renderSmart", () => {
  it("says nobody is ranked, and still lists the others with their reasons", () => {
    const report: SmartMoneyReport = {
      ranked: [],
      unranked: [{ ...score("w1", { realised: -5n, closedTokens: 2 }), reason: "not-profitable" }],
    };
    const out = renderSmart("solana", 0, 1_700_000_000_000, 5, report);
    expect(out).toContain("nobody is ranked");
    expect(out).toContain("window 1970-01-01T00:00:00.000Z to 2023-11-14T22:13:20.000Z");
    expect(out).toContain("at least 5 closed tokens");
    expect(out).toMatch(/^w1\s+not-profitable\s+-5\s+2$/m);
  });

  it("shows ranked wallets with percentages, and a dash for an unknown ratio", () => {
    const report: SmartMoneyReport = {
      ranked: [
        { ...score("alice", { realised: 5_000_000n, closedTokens: 5, wins: 5, hitRate: 1, hitRateLow: 0.56552, roi: 1 }), rank: 1 },
        { ...score("zed", { realised: 10n, closedTokens: 5, wins: 3, hitRate: 0.6, hitRateLow: 0.23, roi: null }), rank: 2 },
      ],
      unranked: [],
    };
    const out = renderSmart("solana", 0, 1, 5, report);
    expect(out).not.toContain("nobody is ranked");
    expect(out).not.toContain("not ranked");
    expect(out).toMatch(/^\s*1\s+alice\s+5,000,000\s+5\s+5\s+100\.0%\s+56\.6%\s+100\.0%$/m);
    expect(out).toMatch(/^\s*2\s+zed\s+10\s+5\s+3\s+60\.0%\s+23\.0%\s+-$/m);
  });
});
