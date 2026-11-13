import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPath, labelToken, parseCandles, type Candle, type LabelInput, type PoolCandles } from "../src/label";
import { ParseError } from "../src/parse";

const fixture = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

// A hand-made world. T0 is a whole number of hours, so hour k is [T0 + k*H, T0 + (k+1)*H). The pool was created at T0 and
// the first-hour reading was taken 61 minutes later (S). Hour 1 starts before S, so the first hour that counts after S is
// hour 2. Hour 71 is the last that ends by +72 h, hour 719 the last that ends by +30 d.
const M = 60_000;
const H = 3_600_000;
const T0 = 1_800_000_000_000;
const S = T0 + 61 * M;

const cd = (start: number, open: number, high: number, low: number, close: number, volume = 10): Candle => ({ start, open, high, low, close, volume });
/** The sixty minutes of the first hour, all at one price unless a minute is overridden. */
const minutes = (price = 1, over: Record<number, Partial<Candle>> = {}): Candle[] => Array.from({ length: 60 }, (_, m) => ({ ...cd(T0 + m * M, price, price, price, price), ...(over[m] ?? {}) }));
/** One hourly candle at one price (volume 100) unless overridden. */
const hr = (k: number, price: number, over: Partial<Candle> = {}): Candle => ({ ...cd(T0 + k * H, price, price, price, price, 100), ...over });
const hours = (k0: number, k1: number, price: number, over: (k: number) => Partial<Candle> = () => ({})): Candle[] => Array.from({ length: k1 - k0 + 1 }, (_, i) => hr(k0 + i, price, over(k0 + i)));
const pool = (name: string, candles: Candle[]): PoolCandles => ({ pool: name, candles });

/** A token that never moves: it is a survivor until a test changes something. */
const base = (over: Partial<LabelInput> = {}): LabelInput => ({
  createdAt: T0,
  scoredAt: S,
  minute: minutes(1),
  hourly72: [pool("A", hours(2, 71, 1))],
  hourly30d: [pool("A", hours(2, 719, 1))],
  creatorAtScoring: null,
  creatorAt72h: null,
  pools30d: [{ pool: "A", reserveUsd: 5000 }],
  ...over,
});
/** Flat at 1 until hour 5, a candle that falls to 0.05 in hour 6, then 0.02 for the rest of the 72 hours. */
const rugPath = (): Candle[] => [...hours(2, 5, 1), hr(6, 0.05, { high: 1, low: 0.05, close: 0.05 }), ...hours(7, 71, 0.02)];
const rugged = (over: Partial<LabelInput> = {}): LabelInput => base({ hourly72: [pool("A", rugPath())], hourly30d: [pool("A", [...rugPath(), ...hours(72, 719, 0.02)])], ...over });

describe("parseCandles on real GeckoTerminal replies", () => {
  it("reads the hourly reply: one candle, the start turned from seconds into milliseconds", () => {
    expect(parseCandles(fixture("gt-ohlcv-hour.json"))).toEqual([{ start: 1_794_560_400_000, open: 2.2399427485361727e-6, high: 3.0626588737812754e-6, low: 2.8361399791407405e-7, close: 2.8361399791407405e-7, volume: 133.3594645238807 }]);
  });

  it("reads the minute reply, which comes newest first, oldest first", () => {
    const c = parseCandles(fixture("gt-ohlcv-minute.json"));
    expect(c.map((x) => x.start)).toEqual([1_794_562_140_000, 1_794_562_200_000]);
    expect(c[1]!.volume).toBeCloseTo(0.9935127477667486, 12);
  });

  it("accepts an empty list (a pool with no trade)", () => {
    expect(parseCandles({ data: { attributes: { ohlcv_list: [] } } })).toEqual([]);
  });

  it("refuses what is not a candle list, a candle with a missing number, and two candles for one start", () => {
    for (const bad of [null, {}, { data: { attributes: { ohlcv_list: "x" } } }, { data: { attributes: { ohlcv_list: [[1, 2, 3]] } } }, { data: { attributes: { ohlcv_list: [[1, 2, 3, 4, 5, Number.NaN]] } } }]) expect(() => parseCandles(bad)).toThrow(ParseError);
    expect(() => parseCandles({ data: { attributes: { ohlcv_list: [[10, 1, 1, 1, 1, 1], [10, 2, 2, 2, 2, 2]] } } })).toThrow(/twice|duplicate/i);
  });

  it("refuses a candle whose high is below its low, or a negative price or volume", () => {
    for (const row of [[10, 1, 1, 2, 1, 1], [10, -1, 1, 1, 1, 1], [10, 1, 1, 1, 1, -5]]) expect(() => parseCandles({ data: { attributes: { ohlcv_list: [row] } } }), JSON.stringify(row)).toThrow(ParseError);
  });
});

