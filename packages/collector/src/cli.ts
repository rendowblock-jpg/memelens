import type { Analysis, GroupReport, Tally } from "./analyze";
import type { ExportSummary } from "./export";
import type { LabelSummary } from "./load";
import type { Stats } from "./store";
import { wilson } from "./wilson";

export class UsageError extends Error {}

export type CliArgs =
  | { command: "run"; state: string; rate: number; windowHours: number; discoverEverySeconds: number }
  | { command: "status"; state: string }
  | { command: "export"; state: string; out: string; minCensus: number }
  | { command: "label"; state: string; out: string }
  | { command: "analyze"; state: string; out: string; minCensus: number; groupSize: number };

const OPTIONS: Record<string, string[]> = {
  run: ["--state", "--rate", "--window-hours", "--discover-every"],
  status: ["--state"],
  export: ["--state", "--out", "--min-census"],
  label: ["--state", "--out"],
  analyze: ["--state", "--out", "--min-census", "--group-size"],
};

/** Reads `run`, `status`, `export`, `label` and `analyze` with their options. Anything else is refused by name. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError("a command is needed: run or status");
  const allowed = OPTIONS[command];
  if (allowed === undefined) throw new UsageError(`unknown command ${command} (use run or status)`);
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    if (!allowed.includes(flag)) throw new UsageError(`unknown option ${flag}`);
    const value = rest[i + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    values.set(flag, value);
  }
  const state = values.get("--state");
  if (state === undefined || state === "") throw new UsageError("--state FILE is needed");
  if (command === "status") return { command: "status", state };
  if (command === "analyze") {
    const out = values.get("--out");
    if (out === undefined || out === "") throw new UsageError("--out FILE is needed");
    const minCensus = values.has("--min-census") ? Number(values.get("--min-census")) : 100;
    if (!Number.isInteger(minCensus) || minCensus < 1) throw new UsageError("--min-census must be a whole number of at least 1");
    const groupSize = values.has("--group-size") ? Number(values.get("--group-size")) : 30;
    if (!Number.isInteger(groupSize) || groupSize < 1) throw new UsageError("--group-size must be a whole number of at least 1");
    return { command: "analyze", state, out, minCensus, groupSize };
  }
  if (command === "label") {
    const out = values.get("--out");
    if (out === undefined || out === "") throw new UsageError("--out FILE is needed");
    return { command: "label", state, out };
  }
  if (command === "export") {
    const out = values.get("--out");
    if (out === undefined || out === "") throw new UsageError("--out FILE is needed");
    const minCensus = values.has("--min-census") ? Number(values.get("--min-census")) : 100;
    if (!Number.isInteger(minCensus) || minCensus < 1) throw new UsageError("--min-census must be a whole number of at least 1");
    return { command: "export", state, out, minCensus };
  }

  const rate = values.has("--rate") ? Number(values.get("--rate")) : 0.1;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new UsageError("--rate must be a number from 0 to 1");
  const windowHours = values.has("--window-hours") ? Number(values.get("--window-hours")) : 72;
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new UsageError("--window-hours must be a number above 0");
  const discoverEverySeconds = values.has("--discover-every") ? Number(values.get("--discover-every")) : 20;
  if (!Number.isInteger(discoverEverySeconds) || discoverEverySeconds <= 0) throw new UsageError("--discover-every must be a whole number of seconds above 0");
  return { command: "run", state, rate, windowHours, discoverEverySeconds };
}

const KIND_ORDER = ["snapshot", "path72", "path30d"];

/** The status text printed by `status` and logged now and then by `run`. */
export function formatStats(stats: Stats): string {
  const lines = [`launches seen ${stats.launches}, followed ${stats.followed}`];
  const kinds = Object.keys(stats.tasks).sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  if (kinds.length === 0) lines.push("no tasks yet");
  for (const kind of kinds) {
    const byStatus = stats.tasks[kind]!;
    lines.push(`${kind}: ${Object.keys(byStatus).sort().map((s) => `${s} ${byStatus[s]}`).join(", ")}`);
  }
  lines.push(`stored ${stats.payloads} replies, ${(stats.payloadBytes / 1024 ** 2).toFixed(1)} MiB`);
  return lines.join("\n");
}

