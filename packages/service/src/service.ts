import type { Concentration, Mark, PnlReport, RiskReport, SignalId, SmartMoneyReport } from "@memelens/core";
import type { Store, TokenInfo, TradeEvent } from "@memelens/data";

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

export function overview(_store: Store): Overview {
  throw new Error("not implemented");
}
export function feed(_store: Store, _chain: string, _asOf?: number): Feed {
  throw new Error("not implemented");
}
export function tokenDetail(_store: Store, _chain: string, _token: string, _asOf?: number): TokenDetail | null {
  throw new Error("not implemented");
}
export function walletDetail(_store: Store, _chain: string, _wallet: string, _asOf?: number): WalletDetail {
  throw new Error("not implemented");
}
export function smartDetail(_store: Store, _chain: string, _req: SmartRequest): SmartDetail {
  throw new Error("not implemented");
}