describe("buildPath", () => {
  it("keeps the minute candles that are over by S, and not one that is still running", () => {
    const m = [cd(S - M, 1, 1, 1, 1), cd(S - M + 1, 1, 1, 1, 1)];
    expect(buildPath(m, [], S, S).map((c) => c.start)).toEqual([S - M]);
  });

  it("keeps the hourly candles that start at S or later and are over by the limit, not the one that contains S, and not one that ends a millisecond late", () => {
    const until = T0 + 10 * H;
    const hourly = [pool("A", [hr(1, 1), cd(S, 1, 1, 1, 1, 5), hr(9, 1), hr(10, 1)])];
    expect(buildPath([], hourly, S, until).map((c) => c.start)).toEqual([S, T0 + 9 * H]);
    expect(buildPath([], [pool("A", [cd(until - H + 1, 1, 1, 1, 1)])], S, until)).toEqual([]);
    expect(buildPath([], [pool("A", [cd(until - H, 1, 1, 1, 1)])], S, until)).toHaveLength(1);
  });

  it("takes each hour from the pool that traded most in that hour, the smaller name on a tie, and joins the hours in time order", () => {
    const a = pool("A", [hr(2, 1, { volume: 10 }), hr(3, 1, { volume: 50 }), hr(4, 1, { volume: 7 })]);
    const b = pool("B", [hr(3, 2, { volume: 60 }), hr(4, 3, { volume: 7 }), hr(5, 4, { volume: 1 })]);
    const path = buildPath([], [b, a], S, T0 + 100 * H);
    expect(path.map((c) => [c.start, c.close])).toEqual([[T0 + 2 * H, 1], [T0 + 3 * H, 2], [T0 + 4 * H, 1], [T0 + 5 * H, 4]]);
  });

  it("puts the minute candles first and does not mind the order the inputs came in", () => {
    const path = buildPath([cd(T0 + 5 * M, 1, 1, 1, 1), cd(T0, 1, 1, 1, 1)], [pool("A", [hr(4, 1), hr(2, 1)])], S, T0 + 100 * H);
    expect(path.map((c) => c.start)).toEqual([T0, T0 + 5 * M, T0 + 2 * H, T0 + 4 * H]);
  });
});

describe("labelToken: the order of the tests", () => {
  it("a token that never moves and keeps trading is a survivor", () => {
    expect(labelToken(base())).toEqual({ label: "survived", reason: "traded and kept liquidity at 30 days" });
  });

  it("with no candle in the first hour nothing can be said", () => {
    expect(labelToken(base({ minute: [] }))).toEqual({ label: "neither", reason: "no-price-data" });
  });

  it("a price already at a tenth of its peak at S is collapsed before scoring, exactly a tenth included", () => {
    const at = (close: number): LabelInput => base({ minute: minutes(1, { 59: { open: close, high: close, low: close, close } }) });
    expect(labelToken(at(0.1)).label).toBe("collapsed-before-scoring");
    expect(labelToken(at(0.1000001)).label).not.toBe("collapsed-before-scoring");
    expect(labelToken(at(0.05)).label).toBe("collapsed-before-scoring");
  });

  it("collapsed before scoring wins over everything after it", () => {
    expect(labelToken(rugged({ minute: minutes(1, { 59: { open: 0.05, high: 0.05, low: 0.05, close: 0.05 } }) })).label).toBe("collapsed-before-scoring");
  });
});

