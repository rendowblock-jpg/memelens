// Turns a stored RugCheck report into the holder snapshot the risk code reads (docs/DESIGN.md, "Calibration collection",
// "Scoring input at S"). Every rule here was measured on real reports on 13 Nov 2026, before any outcome existed, and the
// numbers are checked against an independent implementation (test/reference/export_reference.py). Nothing here looks at a
// price, a label or an outcome.

/** A reply that cannot be read exactly. The caller counts it and moves on; nothing is repaired. */
export class ReportError extends Error {}

/**
 * pump.fun mints 1,000,000,000 tokens and sells 793,100,000 of them on the curve; the other 206,900,000 stay in the curve's
 * account until it graduates. Measured: where the curve is listed as a holder, its listed balance equals the market's
 * vault balance plus this reserve exactly (6 of 6 reports), so a curve that is NOT listed is known by the same sum.
 */
export const PUMP_RESERVE_TOKENS = 206_900_000n;

export interface ReportHolder {
  owner: string;
  amount: bigint;
}

export interface ReportMarket {
  /** The market's address: the owner of its token account(s). */
  pubkey: string;
  /** RugCheck's `marketType`, e.g. "pump_fun" (the bonding curve) or "pump_fun_amm" (the pool after it graduates). */
  type: string;
  /** The balance of the market's account for THIS token, or null when the report does not give it. */
  vault: bigint | null;
}

