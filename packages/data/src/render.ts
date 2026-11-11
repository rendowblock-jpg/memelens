import type { Concentration, PnlReport, RiskReport, SignalId, SmartMoneyReport } from "@memelens/core";

// Plain-text output for people. Pure functions: they take results and return strings.
// Amounts are raw integer units, shown exactly (never rounded through a float).

/** 1234567n -> "1,234,567", -5n -> "-5". */
export function fmtInt(n: bigint): string {
  const sign = n < 0n ? "-" : "";
  const digits = (n < 0n ? -n : n).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function fmtPct(share: number | null): string {
  return share === null ? "-" : `${(share * 100).toFixed(1)}%`;
}

export function fmtIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 0 -> "0s", 300000 -> "5m", 7500000 -> "2h 5m". */
export function fmtAge(ms: number): string {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

type Align = "l" | "r";

/** Left-aligned text columns and right-aligned number columns, two spaces apart. */
export function table(header: string[], rows: string[][], align: Align[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  const line = (r: string[]): string =>
    r
      .map((cell, c) => (align[c] === "r" ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

export function renderPnl(wallet: string, chain: string, asOf: number, report: PnlReport): string {
  const head = `PnL of ${wallet} on ${chain}, as of ${fmtIso(asOf)}\namounts are raw quote units (lamports on Solana)\n`;
  if (report.tokens.length === 0) return `${head}\nno trades for ${wallet} at or before ${fmtIso(asOf)}\n`;
  const rows = report.tokens.map((t) => [
    t.token,
    fmtInt(t.realised),
    fmtInt(t.openAmount),
    fmtInt(t.openCost),
    t.unrealised === null ? "no mark" : fmtInt(t.unrealised),
  ]);
  const lines = [
    head,
    table(["token", "realised", "open amount", "open cost", "unrealised"], rows, ["l", "r", "r", "r", "r"]),
    "",
    `total realised ${fmtInt(report.totals.realised)}, unrealised ${fmtInt(report.totals.unrealised)}`,
  ];
  if (report.totals.unmatchedProceeds !== 0n) {
    lines.push(`sells with no known buy, left out of realised: ${fmtInt(report.totals.unmatchedProceeds)}`);
  }
  if (report.totals.unmarkedTokens.length > 0) lines.push(`no mark price for: ${report.totals.unmarkedTokens.join(", ")}`);
  if (report.tokens.some((t) => t.openAmount > 0n)) {
    lines.push("open positions are valued at the last trade of each token before the as-of time; in a thin market that is indicative only");
  }
  return lines.join("\n") + "\n";
}

export function renderConcentration(
  token: string,
  chain: string,
  asOf: number,
  snapshotTime: number,
  snapshotAgeMs: number,
  c: Concentration,
): string {
  const tops = Object.keys(c.topShare)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => `top ${n}: ${fmtPct(c.topShare[n]!)}`);
  return (
    [
      `Concentration of ${token} on ${chain}, as of ${fmtIso(asOf)}`,
      `holder snapshot taken ${fmtIso(snapshotTime)} (${fmtAge(snapshotAgeMs)} before the as-of time)`,
      `holders counted ${c.holders}, counted supply ${fmtInt(c.total)} raw units (pools and burn addresses left out)`,
      tops.join("   "),
      `HHI ${c.hhi.toFixed(3)}   Gini ${c.gini.toFixed(3)}`,
    ].join("\n") + "\n"
  );
}

export function renderRisk(
  token: string,
  chain: string,
  asOf: number,
  snapshotTime: number | null,
  report: RiskReport,
  unavailable: Partial<Record<SignalId, string>>,
): string {
  const lines = [
    `Risk of ${token} on ${chain}, as of ${fmtIso(asOf)}`,
    snapshotTime === null ? "no holder snapshot was available" : `holder snapshot taken ${fmtIso(snapshotTime)}`,
    "",
    `level ${report.level.toUpperCase()}   score ${report.score.toFixed(1)} of 100`,
    `coverage ${fmtPct(report.coverage)} of the score's weight rests on known data`,
  ];
  if (report.hardFlags.length > 0) lines.push(`hard flags (force the level to at least high): ${report.hardFlags.join(", ")}`);
  const known = report.signals.filter((s) => s.known);
  if (known.length > 0) {
    lines.push("", "known signals");
    lines.push(
      table(
        ["signal", "value", "risk", "weight", "points"],
        known.map((s) => [s.id, String(s.value), s.risk.toFixed(2), String(s.weight), s.contribution.toFixed(1)]),
        ["l", "r", "r", "r", "r"],
      ),
    );
  }
  const unknown = report.signals.filter((s) => !s.known);
  if (unknown.length > 0) {
    lines.push("", "not known (left out of the score, never counted as safe)");
    lines.push(table(["signal", "why"], unknown.map((s) => [s.id, unavailable[s.id] ?? "not known"]), ["l", "l"]));
  }
  return lines.join("\n") + "\n";
}

export function renderSmart(
  chain: string,
  from: number,
  to: number,
  minClosed: number,
  report: SmartMoneyReport,
): string {
  const lines = [
    `Smart money on ${chain}, window ${fmtIso(from)} to ${fmtIso(to)}`,
    `a wallet needs at least ${minClosed} closed tokens and a profit to be ranked; "hit low" is the 95% lower bound of its hit rate`,
    "amounts are raw quote units",
    "",
  ];
  if (report.ranked.length === 0) lines.push("nobody is ranked");
  else {
    lines.push(
      table(
        ["rank", "wallet", "realised", "closed", "wins", "hit rate", "hit low", "roi"],
        report.ranked.map((w) => [
          String(w.rank),
          w.address,
          fmtInt(w.realised),
          String(w.closedTokens),
          String(w.wins),
          fmtPct(w.hitRate),
          fmtPct(w.hitRateLow),
          fmtPct(w.roi),
        ]),
        ["r", "l", "r", "r", "r", "r", "r", "r"],
      ),
    );
  }
  if (report.unranked.length > 0) {
    lines.push("", "not ranked");
    lines.push(
      table(
        ["wallet", "reason", "realised", "closed"],
        report.unranked.map((w) => [w.address, w.reason, fmtInt(w.realised), String(w.closedTokens)]),
        ["l", "l", "r", "r"],
      ),
    );
  }
  return lines.join("\n") + "\n";
}
