import {
  analyzeConcentration,
  computePnl,
  rankSmartMoney,
  scoreRisk,
  type Concentration,
  type Mark,
  type PnlReport,
  type RiskInput,
  type RiskReport,
  type SignalId,
  type SmartMoneyOptions,
  type SmartMoneyReport,
} from "@memelens/core";
import type { Store } from "./store";

// This layer is glue: it reads stored facts as of a given time and hands them to the pure functions in
// @memelens/core. Time is always an argument ("as of"); nothing here reads the clock.

export interface ConcentrationResult {
  token: string;
  asOf: number;
  /** Time of the holder snapshot that was used. */
  snapshotTime: number;
  /** asOf minus snapshotTime. Large means the numbers may be stale. */
  snapshotAgeMs: number;
  concentration: Concentration;
}

export interface RiskResult {
  token: string;
  asOf: number;
  /** The inputs that were available. Anything missing is simply absent (unknown, not safe). */
  input: RiskInput;
  report: RiskReport;
  /** Why each unknown signal is unknown. */
  unavailable: Partial<Record<SignalId, string>>;
  /** Time of the holder snapshot that was used, or null if there was none. */
  snapshotTime: number | null;
}

/**
 * Per-address PnL from stored trades. Open positions are marked at the last non-zero-quote trade of
 * that token at or before `asOf` (a thin-market price: treat unrealised PnL as indicative only).
 */
export function walletPnl(store: Store, chain: string, wallet: string, options: { asOf?: number } = {}): PnlReport {
  const { asOf } = options;
  const trades = store.tradesForWallet(chain, wallet, asOf);
  const marks = new Map<string, Mark>();
  for (const token of new Set(trades.map((t) => t.token))) {
    const mark = store.lastMark(chain, token, asOf);
    if (mark !== null) marks.set(token, mark);
  }
  return computePnl(trades, { ...(asOf === undefined ? {} : { asOf }), marks });
}

/** Holder concentration from the newest snapshot at or before `asOf`. Null if there is none or the token is unknown / not yet created. */
export function tokenConcentration(store: Store, chain: string, token: string, asOf: number): ConcentrationResult | null {
  const info = store.getToken(chain, token);
  if (info === null || info.createdAt > asOf) return null;
  const snapshot = store.holderSnapshot(chain, token, asOf);
  if (snapshot === null) return null;
  const concentration = analyzeConcentration(snapshot.holdings, { exclude: new Set(info.excluded) });
  return { token, asOf, snapshotTime: snapshot.time, snapshotAgeMs: asOf - snapshot.time, concentration };
}

const SCALE = 10n ** 12n;

const NO_SNAPSHOT = "no holder snapshot at or before the as-of time";
const NO_HOLDERS = "the holder snapshot has no countable holders";

/**
 * Risk score from what is stored. Only six of the ten signals have a data source so far (age, top-10 share,
 * HHI, creator share, mint authority, freeze authority); the other four (creator dumps, liquidity, clustering,
 * wash trading) are reported as unavailable with a reason, so the score's `coverage` says how much is known.
 */
export function tokenRisk(store: Store, chain: string, token: string, asOf: number): RiskResult | null {
  const info = store.getToken(chain, token);
  if (info === null || info.createdAt > asOf) return null;

  const input: RiskInput = { ageMs: asOf - info.createdAt };
  const unavailable: Partial<Record<SignalId, string>> = {
    creatorDumps: "no data source for the creator's history yet",
    liquidity: "no liquidity data yet",
    clustering: "no wallet-funding data yet",
    washTrading: "no wash-trade detector yet",
  };

  const snapshot = store.holderSnapshot(chain, token, asOf);
  const excluded = new Set(info.excluded);
  const concentration = snapshot === null ? null : analyzeConcentration(snapshot.holdings, { exclude: excluded });

  if (snapshot === null) {
    unavailable.top10Share = NO_SNAPSHOT;
    unavailable.hhi = NO_SNAPSHOT;
    unavailable.creatorShare = NO_SNAPSHOT;
  } else if (concentration === null || concentration.holders === 0) {
    // Core reports 0 for every share when nobody is counted; that would read as "not concentrated".
    unavailable.top10Share = NO_HOLDERS;
    unavailable.hhi = NO_HOLDERS;
    unavailable.creatorShare = NO_HOLDERS;
  } else {
    input.concentration = concentration;
    if (info.creator === null) {
      unavailable.creatorShare = "the token's creator is not known";
    } else if (excluded.has(info.creator)) {
      unavailable.creatorShare = "the creator address is on the token's non-holder list";
    } else {
      const held = snapshot.holdings.find((h) => h.address === info.creator)?.amount ?? 0n;
      input.creatorShare = Number((held * SCALE) / concentration.total) / Number(SCALE);
    }
  }

  if (info.mintAuthorityActive === null) unavailable.mintAuthority = "mint authority status is not known";
  else input.mintAuthorityActive = info.mintAuthorityActive;

  if (info.freezeAuthorityActive === null) unavailable.freezeAuthority = "freeze authority status is not known";
  else input.freezeAuthorityActive = info.freezeAuthorityActive;

  return { token, asOf, input, report: scoreRisk(input), unavailable, snapshotTime: snapshot === null ? null : snapshot.time };
}

/** Ranks every wallet that traded up to `options.to`. Trades after `to` are never read. */
export function smartMoney(store: Store, chain: string, options: SmartMoneyOptions): SmartMoneyReport {
  const wallets = store.walletsWithTrades(chain, options.to).map((address) => ({
    address,
    trades: store.tradesForWallet(chain, address, options.to),
  }));
  return rankSmartMoney(wallets, options);
}
