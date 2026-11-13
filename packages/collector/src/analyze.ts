// The calibration result: label every collected token, pick the groups, score the picked ones through the app's own risk code
// at the first-hour reading, and tally. It runs once, after every reading has been taken or given up on, and refuses before.
// Nothing here reads a score before the picks are fixed, and nothing is dropped after a label is known (docs/DESIGN.md,
// "Calibration collection").
import type { RiskLevel } from "@memelens/core";
import { parseFixture, Store, tokenRisk } from "@memelens/data";
import { buildFixture, parseReport, protocolWallets, ReportError, snapshotFromReport, DEFAULT_MIN_CENSUS, type FixtureRow, type Quality, type ReportView } from "./export";
import { labelStored, summarizeLabels, type LabelRow, type LabelSummary, type StoredToken } from "./load";
import { pickGroup } from "./pick";

export interface AnalyzeOptions {
  /** Tokens taken from each group. Default 30. */
  groupSize?: number;
  /** The census of protocol wallets needs at least this many readable first-hour reports. Default 100. */
  minCensus?: number;
}

export interface PickedRow {
  mint: string;
  label: "rugged" | "survived";
  level: RiskLevel;
  score: number | null;
  coverage: number | null;
  /** How far the first-hour holder picture can be trusted, or "no-report" when there was none to read. */
  quality: Quality | "no-report";
  /** The token's whole supply in tokens, from the first-hour report; null when there was no report. */
  supplyTokens: number | null;
}

/** How the picked tokens of one group were scored: flagged = high or critical, left = low or medium, unknown = no level. */
export interface Tally {
  n: number;
  flagged: number;
  left: number;
  unknown: number;
}

export interface GroupReport {
  /** How many collected tokens carry the label. */
  available: number;
  picked: PickedRow[];
  all: Tally;
  /** The same, for the picked tokens whose snapshot is exact or estimated. */
  wellFormed: Tally;
  /**
   * What the picked tokens are made of. Measured on 13 Nov 2026: more than half of the tokens followed have a 2-billion supply,
   * half of it held by a protocol wallet; a result that hides this would hide what it is a result about.
   */
  bySupply: Record<SupplyBucket, number>;
}

export type SupplyBucket = "below 1.5B" | "1.5B or more" | "no report";

export interface Analysis {
  ok: true;
  labels: LabelSummary;
  census: { readable: number; used: boolean; wallets: string[] };
  rugged: GroupReport;
  survived: GroupReport;
  /** How many tokens were put through the risk code (only the picked ones). */
  scored: number;
}

export type AnalyzeResult = Analysis | { ok: false; reason: string };

const FLAGGED = new Set<RiskLevel>(["high", "critical"]);
const LEFT = new Set<RiskLevel>(["low", "medium"]);

function tally(rows: readonly PickedRow[]): Tally {
  const flagged = rows.filter((r) => FLAGGED.has(r.level)).length;
  const left = rows.filter((r) => LEFT.has(r.level)).length;
  return { n: rows.length, flagged, left, unknown: rows.length - flagged - left };
}

const pending = (t: StoredToken): boolean => [t.snapshot, t.path72, t.path30d].some((r) => r !== null && r.status === "pending");

interface Seen {
  row: LabelRow;
  view: ReportView | null;
  asOf: number;
}

export function analyze(tokens: Iterable<StoredToken>, options: AnalyzeOptions = {}): AnalyzeResult {
  const groupSize = options.groupSize ?? 30;
  const minCensus = options.minCensus ?? DEFAULT_MIN_CENSUS;

  const seen: Seen[] = [];
  let waiting = 0;
  for (const t of tokens) {
    if (pending(t)) {
      waiting++;
      continue;
    }
    const r = labelStored(t);
    const report = t.snapshot?.payloads.find((p) => p.step === "report" && p.valid);
    let view: ReportView | null = null;
    if (report !== undefined && report.status === 200) {
      try {
        const parsed = parseReport(JSON.parse(report.body));
        if (parsed.mint === t.mint) view = parsed;
      } catch (error) {
        if (!(error instanceof ReportError || error instanceof SyntaxError)) throw error;
      }
    }
    seen.push({ row: { mint: t.mint, createdAt: t.createdAt, label: r.label, reason: r.reason }, view, asOf: report?.fetchedAt ?? 0 });
  }
  if (waiting > 0) return { ok: false, reason: `${waiting} token${waiting === 1 ? "" : "s"} still ${waiting === 1 ? "has" : "have"} a reading pending: the result is only given once every reading was taken or given up on` };

  seen.sort((a, b) => a.row.createdAt - b.row.createdAt || (a.row.mint < b.row.mint ? -1 : a.row.mint > b.row.mint ? 1 : 0));
  const rows = seen.map((s) => s.row);
  const byMint = new Map(seen.map((s) => [s.row.mint, s]));

  // The census looks at holders only, over every readable report, whatever the token's outcome.
  const views = seen.flatMap((s) => (s.view === null ? [] : [s.view]));
  const censusUsed = views.length >= minCensus;
  const wallets = censusUsed ? protocolWallets(views) : new Set<string>();

  const picks: Array<{ label: "rugged" | "survived"; mint: string }> = [
    ...pickGroup(rows, "rugged", groupSize).map((mint) => ({ label: "rugged" as const, mint })),
    ...pickGroup(rows, "survived", groupSize).map((mint) => ({ label: "survived" as const, mint })),
  ];

  const fixtureRows: FixtureRow[] = [];
  for (const p of picks) {
    const s = byMint.get(p.mint)!;
    if (s.view !== null) fixtureRows.push({ view: s.view, createdAt: s.row.createdAt, asOf: s.asOf });
  }
  const data = parseFixture(JSON.parse(JSON.stringify(buildFixture(fixtureRows, wallets))));
  const store = Store.open(":memory:");
  store.transaction(() => {
    for (const t of data.tokens) store.upsertToken(data.chain, t);
    for (const s of data.snapshots) store.insertSnapshot(data.chain, s);
  });

  const scored = picks.map((p): PickedRow => {
    const s = byMint.get(p.mint)!;
    if (s.view === null) return { mint: p.mint, label: p.label, level: "unknown", score: null, coverage: null, quality: "no-report", supplyTokens: null };
    const risk = tokenRisk(store, data.chain, p.mint, s.asOf);
    return {
      mint: p.mint,
      label: p.label,
      level: risk === null ? "unknown" : risk.report.level,
      score: risk === null ? null : risk.report.score,
      coverage: risk === null ? null : risk.report.coverage,
      quality: snapshotFromReport(s.view).quality, // the quality of a report does not depend on who is excluded
      supplyTokens: Number(s.view.supply / 10n ** BigInt(s.view.decimals)),
    };
  });
  store.close();

  const group = (label: "rugged" | "survived"): GroupReport => {
    const picked = scored.filter((r) => r.label === label);
    const bySupply: Record<SupplyBucket, number> = { "below 1.5B": 0, "1.5B or more": 0, "no report": 0 };
    for (const r of picked) bySupply[r.supplyTokens === null ? "no report" : r.supplyTokens >= 1_500_000_000 ? "1.5B or more" : "below 1.5B"]++;
    return { available: rows.filter((r) => r.label === label).length, picked, all: tally(picked), wellFormed: tally(picked.filter((r) => r.quality === "exact" || r.quality === "estimated")), bySupply };
  };

  return { ok: true, labels: summarizeLabels(rows), census: { readable: views.length, used: censusUsed, wallets: [...wallets].sort() }, rugged: group("rugged"), survived: group("survived"), scored: scored.length };
}
