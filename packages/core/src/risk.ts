import type { Concentration } from "./concentration";

export type SignalId =
  | "top10Share"
  | "hhi"
  | "creatorShare"
  | "creatorDumps"
  | "liquidity"
  | "mintAuthority"
  | "freezeAuthority"
  | "clustering"
  | "washTrading"
  | "age";

export type RiskLevel = "low" | "medium" | "high" | "critical" | "unknown";

/** Every field is optional: a missing field means "not known", never "safe". */
export interface RiskInput {
  /** From analyzeConcentration(). Uses topShare[10] and hhi. */
  concentration?: Pick<Concentration, "hhi" | "topShare">;
  /** Share (0..1) of the counted supply held by the token creator. */
  creatorShare?: number;
  /** Number of earlier tokens by this creator that the creator dumped on holders. Integer >= 0. */
  creatorDumpCount?: number;
  /** Liquidity-pool size and market cap, in the same raw quote units. */
  liquidityQuote?: bigint;
  marketCapQuote?: bigint;
  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
  /** Share (0..1) of supply held by wallets that share a funding source. */
  clusteredShare?: number;
  /** Share (0..1) of volume that looks like wash trading. */
  washTradeRatio?: number;
  /** Token age in milliseconds, as of the moment being scored. Never read from the clock. */
  ageMs?: number;
}

export interface RiskOptions {
  /** Override default weights by signal id. Weight 0 removes a signal from the score. */
  weights?: Partial<Record<SignalId, number>>;
  /** Below this share of total weight being known, the level is "unknown". Default 0.5. */
  minCoverage?: number;
}

export interface RiskSignal {
  id: SignalId;
  label: string;
  known: boolean;
  /** The measured value (number, boolean), or null when unknown. */
  value: number | boolean | null;
  weight: number;
  /** 0 (no concern) .. 1 (maximum concern). 0 when unknown. */
  risk: number;
  /** Points this signal adds to the score. Contributions sum to `score`. */
  contribution: number;
}