describe("labelToken: rugged", () => {
  it("a candle that falls to a twentieth, a price at +72 h far below a quarter of the peak, a creator that holds nothing: a rug", () => {
    expect(labelToken(rugged())).toMatchObject({ label: "rugged" });
  });

  it("is a rug at exactly a tenth for the low and exactly a quarter for the price, and not a hair above either", () => {
    const path = (low: number, last: number): LabelInput => base({ hourly72: [pool("A", [...hours(2, 5, 1), hr(6, low, { high: 1, low, close: low }), ...hours(7, 70, 0.5), hr(71, last)])] });
    expect(labelToken(path(0.1, 0.25)).label).toBe("rugged");
    expect(labelToken(path(0.1000001, 0.25)).label).not.toBe("rugged");
    expect(labelToken(path(0.1, 0.2500001)).label).not.toBe("rugged");
  });

  it("a fall that comes back is not a rug (collapsed and recovered)", () => {
    const back = base({ hourly72: [pool("A", [...hours(2, 5, 1), hr(6, 0.05, { high: 1, low: 0.05, close: 0.05 }), ...hours(7, 71, 0.9)])] });
    expect(labelToken(back)).toEqual({ label: "neither", reason: "collapsed-and-recovered" });
  });

  it("the peak counts the first hour: a token that rose in minutes and then fell is measured from that peak", () => {
    const up = { 30: { high: 10, close: 10 }, 31: { open: 10, high: 10, low: 1.5, close: 1.5 } };
    const calm = base({ minute: minutes(1.5, up), hourly72: [pool("A", hours(2, 71, 1.5))] }); // 1.5 is above a tenth of 10: no collapse
    expect(labelToken(calm).label).not.toBe("rugged");
    const fall = base({ minute: minutes(1.5, up), hourly72: [pool("A", [...hours(2, 5, 1.5), hr(6, 1.5, { high: 1.5, low: 0.9, close: 1.5 }), ...hours(7, 71, 1.5)])] });
    expect(labelToken(fall).label).toBe("rugged"); // low 0.9 <= 10% of 10, and 1.5 <= 25% of 10
  });

  it("a candle after +72 h is not looked at, however late the reading was taken", () => {
    const late = base({ hourly72: [pool("A", [...hours(2, 71, 1), hr(72, 0.01, { high: 1, low: 0.01, close: 0.01 })])] });
    expect(labelToken(late).label).toBe("survived");
  });

  it("the hour that contains S is not looked at", () => {
    const contains = base({ hourly72: [pool("A", [hr(1, 0.01, { high: 1, low: 0.01, close: 0.01 }), ...hours(2, 71, 1)])] });
    expect(labelToken(contains).label).toBe("survived");
  });

  it("a missed +72 h reading is a missing label, never a rug and never a survivor", () => {
    expect(labelToken(rugged({ hourly72: null }))).toEqual({ label: "neither", reason: "missing-72h" });
    expect(labelToken(base({ hourly72: null }))).toEqual({ label: "neither", reason: "missing-72h" });
  });

  it("a rug is a rug whatever the 30 day reading says, and even when it was missed", () => {
    expect(labelToken(rugged({ hourly30d: null })).label).toBe("rugged");
  });

  it("takes the fall from whichever pool traded most in that hour, so a fall on the curve counts while the curve is the busy one", () => {
    const curve = pool("curve", [...hours(2, 3, 1), hr(4, 0.05, { high: 1, low: 0.05, close: 0.05, volume: 500 }), ...hours(5, 6, 0.02)]);
    const amm = pool("amm", [...hours(4, 71, 1, () => ({ volume: 50 }))]);
    const mixed = base({ hourly72: [curve, amm] });
    // at hour 4 the curve (500) beats the pool (50): its fall counts; from hour 7 only the pool trades, at price 1: recovered
    expect(labelToken(mixed)).toEqual({ label: "neither", reason: "collapsed-and-recovered" });
    const flatAmm = base({ hourly72: [curve, pool("amm", [hr(4, 1, { volume: 900 }), ...hours(5, 71, 0.02)])] });
    // the pool traded more in hour 4, so the curve's fall is not the path; from hour 5 the pool itself trades at 0.02
    expect(labelToken(flatAmm).label).toBe("rugged"); // from hour 5 the busy pool trades at 0.02: a low at 2% of the peak, and it stays there
  });
});