/** The text `export` prints: how many reports were used, why the others were not, and how far the used ones can be trusted. */
export function formatExportSummary(s: ExportSummary): string {
  const q = s.byQuality;
  return [
    `reports stored ${s.stored}: used ${s.used}, no report ${s.noReport}, unreadable ${s.unreadable}`,
    s.censusUsed
      ? `protocol wallets (census over ${s.used} reports): ${s.protocolWallets.length === 0 ? "none" : s.protocolWallets.join(", ")}`
      : `protocol wallets: NOT USED (a census needs at least the number of readable reports given by --min-census; ${s.used} were readable)`,
    `quality: exact ${q.exact}, estimated ${q.estimated}, unattributed ${q.unattributed}, inconsistent ${q.inconsistent}, unmodelled ${q.unmodelled}`,
  ].join("\n");
}

/** The text `label` prints: how many tokens got each label, and why the neither ones did (the commonest reason first). */
export function formatLabelSummary(s: LabelSummary): string {
  const b = s.byLabel;
  const reasons = Object.entries(s.neitherByReason).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  return [
    `tokens labelled ${s.total}: rugged ${b.rugged}, survived ${b.survived}, neither ${b.neither}, collapsed-before-scoring ${b["collapsed-before-scoring"]}`,
    `neither because: ${reasons.length === 0 ? "none" : reasons.map(([r, n]) => `${r} ${n}`).join(", ")}`,
  ].join("\n");
}

const percent = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** "3 of 5 = 60.0% (Wilson 95%: 23.1% to 88.2%)", or null when there is nobody to count. */
function rateText(k: number, n: number): string | null {
  const w = wilson(k, n);
  return w === null ? null : `${k} of ${n} = ${percent(w.rate)} (Wilson 95%: ${percent(w.low)} to ${percent(w.high)})`;
}

function groupLines(name: string, g: GroupReport, what: string, counted: (t: Tally) => number): string[] {
  const all = g.all;
  const known = all.n - all.unknown;
  const sub = g.wellFormed;
  return [
    `${name}: ${all.n} picked of ${g.available} available`,
    `  ${what}: ${rateText(counted(all), all.n) ?? "nobody picked"}`,
    `  no level (unknown), counted as not ${what.split(" ")[0]}: ${all.unknown}`,
    `  among those with a level: ${rateText(counted(all), known) ?? "nobody"}`,
    `  snapshots exact or estimated only: ${rateText(counted(sub), sub.n) ?? "nobody"}; no level ${sub.unknown}`,
    `  picked by supply: below 1.5B ${g.bySupply["below 1.5B"]}, 1.5B or more ${g.bySupply["1.5B or more"]}, no report ${g.bySupply["no report"]}`,
  ];
}

/**
 * The text of the result: the labels, the census, and for each group the rate with its 95% interval. Unknown is never dropped:
 * the headline rate counts it as not flagged (or not left), and the rate among tokens with a level is printed next to it.
 */
export function formatAnalysis(a: Analysis): string {
  const census = a.census.used
    ? `protocol wallets: census over ${a.census.readable} readable first-hour reports found ${a.census.wallets.length === 0 ? "none" : a.census.wallets.join(", ")}`
    : `protocol wallets: NOT USED (${a.census.readable} readable first-hour reports are fewer than the minimum for a census)`;
  return [formatLabelSummary(a.labels), census, "", ...groupLines("RUGGED", a.rugged, "flagged high or critical", (t) => t.flagged), "", ...groupLines("SURVIVED", a.survived, "left at medium or below", (t) => t.left)].join("\n");
}