export interface RiskReport {
  /** 0..100, normalised over the known signals. */
  score: number;
  level: RiskLevel;
  /** Share (0..1) of the total weight that was known. */
  coverage: number;
  /** Signals that force level >= "high" regardless of the score. */
  hardFlags: SignalId[];
  /** Always in the same fixed order. */
  signals: RiskSignal[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const ORDER: readonly SignalId[] = [
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

export const DEFAULT_RISK_WEIGHTS: Readonly<Record<SignalId, number>> = {
  top10Share: 15,
  hhi: 10,
  creatorShare: 15,
  creatorDumps: 15,
  liquidity: 15,
  mintAuthority: 8,
  freezeAuthority: 4,
  clustering: 8,
  washTrading: 5,
  age: 5,
};

const LABELS: Readonly<Record<SignalId, string>> = {
  top10Share: "Top-10 holders' share of supply",
  hhi: "Holder concentration (HHI)",
  creatorShare: "Creator's share of supply",
  creatorDumps: "Creator's earlier dumps",
  liquidity: "Liquidity pool vs. market cap",
  mintAuthority: "Mint authority still active",
  freezeAuthority: "Freeze authority still active",
  clustering: "Supply held by wallets with a shared funder",
  washTrading: "Share of volume that looks like wash trading",
  age: "Token age",
};

/** Score thresholds: below the first is "low", and so on. At or above the last is "critical". */
const LEVEL_BELOW: readonly [number, RiskLevel][] = [
  [25, "low"],
  [50, "medium"],
  [75, "high"],
];

const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = { unknown: -1, low: 0, medium: 1, high: 2, critical: 3 };

const RATIO_SCALE = 10n ** 6n;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 0 at or below `lo`, 1 at or above `hi`, linear in between. */
function ramp(value: number, lo: number, hi: number): number {
  return clamp01((value - lo) / (hi - lo));
}

function unitInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be within 0..1, got ${value}`);
  return value;
}

function nonNegativeBigint(value: unknown, name: string): bigint {
  if (typeof value !== "bigint") throw new TypeError(`${name} must be a bigint, got ${typeof value}`);
  if (value < 0n) throw new RangeError(`${name} must be >= 0`);
  return value;
}

interface Reading {
  value: number | boolean;
  risk: number;
}

function readInput(input: RiskInput): Record<SignalId, Reading | null> {
  const out = Object.fromEntries(ORDER.map((id) => [id, null])) as Record<SignalId, Reading | null>;

  const c = input.concentration;
  if (c !== undefined) {
    const top10 = c.topShare[10];
    if (top10 !== undefined) {
      unitInterval(top10, "concentration.topShare[10]");
      out.top10Share = { value: top10, risk: ramp(top10, 0.2, 0.8) };
    }
    unitInterval(c.hhi, "concentration.hhi");
    out.hhi = { value: c.hhi, risk: ramp(c.hhi, 0.02, 0.25) };
  }

  if (input.creatorShare !== undefined) {
    unitInterval(input.creatorShare, "creatorShare");
    out.creatorShare = { value: input.creatorShare, risk: ramp(input.creatorShare, 0.02, 0.2) };
  }

  if (input.creatorDumpCount !== undefined) {
    const n = input.creatorDumpCount;
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`creatorDumpCount must be an integer >= 0, got ${n}`);
    out.creatorDumps = { value: n, risk: ramp(n, 0, 3) };
  }

  const lp = input.liquidityQuote === undefined ? undefined : nonNegativeBigint(input.liquidityQuote, "liquidityQuote");
  const mcap = input.marketCapQuote === undefined ? undefined : nonNegativeBigint(input.marketCapQuote, "marketCapQuote");
  if (lp !== undefined && mcap !== undefined && mcap > 0n) {
    const ratio = Number((lp * RATIO_SCALE) / mcap) / Number(RATIO_SCALE);
    out.liquidity = { value: ratio, risk: 1 - ramp(ratio, 0.02, 0.2) };
  }

  if (input.mintAuthorityActive !== undefined) {
    out.mintAuthority = { value: input.mintAuthorityActive, risk: input.mintAuthorityActive ? 1 : 0 };
  }
  if (input.freezeAuthorityActive !== undefined) {
    out.freezeAuthority = { value: input.freezeAuthorityActive, risk: input.freezeAuthorityActive ? 1 : 0 };
  }

  if (input.clusteredShare !== undefined) {
    unitInterval(input.clusteredShare, "clusteredShare");
    out.clustering = { value: input.clusteredShare, risk: ramp(input.clusteredShare, 0.05, 0.4) };
  }
  if (input.washTradeRatio !== undefined) {
    unitInterval(input.washTradeRatio, "washTradeRatio");
    out.washTrading = { value: input.washTradeRatio, risk: ramp(input.washTradeRatio, 0.1, 0.5) };
  }

  if (input.ageMs !== undefined) {
    if (!Number.isFinite(input.ageMs) || input.ageMs < 0) throw new RangeError(`ageMs must be a finite number >= 0, got ${input.ageMs}`);
    out.age = { value: input.ageMs, risk: 1 - ramp(input.ageMs, HOUR_MS, 7 * DAY_MS) };
  }

  return out;
}

function resolveWeights(overrides: RiskOptions["weights"]): Record<SignalId, number> {
  const weights = { ...DEFAULT_RISK_WEIGHTS };
  if (overrides === undefined) return weights;
  for (const [key, w] of Object.entries(overrides)) {
    if (!(ORDER as readonly string[]).includes(key)) throw new RangeError(`unknown signal id in weights: ${key}`);
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0) throw new RangeError(`weight for ${key} must be a finite number >= 0, got ${w}`);
    weights[key as SignalId] = w;
  }
  return weights;
}

function levelForScore(score: number): RiskLevel {
  for (const [below, level] of LEVEL_BELOW) if (score < below) return level;
  return "critical";
}

/**
 * Explainable token risk score: a weighted sum of signals, each shown with its
 * value, risk (0..1), weight and contribution in points.
 *
 * Unknown inputs are never treated as safe. They are left out, the score is
 * normalised over what is known, and `coverage` says how much of the weight that
 * was. Below `minCoverage` the level is "unknown". Active mint/freeze authority
 * are hard flags that force the level to at least "high" whatever the score is.
 *
 * Pure: age is passed in, nothing reads the clock.
 */
export function scoreRisk(input: RiskInput, options: RiskOptions = {}): RiskReport {
  const minCoverage = options.minCoverage ?? 0.5;
  if (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) {
    throw new RangeError(`minCoverage must be within 0..1, got ${minCoverage}`);
  }
  const weights = resolveWeights(options.weights);
  const readings = readInput(input);

  let totalWeight = 0;
  let knownWeight = 0;
  let weightedRisk = 0;
  for (const id of ORDER) {
    totalWeight += weights[id];
    const r = readings[id];
    if (r !== null) {
      knownWeight += weights[id];
      weightedRisk += weights[id] * r.risk;
    }
  }

  const score = knownWeight > 0 ? (100 * weightedRisk) / knownWeight : 0;
  const coverage = totalWeight > 0 ? knownWeight / totalWeight : 0;

  const signals: RiskSignal[] = ORDER.map((id) => {
    const r = readings[id];
    return {
      id,
      label: LABELS[id],
      known: r !== null,
      value: r === null ? null : r.value,
      weight: weights[id],
      risk: r === null ? 0 : r.risk,
      contribution: r === null || knownWeight === 0 ? 0 : (100 * weights[id] * r.risk) / knownWeight,
    };
  });

  const hardFlags: SignalId[] = [];
  if (input.mintAuthorityActive === true) hardFlags.push("mintAuthority");
  if (input.freezeAuthorityActive === true) hardFlags.push("freezeAuthority");

  let level: RiskLevel = knownWeight === 0 || coverage < minCoverage ? "unknown" : levelForScore(score);
  if (hardFlags.length > 0 && LEVEL_RANK[level] < LEVEL_RANK.high) level = "high";

  return { score, level, coverage, hardFlags, signals };
}