describe("labelToken: the creator who sat through it", () => {
  it("a creator who still holds more than 90% of what it held at +60 minutes made an ordinary failure, not a rug", () => {
    expect(labelToken(rugged({ creatorAtScoring: 1000n, creatorAt72h: 1000n }))).toEqual({ label: "neither", reason: "no-recovery-with-creator-held" });
    expect(labelToken(rugged({ creatorAtScoring: 1000n, creatorAt72h: 901n })).label).toBe("neither");
  });

  it("holding exactly 90% is not more than 90%: a rug", () => {
    expect(labelToken(rugged({ creatorAtScoring: 1000n, creatorAt72h: 900n })).label).toBe("rugged");
  });

  it("a creator no longer listed at +72 h holds nothing: a rug", () => {
    expect(labelToken(rugged({ creatorAtScoring: 1000n, creatorAt72h: null })).label).toBe("rugged");
  });

  it("when the +72 h report is missing and the creator held tokens, the label is missing, not a rug", () => {
    expect(labelToken(rugged({ creatorAtScoring: 1000n, creatorAt72h: "unknown" }))).toEqual({ label: "neither", reason: "creator-at-72h-unknown" });
  });

  it("a creator with nothing at +60 minutes cannot be shown to have held: the collapse alone decides, even with no +72 h report", () => {
    expect(labelToken(rugged({ creatorAtScoring: null, creatorAt72h: "unknown" })).label).toBe("rugged");
    expect(labelToken(rugged({ creatorAtScoring: 0n, creatorAt72h: "unknown" })).label).toBe("rugged");
  });

  it("the creator is only asked about when there was a collapse without recovery", () => {
    expect(labelToken(base({ creatorAtScoring: 1000n, creatorAt72h: "unknown" })).label).toBe("survived");
  });
});

describe("labelToken: survived and the rest", () => {
  const thirty = (candles: Candle[], reserve: number | null = 5000, extra: Partial<LabelInput> = {}): LabelInput => base({ hourly30d: [pool("A", candles)], pools30d: reserve === null ? null : [{ pool: "A", reserveUsd: reserve }], ...extra });

  it("needs the +30 d reading: without it the label is missing", () => {
    expect(labelToken(base({ hourly30d: null }))).toEqual({ label: "neither", reason: "missing-30d" });
  });

  it("a low at a tenth of the peak after +72 h is a collapse after +72 h, not a survivor", () => {
    const dip = [...hours(2, 100, 1), hr(101, 0.05, { high: 1, low: 0.05, close: 0.05 }), ...hours(102, 719, 1)];
    expect(labelToken(thirty(dip))).toEqual({ label: "neither", reason: "collapsed-after-72h" });
  });

  it("a dip in the first hour that came back is not a rug, but it is not a survivor either", () => {
    const dipped = base({ minute: minutes(1, { 10: { open: 1, high: 1, low: 0.05, close: 1 } }) });
    expect(labelToken(dipped)).toEqual({ label: "neither", reason: "dipped-before-scoring" });
  });

  it("the last 24 hours must have traded at least USD 1,000, exactly 1,000 included", () => {
    const vol = (last: number): Candle[] => hours(2, 719, 1, (k) => ({ volume: k === 719 ? last : k >= 696 ? 40 : 5 })); // 23 x 40 + last
    expect(labelToken(thirty(vol(80))).label).toBe("survived"); // 920 + 80 = 1000
    expect(labelToken(thirty(vol(79)))).toEqual({ label: "neither", reason: "faded" }); // 999
  });

  it("volume from before the last 24 hours does not count", () => {
    const early = hours(2, 719, 1, (k) => (k < 696 ? { volume: 100_000 } : { volume: 1 }));
    expect(labelToken(thirty(early)).label).toBe("neither");
  });

  it("the last 24 hours end at +30 d: a busy hour that ends after it does not count", () => {
    const late = [...hours(2, 695, 1, () => ({ volume: 0 })), ...hours(696, 719, 1, () => ({ volume: 0 })), hr(720, 1, { volume: 100_000 })];
    expect(labelToken(thirty(late)).label).toBe("neither");
  });

  it("the pool must also hold at least USD 1,000 of liquidity, exactly 1,000 included, and the liquidity must be that of the same pool", () => {
    expect(labelToken(thirty(hours(2, 719, 1), 1000)).label).toBe("survived");
    expect(labelToken(thirty(hours(2, 719, 1), 999.99))).toEqual({ label: "neither", reason: "faded" });
    const other = base({ hourly30d: [pool("A", hours(2, 719, 1))], pools30d: [{ pool: "B", reserveUsd: 50_000 }] });
    expect(labelToken(other).label).toBe("neither");
  });

  it("a survivor can be a different pool from the one it started on, if that pool passes both tests", () => {
    const moved = base({ hourly30d: [pool("curve", hours(2, 20, 1)), pool("amm", hours(21, 719, 1))], pools30d: [{ pool: "curve", reserveUsd: 0 }, { pool: "amm", reserveUsd: 9000 }] });
    expect(labelToken(moved).label).toBe("survived");
  });

  it("when the pools reply of the +30 d reading is missing the liquidity is not known: the label is missing", () => {
    expect(labelToken(thirty(hours(2, 719, 1), null))).toEqual({ label: "neither", reason: "liquidity-unknown" });
  });

  it("a pool with an unknown liquidity (null) does not pass", () => {
    expect(labelToken(base({ pools30d: [{ pool: "A", reserveUsd: null }] })).label).toBe("neither");
  });
});

