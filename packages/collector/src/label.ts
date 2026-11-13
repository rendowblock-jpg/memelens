// Gives a collected token its outcome label from its candles, by the rules in docs/DESIGN.md ("The labelling rules, made
// exact"). A pure function of data: it reads no clock, no score and no weight. Written against hand-computed price paths.
import { isCandles, ParseError } from "./parse";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export interface Candle {
  /** Unix ms of the start of the candle. */
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** USD traded in the candle. */
  volume: number;
}

export interface PoolCandles {
  pool: string;
  /** Hourly candles. */
  candles: Candle[];
}

export interface LabelInput {
  /** Unix ms: when the pool was created. */
  createdAt: number;
  /** Unix ms: when the first-hour reading was taken (S). */
  scoredAt: number;
  /** Minute candles of the launch pool, from the first-hour reading. */
  minute: Candle[];
  /** Hourly candles of the stored pools from the +72 h reading; null when that reading was missed. */
  hourly72: PoolCandles[] | null;
  /** The same from the +30 d reading; null when missed. */
  hourly30d: PoolCandles[] | null;
  /** The creator's listed amount in the first-hour report; null or 0 = it held nothing (or none is named). */
  creatorAtScoring: bigint | null;
  /** The creator's listed amount in the +72 h report; null = not listed (holds nothing); "unknown" = no readable report. */
  creatorAt72h: bigint | null | "unknown";
  /** Pools and their liquidity from the +30 d reading; null when that reply is missing. */
  pools30d: Array<{ pool: string; reserveUsd: number | null }> | null;
}

export type Label = "rugged" | "survived" | "neither" | "collapsed-before-scoring";
export interface LabelResult {
  label: Label;
  reason: string;
}

/** Candles from a GeckoTerminal reply, oldest first. Refuses anything that is not exactly a list of sane candles. */
export function parseCandles(json: unknown): Candle[] {
  if (!isCandles(json)) throw new ParseError("the reply is not a list of candles");
  const rows = ((json as { data: { attributes: { ohlcv_list: number[][] } } }).data.attributes.ohlcv_list);
  const out = rows.map((r): Candle => ({ start: r[0]! * 1000, open: r[1]!, high: r[2]!, low: r[3]!, close: r[4]!, volume: r[5]! }));
  for (const c of out) {
    if (c.open < 0 || c.high < 0 || c.low < 0 || c.close < 0 || c.volume < 0 || c.high < c.low) throw new ParseError(`a candle at ${c.start} has a negative number or a high below its low`);
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) if (out[i]!.start === out[i - 1]!.start) throw new ParseError(`two candles start at ${out[i]!.start} (duplicate)`);
  return out;
}

/**
 * The price path up to `until`: the minute candles that are over by S, then, for each hour that starts at S or later and is
 * over by `until`, the candle of the pool that traded most in that hour (the smaller pool name on a tie).
 */
export function buildPath(minute: readonly Candle[], pools: readonly PoolCandles[], scoredAt: number, until: number): Candle[] {
  const first = minute.filter((c) => c.start + MINUTE_MS <= scoredAt).sort((a, b) => a.start - b.start);
  const byHour = new Map<number, { pool: string; candle: Candle }>();
  for (const p of pools) {
    for (const c of p.candles) {
      if (c.start < scoredAt || c.start + HOUR_MS > until) continue;
      const cur = byHour.get(c.start);
      if (cur === undefined || c.volume > cur.candle.volume || (c.volume === cur.candle.volume && p.pool < cur.pool)) byHour.set(c.start, { pool: p.pool, candle: c });
    }
  }
  return [...first, ...[...byHour.values()].map((x) => x.candle).sort((a, b) => a.start - b.start)];
}

const peakOf = (path: readonly Candle[]): number => path.reduce((m, c) => Math.max(m, c.high), 0);

/** Whether some candle starting at or after `from` has a low at most a tenth of the largest high up to and including it. */
function collapses(path: readonly Candle[], from: number): boolean {
  let peak = 0;
  for (const c of path) {
    peak = Math.max(peak, c.high);
    if (c.start >= from && c.low * 10 <= peak) return true;
  }
  return false;
}

const neither = (reason: string): LabelResult => ({ label: "neither", reason });

export function labelToken(i: LabelInput): LabelResult {
  const first = buildPath(i.minute, [], i.scoredAt, i.scoredAt);
  if (first.length === 0) return neither("no-price-data");
  if (first[first.length - 1]!.close * 10 <= peakOf(first)) return { label: "collapsed-before-scoring", reason: "the price at scoring was at most a tenth of the peak" };

  if (i.hourly72 === null) return neither("missing-72h");
  const p72 = buildPath(i.minute, i.hourly72, i.scoredAt, i.createdAt + 72 * HOUR_MS);
  if (collapses(p72, i.scoredAt)) {
    const recovered = p72[p72.length - 1]!.close * 4 > peakOf(p72);
    if (recovered) return neither("collapsed-and-recovered");
    const held = i.creatorAtScoring !== null && i.creatorAtScoring > 0n;
    if (held) {
      if (i.creatorAt72h === "unknown") return neither("creator-at-72h-unknown");
      const still = i.creatorAt72h ?? 0n;
      if (still * 10n > i.creatorAtScoring! * 9n) return neither("no-recovery-with-creator-held");
    }
    return { label: "rugged", reason: "a candle at a tenth of the peak and no recovery to a quarter by 72 hours" };
  }

  if (i.hourly30d === null) return neither("missing-30d");
  const t30 = i.createdAt + 30 * DAY_MS;
  const p30 = buildPath(i.minute, i.hourly30d, i.scoredAt, t30);
  if (collapses(p30, Number.NEGATIVE_INFINITY)) return neither(collapses(p30, i.scoredAt) ? "collapsed-after-72h" : "dipped-before-scoring");
  if (i.pools30d === null) return neither("liquidity-unknown");

  const alive = i.hourly30d.some((p) => {
    const volume = p.candles.filter((c) => c.start >= t30 - 24 * HOUR_MS && c.start + HOUR_MS <= t30).reduce((s, c) => s + c.volume, 0);
    const reserve = i.pools30d!.find((x) => x.pool === p.pool)?.reserveUsd ?? null;
    return volume >= 1000 && reserve !== null && reserve >= 1000;
  });
  return alive ? { label: "survived", reason: "traded and kept liquidity at 30 days" } : neither("faded");
}