export interface ReportView {
  mint: string;
  supply: bigint;
  decimals: number;
  creator: string | null;
  /** RugCheck's count of holders: the listed ones and the unlisted ones. A curve that is not listed is not in it. */
  totalHolders: number;
  holders: ReportHolder[];
  markets: ReportMarket[];
  /** Known accounts of type AMM or LOCKER: they hold tokens but are not holders. */
  nonHolders: ReadonlySet<string>;
  /** null = the report does not say. */
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** An amount JSON can carry exactly: a whole number up to 2^53. Anything else is refused, never rounded. */
function exact(v: unknown, what: string, min = 0): bigint {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw new ReportError(`${what} must be a whole number of at least ${min} that a JSON number holds exactly, got ${String(v)}`);
  return BigInt(v);
}

const authority = (v: unknown): boolean | null => (v === undefined ? null : v === null ? false : typeof v === "string" && v.length > 0 ? true : null);

export function parseReport(json: unknown): ReportView {
  const r = obj(json);
  if (r === null) throw new ReportError("the report is not an object");
  const mint = str(r["mint"]);
  if (mint === null) throw new ReportError("the report has no mint");
  const token = obj(r["token"]);
  if (token === null) throw new ReportError("the report has no token");
  const supply = exact(token["supply"], "supply", 1);
  const decimals = token["decimals"];
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new ReportError(`decimals must be an integer from 0 to 36, got ${String(decimals)}`);
  const rows = r["topHolders"];
  if (!Array.isArray(rows)) throw new ReportError("topHolders is not a list");
  const holders = rows.map((raw, i): ReportHolder => {
    const h = obj(raw);
    const owner = h === null ? null : str(h["owner"]);
    if (h === null || owner === null) throw new ReportError(`topHolders[${i}] has no owner`);
    return { owner, amount: exact(h["amount"], `topHolders[${i}].amount`) };
  });
  const total = r["totalHolders"];
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new ReportError(`totalHolders must be a whole number, got ${String(total)}`);

  const marketRows = r["markets"] ?? [];
  if (!Array.isArray(marketRows)) throw new ReportError("markets is not a list");
  const markets = marketRows.map((raw, i): ReportMarket => {
    const m = obj(raw);
    const pubkey = m === null ? null : str(m["pubkey"]);
    if (m === null || pubkey === null) throw new ReportError(`markets[${i}] has no pubkey`);
    let vault: bigint | null = null;
    for (const side of ["liquidityAAccount", "liquidityBAccount"] as const) {
      const a = obj(m[side]);
      if (vault === null && a !== null && a["mint"] === mint && typeof a["amount"] === "number" && Number.isSafeInteger(a["amount"]) && a["amount"] >= 0) vault = BigInt(a["amount"]);
    }
    return { pubkey, type: str(m["marketType"]) ?? "", vault };
  });

  const nonHolders = new Set<string>();
  for (const [address, info] of Object.entries(obj(r["knownAccounts"]) ?? {})) {
    const type = obj(info)?.["type"];
    if (type === "AMM" || type === "LOCKER") nonHolders.add(address);
  }

  return {
    mint,
    supply,
    decimals,
    creator: str(r["creator"]),
    totalHolders: total,
    holders,
    markets,
    nonHolders,
    mintAuthorityActive: authority(r["mintAuthority"]),
    freezeAuthorityActive: authority(r["freezeAuthority"]),
  };
}

/**
 * How far the report's numbers can be trusted as a holder picture:
 *  exact         every token is accounted for and every holder is listed
 *  estimated     holders beyond the listed ones exist; what is left over is spread evenly over them
 *  unattributed  more than 0.1% of the supply is in no field and no unlisted holder exists to carry it (not given to anyone)
 *  inconsistent  the rows add up to more than the supply by more than 0.1%
 *  unmodelled    a market of a type, or without a vault, that these rules do not cover
 */
export type Quality = "exact" | "estimated" | "unattributed" | "inconsistent" | "unmodelled";

export interface Snapshot {
  quality: Quality;
  /** Every listed owner (rows of one owner added up), then the synthetic unlisted holders "tail:1", "tail:2", ... */
  holdings: Array<{ address: string; amount: bigint }>;
  /** Addresses that hold tokens but are not holders: markets, lockers, protocol wallets. Sorted. */
  excluded: string[];
  /** The creator, or null when its share cannot be named (never read as "holds nothing"). */
  creator: string | null;
  diagnostics: {
    /** Rows in the report's holder list. */
    listed: number;
    tailHolders: number;
    /** Supply minus the listed rows minus the markets' unlisted balances. */
    remainder: bigint;
    unlistedMarketAmount: bigint;
    countedHolders: number;
    countedTotal: bigint;
  };
}

export function snapshotFromReport(v: ReportView, protocolWallets: ReadonlySet<string> = new Set()): Snapshot {
  const excludedSet = new Set<string>([...v.markets.map((m) => m.pubkey), ...v.nonHolders, ...protocolWallets]);

  const byOwner = new Map<string, bigint>();
  for (const h of v.holders) byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0n) + h.amount);
  let listedTotal = 0n;
  for (const a of byOwner.values()) listedTotal += a;

  // A market that is not among the listed owners still holds tokens no row shows.
  let unlisted = 0n;
  let unmodelled = false;
  for (const m of v.markets) {
    if (byOwner.has(m.pubkey)) continue;
    if (m.vault === null || (m.type !== "pump_fun" && m.type !== "pump_fun_amm")) {
      unmodelled = true;
      continue;
    }
    unlisted += m.vault + (m.type === "pump_fun" ? PUMP_RESERVE_TOKENS * 10n ** BigInt(v.decimals) : 0n);
  }

  const remainder = v.supply - listedTotal - unlisted;
  const tailHolders = Math.max(0, v.totalHolders - v.holders.length);
  const tolerance = v.supply / 1000n;
  const quality: Quality = unmodelled ? "unmodelled" : remainder < -tolerance ? "inconsistent" : tailHolders > 0 ? "estimated" : remainder > tolerance ? "unattributed" : "exact";

  const tail: bigint[] = [];
  if (tailHolders > 0 && remainder > 0n) {
    const n = BigInt(tailHolders);
    const each = remainder / n;
    const extra = remainder % n;
    for (let i = 0; i < tailHolders; i++) tail.push(i === 0 ? each + extra : each);
  }

  const holdings = [...byOwner].map(([address, amount]) => ({ address, amount }));
  tail.forEach((amount, i) => holdings.push({ address: `tail:${i + 1}`, amount }));

  let countedHolders = tail.length;
  let countedTotal = tail.reduce((s, a) => s + a, 0n);
  for (const [owner, amount] of byOwner) {
    if (excludedSet.has(owner)) continue;
    countedHolders++;
    countedTotal += amount;
  }

  let creator: string | null = null;
  if (v.creator !== null && !excludedSet.has(v.creator) && countedTotal > 0n) {
    if (byOwner.has(v.creator)) creator = v.creator;
    // "exact" and "unattributed" both mean no unlisted holder exists (any tail makes the quality "estimated" at best), so every
    // holder is listed and a creator that is not among them holds nothing.
    else if (quality === "exact" || quality === "unattributed") creator = v.creator;
  }

  return {
    quality,
    holdings,
    excluded: [...excludedSet].sort(),
    creator,
    diagnostics: { listed: v.holders.length, tailHolders, remainder, unlistedMarketAmount: unlisted, countedHolders, countedTotal },
  };
}

