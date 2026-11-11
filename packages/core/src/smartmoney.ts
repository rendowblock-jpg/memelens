import { computePnl, type Trade } from "./pnl";

export interface WalletTrades {
  address: string;
  /** All of this wallet's trades, including ones before the window (they set the cost basis). */
  trades: readonly Trade[];
}

export interface SmartMoneyOptions {
  /** Window start, unix ms, inclusive. */
  from: number;
  /** Window end, unix ms, inclusive. Trades after this are never looked at. */
  to: number;
  /** A wallet needs at least this many tokens closed in the window to be ranked. Default 5. */
  minClosedTokens?: number;
}

export interface WalletScore {
  address: string;
  /** Realised PnL made inside the window, in raw quote units. */
  realised: bigint;
  /** FIFO cost basis of what was sold inside the window. */
  realisedCost: bigint;
  /** Tokens with a sell inside the window that matched a known buy. */
  closedTokens: number;
  /** Of those, how many made a profit (> 0). */
  wins: number;
  /** wins / closedTokens, or null if nothing closed. */
  hitRate: number | null;
  /** 95% Wilson lower bound of the hit rate: what the sample size supports. null if nothing closed. */
  hitRateLow: number | null;
  /** realised / realisedCost, or null if the cost was 0. */
  roi: number | null;
  /** Proceeds inside the window from sells with no known buy. Not part of `realised`. */
  unmatchedProceeds: bigint;
  /** Number of trades inside the window. */
  trades: number;
}

export interface RankedWallet extends WalletScore {
  /** 1 = best. */
  rank: number;
}

export type UnrankedReason = "too-few-closed-tokens" | "not-profitable";

export interface UnrankedWallet extends WalletScore {
  reason: UnrankedReason;
}

export interface SmartMoneyReport {
  ranked: RankedWallet[];
  /** Sorted by address. Nothing is dropped silently. */
  unranked: UnrankedWallet[];
}

const Z_95 = 1.96;
const RATIO_SCALE = 10n ** 12n;

/**
 * 95% lower confidence bound of a win rate (Wilson score interval).
 * 3 wins of 3 is only ~0.44; 30 of 30 is ~0.89. Returns null when n is 0.
 */
export function wilsonLowerBound(wins: number, n: number): number | null {
  if (!Number.isInteger(wins) || !Number.isInteger(n) || wins < 0 || n < 0 || wins > n) {
    throw new RangeError(`need integers with 0 <= wins <= n, got wins=${wins} n=${n}`);
  }
  if (n === 0) return null;
  const p = wins / n;
  const z2 = Z_95 * Z_95;
  const low = (p + z2 / (2 * n) - Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
  return Math.min(1, Math.max(0, low));
}

function validateWindow(from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new RangeError(`window bounds must be integers (unix ms), got from=${from} to=${to}`);
  }
  if (from > to) throw new RangeError(`window start ${from} is after its end ${to}`);
}

function signedRatio(numerator: bigint, denominator: bigint): number {
  return Number((numerator * RATIO_SCALE) / denominator) / Number(RATIO_SCALE);
}

/**
 * Score one wallet over [from, to] (both inclusive).
 *
 * "Realised in the window" is the cumulative realised PnL at `to` minus the
 * cumulative realised PnL just before `from`. Buys before the window still set
 * the FIFO cost basis, and trades after `to` are never looked at.
 */
export function scoreWallet(wallet: WalletTrades, window: Pick<SmartMoneyOptions, "from" | "to">): WalletScore {
  if (typeof wallet.address !== "string" || wallet.address === "") {
    throw new RangeError("wallet address must be a non-empty string");
  }
  validateWindow(window.from, window.to);

  const end = computePnl(wallet.trades, { asOf: window.to });
  const start = computePnl(wallet.trades, { asOf: window.from - 1 });
  const before = new Map(start.tokens.map((x) => [x.token, x]));

  let realised = 0n;
  let realisedCost = 0n;
  let unmatchedProceeds = 0n;
  let closedTokens = 0;
  let wins = 0;
  for (const e of end.tokens) {
    const b = before.get(e.token);
    const dRealised = e.realised - (b?.realised ?? 0n);
    const dCost = e.realisedCost - (b?.realisedCost ?? 0n);
    const dMatched = e.soldAmount - e.unmatchedSoldAmount - ((b?.soldAmount ?? 0n) - (b?.unmatchedSoldAmount ?? 0n));
    realised += dRealised;
    realisedCost += dCost;
    unmatchedProceeds += e.unmatchedProceeds - (b?.unmatchedProceeds ?? 0n);
    if (dMatched > 0n) {
      closedTokens += 1;
      if (dRealised > 0n) wins += 1;
    }
  }

  const trades = wallet.trades.filter((x) => x.time >= window.from && x.time <= window.to).length;
  return {
    address: wallet.address,
    realised,
    realisedCost,
    closedTokens,
    wins,
    hitRate: closedTokens === 0 ? null : wins / closedTokens,
    hitRateLow: wilsonLowerBound(wins, closedTokens),
    roi: realisedCost === 0n ? null : signedRatio(realised, realisedCost),
    unmatchedProceeds,
    trades,
  };
}

function byAddress(a: { address: string }, b: { address: string }): number {
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

/**
 * Rank wallets by PnL realised in the window.
 *
 * A wallet is ranked only if it closed at least `minClosedTokens` tokens and is
 * profitable. Order: realised PnL, then hit rate, then address (so ties are
 * deterministic). Everyone else is returned in `unranked` with the reason.
 */
export function rankSmartMoney(wallets: readonly WalletTrades[], options: SmartMoneyOptions): SmartMoneyReport {
  validateWindow(options.from, options.to);
  const minClosed = options.minClosedTokens ?? 5;
  if (!Number.isInteger(minClosed) || minClosed < 1) {
    throw new RangeError(`minClosedTokens must be an integer >= 1, got ${minClosed}`);
  }

  const seen = new Set<string>();
  const qualified: WalletScore[] = [];
  const unranked: UnrankedWallet[] = [];
  for (const w of wallets) {
    if (seen.has(w.address)) throw new RangeError(`duplicate wallet address ${w.address}`);
    seen.add(w.address);
    const score = scoreWallet(w, options);
    if (score.closedTokens < minClosed) unranked.push({ ...score, reason: "too-few-closed-tokens" });
    else if (score.realised <= 0n) unranked.push({ ...score, reason: "not-profitable" });
    else qualified.push(score);
  }

  qualified.sort((a, b) => {
    if (a.realised !== b.realised) return a.realised > b.realised ? -1 : 1;
    const ha = a.hitRate ?? 0;
    const hb = b.hitRate ?? 0;
    if (ha !== hb) return hb - ha;
    return byAddress(a, b);
  });

  return {
    ranked: qualified.map((w, i) => ({ ...w, rank: i + 1 })),
    unranked: unranked.sort(byAddress),
  };
}