describe("labelToken: the cases a mutation check asked for", () => {
  it("on a tie in an hour's volume the smaller pool name supplies the candle, whichever order the pools are given", () => {
    const a = pool("A", [hr(2, 1, { volume: 7 })]);
    const b = pool("B", [hr(2, 2, { volume: 7 })]);
    expect(buildPath([], [a, b], S, T0 + 100 * H)[0]!.close).toBe(1);
    expect(buildPath([], [b, a], S, T0 + 100 * H)[0]!.close).toBe(1);
  });

  it("the peak is the highest HIGH, not the highest close: a spike that did not close still sets it", () => {
    const spike = { 30: { high: 5, close: 1 } }; // rose to 5 inside a minute and closed back at 1 (a fifth: not yet a collapse at S)
    const world = base({ minute: minutes(1, spike), hourly72: [pool("A", [...hours(2, 5, 1), hr(6, 0.45, { high: 1, low: 0.45, close: 0.45 }), ...hours(7, 71, 1)])] });
    expect(labelToken(world).label).toBe("rugged"); // low 0.45 <= 10% of 5, and the price 1 <= 25% of 5
  });

  it("works at real pump.fun prices (a few 1e-7), not only at prices near 1", () => {
    const k = 3e-7;
    const scaled = [...hours(2, 5, k), hr(6, k * 0.05, { high: k, low: k * 0.05, close: k * 0.05 }), ...hours(7, 71, k * 0.02)];
    expect(labelToken(base({ minute: minutes(k), hourly72: [pool("A", scaled)], hourly30d: [pool("A", scaled)] })).label).toBe("rugged");
    expect(labelToken(base({ minute: minutes(k), hourly72: [pool("A", hours(2, 71, k))], hourly30d: [pool("A", hours(2, 719, k))] })).label).toBe("survived");
  });

  it("a collapse in a candle that starts exactly at S counts", () => {
    const atS = [cd(S, 1, 1, 0.05, 0.05, 100), ...hours(2, 71, 0.2)];
    expect(labelToken(base({ hourly72: [pool("A", atS)] })).label).toBe("rugged"); // the later hours stay at 0.2: no further collapse, and 0.2 <= 25%
  });

  it("the price at S is the close of the last first-hour candle, not its low: a long wick that came back is not a collapse", () => {
    const wick = minutes(1, { 59: { open: 1, high: 1, low: 0.05, close: 1 } });
    expect(labelToken(base({ minute: wick })).label).not.toBe("collapsed-before-scoring");
  });

  it("no price at all is reported before a missing reading, and a collapse before scoring is reported before a missing reading", () => {
    expect(labelToken(base({ minute: [], hourly72: null }))).toEqual({ label: "neither", reason: "no-price-data" });
    const dead = minutes(1, { 59: { open: 0.05, high: 0.05, low: 0.05, close: 0.05 } });
    expect(labelToken(base({ minute: dead, hourly72: null })).label).toBe("collapsed-before-scoring");
  });
});
