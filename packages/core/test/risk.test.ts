import { describe, expect, it } from "vitest";
import { scoreRisk, type RiskInput, type SignalId } from "../src/risk";

const ALL_IDS: SignalId[] = [
  "top10Share",
  "hhi",
  "creatorShare",
  "creatorDumps",
  "liquidity",
  "mintAuthority",
  "freezeAuthority",
  "clustering",
  "washTrading",
  "age",
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const conc = (top10: number, hhi: number) => ({ hhi, topShare: { 1: top10 / 2, 5: top10 * 0.8, 10: top10, 20: Math.min(1, top10 * 1.2) } });

const WORST: RiskInput = {
  concentration: conc(0.9, 0.3),
  creatorShare: 0.5,
  creatorDumpCount: 5,
  liquidityQuote: 10n,
  marketCapQuote: 10_000n,
  mintAuthorityActive: true,
  freezeAuthorityActive: true,
  clusteredShare: 0.6,
  washTradeRatio: 0.8,
  ageMs: 0,
};

const BEST: RiskInput = {
  concentration: conc(0.1, 0.01),
  creatorShare: 0,
  creatorDumpCount: 0,
  liquidityQuote: 5_000n,
  marketCapQuote: 10_000n,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  clusteredShare: 0,
  washTradeRatio: 0,
  ageMs: 30 * DAY,
};

/** Weights that zero every signal except `id`, so a test can look at one signal alone. */
function only(id: SignalId, weight = 1): Partial<Record<SignalId, number>> {
  return Object.fromEntries(ALL_IDS.map((x) => [x, x === id ? weight : 0]));
}

function sig(report: ReturnType<typeof scoreRisk>, id: SignalId) {
  const s = report.signals.find((x) => x.id === id);
  expect(s, `signal ${id}`).toBeDefined();
  return s!;
}

describe("scoreRisk - extremes and structure", () => {
  it("worst case: score 100, critical, full coverage, both hard flags", () => {
    const r = scoreRisk(WORST);
    expect(r.score).toBeCloseTo(100, 9);
    expect(r.level).toBe("critical");
    expect(r.coverage).toBeCloseTo(1, 9);
    expect(r.hardFlags).toEqual(["mintAuthority", "freezeAuthority"]);
  });

  it("best case: score 0, low, no flags", () => {
    const r = scoreRisk(BEST);
    expect(r.score).toBeCloseTo(0, 9);
    expect(r.level).toBe("low");
    expect(r.hardFlags).toEqual([]);
  });

  it("default weights sum to 100 and signals come in a fixed order", () => {
    const r = scoreRisk(BEST);
    expect(r.signals.map((s) => s.id)).toEqual(ALL_IDS);
    expect(r.signals.reduce((a, s) => a + s.weight, 0)).toBe(100);
    expect(scoreRisk({}).signals.map((s) => s.id)).toEqual(ALL_IDS);
  });

  it("with no input at all: unknown, score 0, coverage 0, every signal unknown", () => {
    const r = scoreRisk({});
    expect(r.score).toBe(0);
    expect(r.level).toBe("unknown");
    expect(r.coverage).toBe(0);
    expect(r.hardFlags).toEqual([]);
    for (const s of r.signals) {
      expect(s.known).toBe(false);
      expect(s.value).toBeNull();
      expect(s.risk).toBe(0);
      expect(s.contribution).toBe(0);
    }
  });

  it("contributions add up to the score", () => {
    for (const input of [WORST, BEST, { ...BEST, creatorShare: 0.1, ageMs: 2 * DAY }, { creatorShare: 0.1 }]) {
      const r = scoreRisk(input);
      expect(r.signals.reduce((a, s) => a + s.contribution, 0)).toBeCloseTo(r.score, 9);
    }
  });
});

describe("scoreRisk - each signal's scale", () => {
  const alone = (id: SignalId, input: RiskInput) => scoreRisk(input, { weights: only(id) });

  it("top10Share ramps from 0.2 (no concern) to 0.8 (maximum)", () => {
    expect(alone("top10Share", { concentration: conc(0.2, 0) }).score).toBeCloseTo(0, 9);
    expect(alone("top10Share", { concentration: conc(0.5, 0) }).score).toBeCloseTo(50, 9);
    expect(alone("top10Share", { concentration: conc(0.8, 0) }).score).toBeCloseTo(100, 9);
    expect(alone("top10Share", { concentration: conc(1, 0) }).score).toBeCloseTo(100, 9);
  });

  it("hhi ramps from 0.02 to 0.25", () => {
    expect(alone("hhi", { concentration: conc(0.5, 0.02) }).score).toBeCloseTo(0, 9);
    expect(alone("hhi", { concentration: conc(0.5, 0.135) }).score).toBeCloseTo(50, 9);
    expect(alone("hhi", { concentration: conc(0.5, 0.25) }).score).toBeCloseTo(100, 9);
  });

  it("creatorShare ramps from 0.02 to 0.20", () => {
    expect(alone("creatorShare", { creatorShare: 0.02 }).score).toBeCloseTo(0, 9);
    expect(alone("creatorShare", { creatorShare: 0.11 }).score).toBeCloseTo(50, 9);
    expect(alone("creatorShare", { creatorShare: 0.2 }).score).toBeCloseTo(100, 9);
  });

  it("creatorDumps ramps from 0 to 3 earlier dumps", () => {
    expect(alone("creatorDumps", { creatorDumpCount: 0 }).score).toBe(0);
    expect(alone("creatorDumps", { creatorDumpCount: 1 }).score).toBeCloseTo(100 / 3, 9);
    expect(alone("creatorDumps", { creatorDumpCount: 3 }).score).toBeCloseTo(100, 9);
    expect(alone("creatorDumps", { creatorDumpCount: 40 }).score).toBeCloseTo(100, 9);
  });

  it("liquidity: a small pool against the market cap is the risk", () => {
    const at = (lp: bigint) => alone("liquidity", { liquidityQuote: lp, marketCapQuote: 1000n }).score;
    expect(at(20n)).toBeCloseTo(100, 9); // 2% of mcap
    expect(at(110n)).toBeCloseTo(50, 9); // 11%
    expect(at(200n)).toBeCloseTo(0, 9); // 20%
    expect(at(5000n)).toBe(0); // pool bigger than mcap
  });

  it("liquidity is unknown when only one side is given or the market cap is 0", () => {
    expect(sig(scoreRisk({ liquidityQuote: 100n }), "liquidity").known).toBe(false);
    expect(sig(scoreRisk({ marketCapQuote: 100n }), "liquidity").known).toBe(false);
    expect(sig(scoreRisk({ liquidityQuote: 100n, marketCapQuote: 0n }), "liquidity").known).toBe(false);
  });

  it("clustering ramps 0.05 to 0.40 and wash trading 0.10 to 0.50", () => {
    expect(alone("clustering", { clusteredShare: 0.05 }).score).toBeCloseTo(0, 9);
    expect(alone("clustering", { clusteredShare: 0.225 }).score).toBeCloseTo(50, 9);
    expect(alone("washTrading", { washTradeRatio: 0.1 }).score).toBeCloseTo(0, 9);
    expect(alone("washTrading", { washTradeRatio: 0.3 }).score).toBeCloseTo(50, 9);
    expect(alone("washTrading", { washTradeRatio: 0.5 }).score).toBeCloseTo(100, 9);
  });

  it("age: under an hour is maximum concern, a week or more is none", () => {
    expect(alone("age", { ageMs: 0 }).score).toBeCloseTo(100, 9);
    expect(alone("age", { ageMs: HOUR }).score).toBeCloseTo(100, 9);
    expect(alone("age", { ageMs: (HOUR + 7 * DAY) / 2 }).score).toBeCloseTo(50, 6);
    expect(alone("age", { ageMs: 7 * DAY }).score).toBeCloseTo(0, 9);
    expect(alone("age", { ageMs: 90 * DAY }).score).toBeCloseTo(0, 9);
  });

  it("authorities are binary: active = maximum concern", () => {
    expect(alone("mintAuthority", { mintAuthorityActive: true }).score).toBe(100);
    expect(alone("mintAuthority", { mintAuthorityActive: false }).score).toBe(0);
    expect(alone("freezeAuthority", { freezeAuthorityActive: true }).score).toBe(100);
    expect(sig(alone("mintAuthority", { mintAuthorityActive: true }), "mintAuthority").value).toBe(true);
  });
});

describe("scoreRisk - unknown is not safe", () => {
  it("normalises over the known signals and reports the coverage", () => {
    const r = scoreRisk({ concentration: conc(0.9, 0.3) }); // top10 (15) + hhi (10) known, both maximum
    expect(r.score).toBeCloseTo(100, 9);
    expect(r.coverage).toBeCloseTo(0.25, 9);
    expect(r.level).toBe("unknown"); // 25% < the 50% minimum
  });

  it("gives a level once enough of the weight is known", () => {
    const r = scoreRisk({
      concentration: conc(0.9, 0.3), // 25
      creatorShare: 0.5, // 15
      creatorDumpCount: 5, // 15
    }); // 55% known
    expect(r.coverage).toBeCloseTo(0.55, 9);
    expect(r.level).toBe("critical");
  });

  it("minCoverage is configurable", () => {
    const r = scoreRisk({ concentration: conc(0.9, 0.3) }, { minCoverage: 0.2 });
    expect(r.level).toBe("critical");
  });
});

describe("scoreRisk - levels", () => {
  // Only top10Share counts, so score = 100 * risk and coverage is 1.
  const level = (top10: number) => scoreRisk({ concentration: conc(top10, 0) }, { weights: only("top10Share") }).level;
  it("maps score to low < 25 <= medium < 50 <= high < 75 <= critical", () => {
    expect(level(0.32)).toBe("low"); // 20
    expect(level(0.38)).toBe("medium"); // 30
    expect(level(0.56)).toBe("high"); // 60
    expect(level(0.74)).toBe("critical"); // 90
  });
});

describe("scoreRisk - hard flags", () => {
  it("an active mint authority forces at least 'high' even when everything else is good", () => {
    const r = scoreRisk({ ...BEST, mintAuthorityActive: true });
    expect(r.score).toBeCloseTo(8, 9); // the weighted score alone says "low"
    expect(r.level).toBe("high");
    expect(r.hardFlags).toEqual(["mintAuthority"]);
  });

  it("a freeze authority does the same", () => {
    const r = scoreRisk({ ...BEST, freezeAuthorityActive: true });
    expect(r.level).toBe("high");
    expect(r.hardFlags).toEqual(["freezeAuthority"]);
  });

  it("a hard flag beats low coverage", () => {
    const r = scoreRisk({ mintAuthorityActive: true });
    expect(r.level).toBe("high"); // it would be "unknown" without the flag
  });

  it("does not downgrade a score that is already critical", () => {
    expect(scoreRisk(WORST).level).toBe("critical");
  });

  it("flags do not depend on weights", () => {
    const r = scoreRisk({ ...BEST, mintAuthorityActive: true }, { weights: { mintAuthority: 0 } });
    expect(r.hardFlags).toEqual(["mintAuthority"]);
    expect(r.level).toBe("high");
  });
});

describe("scoreRisk - weights", () => {
  it("a weight override changes the score; weight 0 removes the signal", () => {
    const input: RiskInput = { creatorShare: 0.2, creatorDumpCount: 0 }; // risks 1 and 0
    const base = scoreRisk(input, { weights: { ...only("creatorShare", 15), creatorDumps: 15 } });
    expect(base.score).toBeCloseTo(50, 9);
    const heavy = scoreRisk(input, { weights: { ...only("creatorShare", 45), creatorDumps: 15 } });
    expect(heavy.score).toBeCloseTo(75, 9);
    expect(sig(scoreRisk(input, { weights: { creatorDumps: 0 } }), "creatorDumps").contribution).toBe(0);
  });

  it("all weights zero: unknown, score 0, coverage 0", () => {
    const zero = Object.fromEntries(ALL_IDS.map((x) => [x, 0]));
    const r = scoreRisk(WORST, { weights: zero });
    expect(r.score).toBe(0);
    expect(r.coverage).toBe(0);
    expect(r.level).toBe("high"); // hard flags still apply
    expect(scoreRisk(BEST, { weights: zero }).level).toBe("unknown");
  });
});

describe("scoreRisk - validation", () => {
  it.each([
    ["creatorShare above 1", { creatorShare: 1.5 }],
    ["negative creatorShare", { creatorShare: -0.1 }],
    ["NaN creatorShare", { creatorShare: Number.NaN }],
    ["clusteredShare above 1", { clusteredShare: 2 }],
    ["washTradeRatio below 0", { washTradeRatio: -1 }],
    ["fractional dump count", { creatorDumpCount: 1.5 }],
    ["negative dump count", { creatorDumpCount: -1 }],
    ["negative age", { ageMs: -1 }],
    ["infinite age", { ageMs: Number.POSITIVE_INFINITY }],
    ["negative liquidity", { liquidityQuote: -1n, marketCapQuote: 10n }],
    ["negative market cap", { liquidityQuote: 1n, marketCapQuote: -10n }],
    ["hhi above 1", { concentration: conc(0.5, 1.5) }],
    ["top10 above 1", { concentration: conc(1.5, 0.1) }],
  ] as [string, RiskInput][])("rejects %s", (_name, bad) => {
    expect(() => scoreRisk(bad)).toThrow(RangeError);
  });

  it("rejects bad options", () => {
    expect(() => scoreRisk({}, { weights: { hhi: -1 } })).toThrow(RangeError);
    expect(() => scoreRisk({}, { weights: { hhi: Number.NaN } })).toThrow(RangeError);
    expect(() => scoreRisk({}, { weights: { nope: 1 } as never })).toThrow(RangeError);
    expect(() => scoreRisk({}, { minCoverage: 1.5 })).toThrow(RangeError);
    expect(() => scoreRisk({}, { minCoverage: -0.1 })).toThrow(RangeError);
  });

  it("rejects non-bigint liquidity values (JSON callers)", () => {
    expect(() => scoreRisk({ liquidityQuote: 5 as unknown as bigint, marketCapQuote: 10n })).toThrow(TypeError);
  });

  it("treats a concentration without a top-10 share as unknown, not as zero", () => {
    const r = scoreRisk({ concentration: { hhi: 0.1, topShare: { 1: 0.1, 5: 0.3 } } });
    expect(sig(r, "top10Share").known).toBe(false);
    expect(sig(r, "hhi").known).toBe(true);
  });
});

// --- property: more concern in one input never lowers the score --------------

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

function randomFull(rand: () => number): RiskInput {
  return {
    concentration: conc(rand(), rand() * 0.5),
    creatorShare: rand() * 0.6,
    creatorDumpCount: Math.floor(rand() * 6),
    liquidityQuote: BigInt(Math.floor(rand() * 5000)),
    marketCapQuote: BigInt(1 + Math.floor(rand() * 10000)),
    mintAuthorityActive: rand() < 0.5,
    freezeAuthorityActive: rand() < 0.5,
    clusteredShare: rand() * 0.7,
    washTradeRatio: rand(),
    ageMs: Math.floor(rand() * 20 * DAY),
  };
}

describe("scoreRisk - monotonicity (300 seeded random inputs, every signal known)", () => {
  const runs = Array.from({ length: 300 }, (_, i) => i + 1);
  const score = (i: RiskInput) => scoreRisk(i).score;

  it("score never decreases when a risk-increasing input increases", () => {
    for (const seed of runs) {
      const rand = mulberry32(seed);
      const base = randomFull(rand);
      const s0 = score(base);
      const c = base.concentration!;
      const more: [string, RiskInput][] = [
        ["top10Share", { ...base, concentration: { hhi: c.hhi, topShare: { ...c.topShare, 10: Math.min(1, c.topShare[10]! + 0.1) } } }],
        ["hhi", { ...base, concentration: { hhi: Math.min(1, c.hhi + 0.05), topShare: c.topShare } }],
        ["creatorShare", { ...base, creatorShare: Math.min(1, base.creatorShare! + 0.05) }],
        ["creatorDumps", { ...base, creatorDumpCount: base.creatorDumpCount! + 1 }],
        ["clustering", { ...base, clusteredShare: Math.min(1, base.clusteredShare! + 0.05) }],
        ["washTrading", { ...base, washTradeRatio: Math.min(1, base.washTradeRatio! + 0.05) }],
        ["smaller pool", { ...base, liquidityQuote: base.liquidityQuote! / 2n }],
        ["younger", { ...base, ageMs: Math.floor(base.ageMs! / 2) }],
        ["mint on", { ...base, mintAuthorityActive: true }],
        ["freeze on", { ...base, freezeAuthorityActive: true }],
      ];
      for (const [name, worse] of more) {
        expect(score(worse), `seed ${seed}: ${name}`).toBeGreaterThanOrEqual(s0 - 1e-9);
      }
    }
  });

  it("score stays within 0..100 and contributions sum to it", () => {
    for (const seed of runs) {
      const r = scoreRisk(randomFull(mulberry32(seed)));
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100 + 1e-9);
      expect(r.signals.reduce((a, s) => a + s.contribution, 0), `seed ${seed}`).toBeCloseTo(r.score, 9);
    }
  });
});
