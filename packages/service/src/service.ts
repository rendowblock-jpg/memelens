import type { Concentration, Mark, PnlReport, RiskReport, SignalId, SmartMoneyReport } from "@memelens/core";
import { smartMoney, tokenConcentration, tokenRisk, walletPnl, type Store, type TokenInfo, type TradeEvent } from "@memelens/data";

// The views the desktop app shows. Every function takes the time it is "as of" and never reads the clock; the
// only default is the newest time present in the data. Nothing here writes to the store.

export class ServiceError extends Error {}

export interface ChainOverview {
  chain: string;
  latestTime: number | null;
  counts: { tokens: number; trades: number; snapshots: number; rejects: number };
}

export interface Overview {
  chains: ChainOverview[];
}

export interface FeedRow {
  token: string;
  symbol: string | null;
  /** Decimals of the token: needed to turn lastPrice (raw units) into a price per whole token. */
  decimals: number;
  createdAt: number;
  ageMs: number;
  /** Trades at or before asOf. */
  trades: number;
  /** Sum of the quote side of those trades, raw quote units. */
  volumeQuote: bigint;
  /** Price of the last non-zero-quote trade, or null. Thin-market price: indicative only. */
  lastPrice: Mark | null;
  /** From the newest holder snapshot at or before asOf; null if there is none or nobody is counted. */
  holders: number | null;
  top10Share: number | null;
  risk: { score: number; level: RiskReport["level"]; coverage: number; hardFlags: SignalId[] };
}

export interface Feed {
  chain: string;
  asOf: number;
  /** Newest token first (ties by address). */
  rows: FeedRow[];
}

export interface TopHolder {
  address: string;
  amount: bigint;
  /** Share (0..1) of the counted supply. */
  share: number;
}

export interface TokenDetail {
  chain: string;
  asOf: number;
  info: TokenInfo;
  trades: number;
  lastPrice: Mark | null;
  risk: {
    report: RiskReport;
    unavailable: Partial<Record<SignalId, string>>;
    snapshotTime: number | null;
  };
  concentration: { snapshotTime: number; snapshotAgeMs: number; value: Concentration; topHolders: TopHolder[] } | null;
  /** Newest first, at most 20. */
  recentTrades: TradeEvent[];
}

export interface WalletDetail {
  chain: string;
  asOf: number;
  wallet: string;
  trades: number;
  pnl: PnlReport;
}

export interface SmartRequest {
  from: number;
  to: number;
  minClosed?: number;
}

export interface SmartDetail {
  chain: string;
  from: number;
  to: number;
  report: SmartMoneyReport;
}

const TOP_HOLDERS = 10;
const RECENT_TRADES = 20;
const SCALE = 10n ** 12n;

function ratio(numerator: bigint, denominator: bigint): number {
  return Number((numerator * SCALE) / denominator) / Number(SCALE);
}

function checkTime(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ServiceError(`${name} must be a whole number of milliseconds, 0 or more`);
}

/** The newest time on the chain, or an error if the chain has no data at all. */
function chainLatest(store: Store, chain: string): number {
  const latest = store.latestTime(chain);
  if (latest === null) throw new ServiceError(`unknown chain "${chain}": the database has no data for it`);
  return latest;
}

function resolveAsOf(store: Store, chain: string, asOf: number | undefined): number {
  const latest = chainLatest(store, chain);
  if (asOf === undefined) return latest;
  checkTime("asOf", asOf);
  return asOf;
}

export function overview(store: Store): Overview {
  return {
    chains: store.chains().map((chain) => ({ chain, latestTime: store.latestTime(chain), counts: store.counts(chain) })),
  };
}

export function feed(store: Store, chain: string, asOf?: number): Feed {
  const at = resolveAsOf(store, chain, asOf);
  const rows: FeedRow[] = store.listTokens(chain, at).map((info) => {
    const trades = store.tradesForToken(chain, info.token, at);
    let volumeQuote = 0n;
    for (const t of trades) volumeQuote += t.quote;
    const risk = tokenRisk(store, chain, info.token, at)!;
    const conc = tokenConcentration(store, chain, info.token, at);
    const counted = conc !== null && conc.concentration.holders > 0;
    return {
      token: info.token,
      symbol: info.symbol,
      decimals: info.decimals,
      createdAt: info.createdAt,
      ageMs: at - info.createdAt,
      trades: trades.length,
      volumeQuote,
      lastPrice: store.lastMark(chain, info.token, at),
      holders: counted ? conc.concentration.holders : null,
      top10Share: counted ? (conc.concentration.topShare[10] ?? null) : null,
      risk: { score: risk.report.score, level: risk.report.level, coverage: risk.report.coverage, hardFlags: risk.report.hardFlags },
    };
  });
  rows.sort((a, b) => b.createdAt - a.createdAt || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  return { chain, asOf: at, rows };
}

export function tokenDetail(store: Store, chain: string, token: string, asOf?: number): TokenDetail | null {
  const at = resolveAsOf(store, chain, asOf);
  const info = store.getToken(chain, token);
  if (info === null || info.createdAt > at) return null;

  const trades = store.tradesForToken(chain, token, at);
  const risk = tokenRisk(store, chain, token, at)!;
  const conc = tokenConcentration(store, chain, token, at);

  let concentration: TokenDetail["concentration"] = null;
  if (conc !== null) {
    const snapshot = store.holderSnapshot(chain, token, at)!;
    const excluded = new Set(info.excluded);
    const merged = new Map<string, bigint>();
    for (const h of snapshot.holdings) {
      if (excluded.has(h.address)) continue;
      merged.set(h.address, (merged.get(h.address) ?? 0n) + h.amount);
    }
    const total = conc.concentration.total;
    const topHolders: TopHolder[] = [...merged]
      .filter(([, amount]) => amount > 0n)
      .sort(([ak, av], [bk, bv]) => (av < bv ? 1 : av > bv ? -1 : ak < bk ? -1 : ak > bk ? 1 : 0))
      .slice(0, TOP_HOLDERS)
      .map(([address, amount]) => ({ address, amount, share: ratio(amount, total) }));
    concentration = { snapshotTime: conc.snapshotTime, snapshotAgeMs: conc.snapshotAgeMs, value: conc.concentration, topHolders };
  }

  return {
    chain,
    asOf: at,
    info,
    trades: trades.length,
    lastPrice: store.lastMark(chain, token, at),
    risk: { report: risk.report, unavailable: risk.unavailable, snapshotTime: risk.snapshotTime },
    concentration,
    recentTrades: trades.slice(-RECENT_TRADES).reverse(),
  };
}

export function walletDetail(store: Store, chain: string, wallet: string, asOf?: number): WalletDetail {
  const at = resolveAsOf(store, chain, asOf);
  return {
    chain,
    asOf: at,
    wallet,
    trades: store.tradesForWallet(chain, wallet, at).length,
    pnl: walletPnl(store, chain, wallet, { asOf: at }),
  };
}

export function smartDetail(store: Store, chain: string, req: SmartRequest): SmartDetail {
  chainLatest(store, chain);
  checkTime("from", req.from);
  checkTime("to", req.to);
  if (req.from > req.to) throw new ServiceError("from must not be after to");
  if (req.minClosed !== undefined && (!Number.isSafeInteger(req.minClosed) || req.minClosed < 1)) {
    throw new ServiceError("minClosed must be a whole number of at least 1");
  }
  const report = smartMoney(store, chain, {
    from: req.from,
    to: req.to,
    ...(req.minClosed === undefined ? {} : { minClosedTokens: req.minClosed }),
  });
  return { chain, from: req.from, to: req.to, report };
}