/** The listed owner with the most tokens that is not a market, an AMM or a locker. Ties go to the smaller address. */
export function largestCountedOwner(v: ReportView): string | null {
  const skip = new Set<string>([...v.markets.map((m) => m.pubkey), ...v.nonHolders]);
  const byOwner = new Map<string, bigint>();
  for (const h of v.holders) if (!skip.has(h.owner)) byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0n) + h.amount);
  let best: [string, bigint] | null = null;
  for (const entry of byOwner) {
    if (best === null || entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0])) best = entry;
  }
  return best === null ? null : best[0];
}

/**
 * Owners that are the largest counted holder in at least `threshold` of ALL the reports given (not only of those that have
 * one). Outcome-blind: it reads holders and nothing else. On 13 Nov one such wallet held about half of every 2-billion-token
 * launch; left in, it would make every such token look like one whale.
 */
export function protocolWallets(views: readonly ReportView[], threshold = 0.25): Set<string> {
  const counts = new Map<string, number>();
  for (const v of views) {
    const o = largestCountedOwner(v);
    if (o !== null) counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  // Whole numbers throughout, so "exactly a quarter" is a quarter and not 0.2499999.
  const bar = Math.round(threshold * 1_000_000);
  const out = new Set<string>();
  for (const [owner, n] of counts) if (n * 1_000_000 >= bar * views.length) out.add(owner);
  return out;
}

export interface FixtureRow {
  view: ReportView;
  /** Unix ms: when the pool was created (GeckoTerminal). */
  createdAt: number;
  /** Unix ms: when the report was fetched. The scoring time S. */
  asOf: number;
}

export interface FixtureJson {
  format: "memelens-fixture";
  version: 1;
  chain: "solana";
  note: string;
  tokens: Array<{
    token: string;
    symbol: null;
    decimals: number;
    createdAt: number;
    creator: string | null;
    mintAuthorityActive: boolean | null;
    freezeAuthorityActive: boolean | null;
    excluded: string[];
  }>;
  trades: never[];
  snapshots: Array<{ token: string; time: number; holdings: Array<{ address: string; amount: string }> }>;
}

/** A `memelens-fixture` (the format `memelens ingest` reads), so the existing store and risk code run on it unchanged. */
export function buildFixture(rows: readonly FixtureRow[], protocolWalletSet: ReadonlySet<string>): FixtureJson {
  const tokens: FixtureJson["tokens"] = [];
  const snapshots: FixtureJson["snapshots"] = [];
  for (const row of rows) {
    const snap = snapshotFromReport(row.view, protocolWalletSet);
    tokens.push({
      token: row.view.mint,
      symbol: null,
      decimals: row.view.decimals,
      createdAt: row.createdAt,
      creator: snap.creator,
      mintAuthorityActive: row.view.mintAuthorityActive,
      freezeAuthorityActive: row.view.freezeAuthorityActive,
      excluded: snap.excluded,
    });
    snapshots.push({ token: row.view.mint, time: row.asOf, holdings: snap.holdings.map((h) => ({ address: h.address, amount: h.amount.toString() })) });
  }
  return {
    format: "memelens-fixture",
    version: 1,
    chain: "solana",
    note: "REAL pump.fun launches read by memelens-collector from RugCheck about one hour after each pool was created. Holders are the listed top holders added up by owner; unlisted holders (tail:N) share what the listed rows leave over; markets, lockers and protocol wallets are in `excluded`. No trades. Not a recommendation.",
    tokens,
    trades: [],
    snapshots,
  };
}

/** One stored first-hour report as the collector keeps it. */
export interface StoredReport {
  mint: string;
  /** Unix ms: when the pool was created. */
  createdAt: number;
  /** Unix ms: when the report was fetched (the scoring time S). */
  asOf: number;
  /** The HTTP status of the reply: 200, or 404 when RugCheck does not know the token. */
  status: number;
  body: string;
}

export interface ExportSummary {
  stored: number;
  /** Reports that were read and went into the fixture. */
  used: number;
  /** The source said it has nothing for the token (404). */
  noReport: number;
  /** Any other reply: not JSON, not a report, a report for another token, another status. */
  unreadable: number;
  /** Whether the protocol-wallet census was run (it needs at least `minCensus` readable reports). */
  censusUsed: boolean;
  protocolWallets: string[];
  byQuality: Record<Quality, number>;
}

/** The census is meaningless on a handful of reports: a quarter of 4 is a single token. */
export const DEFAULT_MIN_CENSUS = 100;

/**
 * Everything the collector stored at +60 minutes, as one fixture. Counts every row exactly once (used, no report,
 * unreadable) and keeps the reason for each unreadable one; it never drops a token without saying so.
 */
export function exportFromStored(rows: readonly StoredReport[], options: { minCensus?: number } = {}): { fixture: FixtureJson; summary: ExportSummary; unreadable: Array<{ mint: string; why: string }> } {
  const minCensus = options.minCensus ?? DEFAULT_MIN_CENSUS;
  const good: Array<{ row: StoredReport; view: ReportView }> = [];
  const unreadable: Array<{ mint: string; why: string }> = [];
  let noReport = 0;
  for (const row of rows) {
    if (row.status === 404) {
      noReport++;
      continue;
    }
    if (row.status !== 200) {
      unreadable.push({ mint: row.mint, why: `HTTP ${row.status}` });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(row.body);
    } catch {
      unreadable.push({ mint: row.mint, why: "the reply is not JSON" });
      continue;
    }
    try {
      const view = parseReport(json);
      if (view.mint !== row.mint) throw new ReportError(`the report is for another token (${view.mint})`);
      good.push({ row, view });
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      unreadable.push({ mint: row.mint, why: error.message });
    }
  }

  const censusUsed = good.length >= minCensus;
  const wallets = censusUsed ? protocolWallets(good.map((g) => g.view)) : new Set<string>();
  good.sort((a, b) => a.row.createdAt - b.row.createdAt || (a.row.mint < b.row.mint ? -1 : a.row.mint > b.row.mint ? 1 : 0));

  const byQuality: Record<Quality, number> = { exact: 0, estimated: 0, unattributed: 0, inconsistent: 0, unmodelled: 0 };
  for (const g of good) byQuality[snapshotFromReport(g.view, wallets).quality]++;

  return {
    fixture: buildFixture(good.map((g) => ({ view: g.view, createdAt: g.row.createdAt, asOf: g.row.asOf })), wallets),
    summary: { stored: rows.length, used: good.length, noReport, unreadable: unreadable.length, censusUsed, protocolWallets: [...wallets].sort(), byQuality },
    unreadable,
  };
}
