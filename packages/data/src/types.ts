import type { Holding, Side } from "@memelens/core";

/** Static facts about a token. `null` means "not known", never "no". */
export interface TokenInfo {
  /** Mint / contract address. Unique within a chain. */
  token: string;
  symbol: string | null;
  decimals: number;
  /** Unix ms. */
  createdAt: number;
  creator: string | null;
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  /** Addresses that are not real holders: liquidity pools, burn address, bonding curve, program accounts. */
  excluded: string[];
}

/** One swap by one wallet. Immutable once it happened on chain. */
export interface TradeEvent {
  /** Unique within a chain (on Solana: signature + instruction index). */
  id: string;
  /** Unix ms. */
  time: number;
  wallet: string;
  token: string;
  side: Side;
  /** Raw token units. Must be > 0. */
  amount: bigint;
  /** Raw quote units (lamports) paid / received, before fee. Must be >= 0. */
  quote: bigint;
  /** Raw quote units. Must be >= 0. */
  fee: bigint;
}

/** Everyone's balance of one token at one moment. */
export interface HolderSnapshot {
  token: string;
  /** Unix ms. */
  time: number;
  holdings: Holding[];
}

export interface TradeRange {
  token?: string;
  wallet?: string;
  /** Inclusive, unix ms. */
  from?: number;
  /** Inclusive, unix ms. */
  to?: number;
}

/**
 * Where chain data comes from. Implementations: ReplayAdapter (recorded data, used by tests and
 * backtests) now; a Solana RPC / indexer adapter in M4.
 */
export interface ChainAdapter {
  /** Chain id, e.g. "solana". Used to key every stored row. */
  readonly chain: string;
  listTokens(): Promise<TokenInfo[]>;
  /** Oldest first; ties broken by id. */
  listTrades(range?: TradeRange): Promise<TradeEvent[]>;
  /** The newest snapshot taken at or before `asOf`, or null if there is none. */
  holderSnapshot(token: string, asOf: number): Promise<HolderSnapshot | null>;
  /** Every snapshot of a token, oldest first. Used by ingest. */
  listSnapshots(token?: string): Promise<HolderSnapshot[]>;
}
