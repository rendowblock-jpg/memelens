// Turns what the collector stored for one token (its readings and the replies in them, exactly as received) into the input
// of the labeller (label.ts), and labels it. Reads nothing but stored replies. A reply that cannot be read is said so, never
// repaired: the token is labelled `neither` with the reason.
import { ReportError, parseReport } from "./export";
import { labelToken, parseCandles, type Candle, type Label, type LabelInput, type LabelResult, type PoolCandles } from "./label";
import { parseTokenPools } from "./parse";
import type { Payload, TaskStatus } from "./store";

export interface StoredTask {
  status: TaskStatus;
  payloads: Payload[];
}

export interface StoredToken {
  mint: string;
  /** Unix ms: when the pool was created. */
  createdAt: number;
  snapshot: StoredTask | null;
  path72: StoredTask | null;
  path30d: StoredTask | null;
}

export type Loaded = { ok: true; input: LabelInput } | { ok: false; reason: string };

class Unreadable extends Error {}

const valid = (t: StoredTask, step: string): Payload | undefined => t.payloads.find((p) => p.step === step && p.valid);

/** Candles from a stored reply: none for a 404 (the source has no trades for the pool), an error for anything unreadable. */
function candlesOf(p: Payload): Candle[] {
  if (p.status === 404) return [];
  try {
    return parseCandles(JSON.parse(p.body));
  } catch {
    throw new Unreadable();
  }
}

/** The hourly candles of every stored pool of a finished reading; null when the reading was not finished. */
function hourlyOf(t: StoredTask | null): PoolCandles[] | null {
  if (t === null || t.status !== "done") return null;
  return t.payloads.filter((p) => p.valid && p.step.startsWith("candles-hour:")).map((p) => ({ pool: p.step.slice("candles-hour:".length), candles: candlesOf(p) }));
}

/** The report's creator, or null when there is no readable report or it names none. */
function creatorOf(p: Payload | undefined): string | null {
  if (p === undefined || p.status !== 200) return null;
  try {
    return parseReport(JSON.parse(p.body)).creator;
  } catch (error) {
    if (error instanceof ReportError || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** What `creator` holds in a stored report: null when it is not listed (or holds 0), "unknown" when there is no readable report. */
function listedAmount(p: Payload | undefined, creator: string): bigint | null | "unknown" {
  if (p === undefined || p.status !== 200) return "unknown";
  try {
    const view = parseReport(JSON.parse(p.body));
    let sum = 0n;
    for (const h of view.holders) if (h.owner === creator) sum += h.amount;
    return sum === 0n ? null : sum;
  } catch (error) {
    if (error instanceof ReportError || error instanceof SyntaxError) return "unknown";
    throw error;
  }
}

/** The pools of the 30 day reading with their liquidity; null when the reply is missing, a 404 or unreadable. */
function poolsOf(t: StoredTask | null): LabelInput["pools30d"] {
  if (t === null || t.status !== "done") return null;
  const p = valid(t, "token-pools");
  if (p === undefined || p.status !== 200) return null;
  try {
    return parseTokenPools(JSON.parse(p.body)).map((x) => ({ pool: x.pool, reserveUsd: x.reserveUsd }));
  } catch {
    return null;
  }
}

export function loadLabelInput(t: StoredToken): Loaded {
  const first = t.snapshot;
  if (first !== null && first.status === "pending") return { ok: false, reason: "pending-first-hour" };
  const firstReport = first !== null && first.status === "done" ? valid(first, "report") : undefined;
  if (first === null || firstReport === undefined) return { ok: false, reason: "missing-first-hour" };
  try {
    const minutePayload = valid(first, "candles-minute");
    const creator = creatorOf(firstReport);
    const atScoring = creator === null ? null : listedAmount(firstReport, creator);
    const report72 = t.path72 !== null && t.path72.status === "done" ? valid(t.path72, "report") : undefined;
    const at72 = t.path72 === null || t.path72.status !== "done" ? "unknown" : creator === null ? null : listedAmount(report72, creator);
    return {
      ok: true,
      input: {
        createdAt: t.createdAt,
        scoredAt: firstReport.fetchedAt,
        minute: minutePayload === undefined ? [] : candlesOf(minutePayload),
        hourly72: hourlyOf(t.path72),
        hourly30d: hourlyOf(t.path30d),
        creatorAtScoring: atScoring === "unknown" ? null : atScoring,
        creatorAt72h: at72,
        pools30d: poolsOf(t.path30d),
      },
    };
  } catch (error) {
    if (error instanceof Unreadable) return { ok: false, reason: "unreadable-candles" };
    throw error;
  }
}

/**
 * A token's label from what was stored for it. A reading that is still to come ("pending") is told apart from one that was
 * missed: the first is not a final label, the second is.
 */
export function labelStored(t: StoredToken): LabelResult {
  const loaded = loadLabelInput(t);
  if (!loaded.ok) return { label: "neither", reason: loaded.reason };
  const r = labelToken(loaded.input);
  if (r.label === "neither" && r.reason === "missing-72h" && t.path72?.status === "pending") return { label: "neither", reason: "pending-72h" };
  if (r.label === "neither" && r.reason === "missing-30d" && t.path30d?.status === "pending") return { label: "neither", reason: "pending-30d" };
  return r;
}

export interface LabelRow {
  mint: string;
  createdAt: number;
  label: Label;
  reason: string;
}

export interface LabelSummary {
  total: number;
  byLabel: Record<Label, number>;
  /** How many `neither` rows had each reason. */
  neitherByReason: Record<string, number>;
}

export function summarizeLabels(rows: readonly LabelRow[]): LabelSummary {
  const byLabel: Record<Label, number> = { rugged: 0, survived: 0, neither: 0, "collapsed-before-scoring": 0 };
  const neitherByReason: Record<string, number> = {};
  for (const r of rows) {
    byLabel[r.label]++;
    if (r.label === "neither") neitherByReason[r.reason] = (neitherByReason[r.reason] ?? 0) + 1;
  }
  return { total: rows.length, byLabel, neitherByReason };
}
