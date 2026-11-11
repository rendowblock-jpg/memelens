export type Side = "buy" | "sell";

export interface Trade {
  /** Unique within one call. Used for deterministic ordering of same-time trades. */
  id: string;
  /** Unix milliseconds. */
  time: number;
  token: string;
  side: Side;
  /** Raw token units moved. Must be > 0. */
  amount: bigint;
  /** Raw quote units (e.g. lamports) paid for a buy / received for a sell, before fee. Must be >= 0. */
  quote: bigint;
  /** Raw quote units. Added to the cost of a buy, deducted from the proceeds of a sell. Default 0. */
  fee?: bigint;
}

/** "`amount` raw token units are worth `quote` raw quote units." Used to value open positions. */
export interface Mark {
  amount: bigint;
  quote: bigint;
}

export interface PnlOptions {
  /** Ignore trades with time > asOf. Lets a backtest replay without seeing the future. */
  asOf?: number;
  /** Mark price per token, for unrealised PnL. */
  marks?: ReadonlyMap<string, Mark>;
}

export interface TokenPnl {
  token: string;
  boughtAmount: bigint;
  soldAmount: bigint;
  /** Total paid for all buys, fees included. */
  buyCost: bigint;
  /** Total received for all sells, fees deducted. */
  sellProceeds: bigint;
  /** Cost basis (FIFO) of the part of the sells that matched a known buy. */
  realisedCost: bigint;
  /** Proceeds of the part of the sells that matched a known buy. */
  realisedProceeds: bigint;
  /** realisedProceeds - realisedCost. */
  realised: bigint;
  /** Tokens still held, from known buys. */
  openAmount: bigint;
  /** FIFO cost basis of the tokens still held. */
  openCost: bigint;
  /** Tokens sold beyond what known buys covered (transfer in, or history before the data window). */
  unmatchedSoldAmount: bigint;
  /** Proceeds of that part. Excluded from `realised`: its cost basis is unknown. */
  unmatchedProceeds: bigint;
  /** Mark-to-market minus openCost. 0n if nothing is open. null if something is open but no mark was given. */
  unrealised: bigint | null;
}

export interface PnlTotals {
  realised: bigint;
  /** Sum over tokens that have a mark (or nothing open). Tokens without a mark are in `unmarkedTokens`. */
  unrealised: bigint;
  unmarkedTokens: string[];
  unmatchedProceeds: bigint;
}

export interface PnlReport {
  /** Sorted by token, for deterministic output. */
  tokens: TokenPnl[];
  totals: PnlTotals;
}

interface Lot {
  amount: bigint;
  cost: bigint;
}

interface Acc {
  boughtAmount: bigint;
  soldAmount: bigint;
  buyCost: bigint;
  sellProceeds: bigint;
  realisedCost: bigint;
  realisedProceeds: bigint;
  unmatchedSoldAmount: bigint;
  unmatchedProceeds: bigint;
  lots: Lot[];
  /** Index of the oldest lot that still has tokens. */
  head: number;
}

function requireBigint(value: unknown, name: string): bigint {
  if (typeof value !== "bigint") throw new TypeError(`${name} must be a bigint, got ${typeof value}`);
  return value;
}

function validateTrade(x: Trade): void {
  if (typeof x.id !== "string" || x.id === "") throw new RangeError("trade id must be a non-empty string");
  const where = `trade ${x.id}`;
  if (typeof x.token !== "string" || x.token === "") throw new RangeError(`${where}: token must be a non-empty string`);
  if (x.side !== "buy" && x.side !== "sell") throw new RangeError(`${where}: side must be "buy" or "sell"`);
  if (!Number.isInteger(x.time)) throw new RangeError(`${where}: time must be an integer (unix ms), got ${x.time}`);
  if (requireBigint(x.amount, `${where}: amount`) <= 0n) throw new RangeError(`${where}: amount must be > 0`);
  if (requireBigint(x.quote, `${where}: quote`) < 0n) throw new RangeError(`${where}: quote must be >= 0`);
  if (x.fee !== undefined && requireBigint(x.fee, `${where}: fee`) < 0n) {
    throw new RangeError(`${where}: fee must be >= 0`);
  }
}

function validateMark(token: string, m: Mark): void {
  if (requireBigint(m.amount, `mark ${token}: amount`) <= 0n) throw new RangeError(`mark ${token}: amount must be > 0`);
  if (requireBigint(m.quote, `mark ${token}: quote`) < 0n) throw new RangeError(`mark ${token}: quote must be >= 0`);
}

function compareTrades(a: Trade, b: Trade): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Per-address PnL with FIFO cost basis, per token and in total.
 *
 * All trades are for one wallet and share one quote asset (e.g. lamports).
 * Everything is exact bigint arithmetic. When a sell consumes part of a lot, the
 * matched cost is floor(lot.cost * taken / lot.amount) and the remainder stays in
 * the lot, so nothing is created or lost: buyCost == realisedCost + openCost.
 *
 * Ties in time are broken by trade id (ascending), so the result never depends
 * on input order. Time is never read from the clock; use `asOf` to cut history.
 */
export function computePnl(trades: readonly Trade[], options: PnlOptions = {}): PnlReport {
  const { asOf, marks } = options;
  if (asOf !== undefined && !Number.isFinite(asOf)) throw new RangeError(`asOf must be a finite number, got ${asOf}`);
  if (marks) for (const [token, m] of marks) validateMark(token, m);

  // Validate everything first, so bad data is rejected even when it is after asOf.
  const seen = new Set<string>();
  for (const x of trades) {
    validateTrade(x);
    if (seen.has(x.id)) throw new RangeError(`duplicate trade id ${x.id}`);
    seen.add(x.id);
  }

  const selected = trades.filter((x) => asOf === undefined || x.time <= asOf).sort(compareTrades);

  const accs = new Map<string, Acc>();
  for (const x of selected) {
    let a = accs.get(x.token);
    if (!a) {
      a = {
        boughtAmount: 0n,
        soldAmount: 0n,
        buyCost: 0n,
        sellProceeds: 0n,
        realisedCost: 0n,
        realisedProceeds: 0n,
        unmatchedSoldAmount: 0n,
        unmatchedProceeds: 0n,
        lots: [],
        head: 0,
      };
      accs.set(x.token, a);
    }
    const fee = x.fee ?? 0n;
    if (x.side === "buy") {
      const cost = x.quote + fee;
      a.boughtAmount += x.amount;
      a.buyCost += cost;
      a.lots.push({ amount: x.amount, cost });
      continue;
    }

    const net = x.quote - fee;
    a.soldAmount += x.amount;
    a.sellProceeds += net;
    let remaining = x.amount;
    let matched = 0n;
    let matchedCost = 0n;
    while (remaining > 0n && a.head < a.lots.length) {
      const lot = a.lots[a.head]!;
      const take = remaining < lot.amount ? remaining : lot.amount;
      let cost: bigint;
      if (take === lot.amount) {
        cost = lot.cost;
        a.head += 1;
      } else {
        cost = (lot.cost * take) / lot.amount;
        lot.amount -= take;
        lot.cost -= cost;
      }
      matchedCost += cost;
      matched += take;
      remaining -= take;
    }
    const matchedProceeds = matched === x.amount ? net : (net * matched) / x.amount;
    a.realisedCost += matchedCost;
    a.realisedProceeds += matchedProceeds;
    a.unmatchedSoldAmount += x.amount - matched;
    a.unmatchedProceeds += net - matchedProceeds;
  }

  const tokens: TokenPnl[] = [];
  const totals: PnlTotals = { realised: 0n, unrealised: 0n, unmarkedTokens: [], unmatchedProceeds: 0n };
  for (const token of [...accs.keys()].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0))) {
    const a = accs.get(token)!;
    let openAmount = 0n;
    let openCost = 0n;
    for (let i = a.head; i < a.lots.length; i++) {
      openAmount += a.lots[i]!.amount;
      openCost += a.lots[i]!.cost;
    }
    const realised = a.realisedProceeds - a.realisedCost;

    let unrealised: bigint | null;
    if (openAmount === 0n) {
      unrealised = 0n;
    } else {
      const m = marks?.get(token);
      if (m === undefined) {
        unrealised = null;
        totals.unmarkedTokens.push(token);
      } else {
        unrealised = (openAmount * m.quote) / m.amount - openCost;
      }
    }

    tokens.push({
      token,
      boughtAmount: a.boughtAmount,
      soldAmount: a.soldAmount,
      buyCost: a.buyCost,
      sellProceeds: a.sellProceeds,
      realisedCost: a.realisedCost,
      realisedProceeds: a.realisedProceeds,
      realised,
      openAmount,
      openCost,
      unmatchedSoldAmount: a.unmatchedSoldAmount,
      unmatchedProceeds: a.unmatchedProceeds,
      unrealised,
    });
    totals.realised += realised;
    totals.unmatchedProceeds += a.unmatchedProceeds;
    if (unrealised !== null) totals.unrealised += unrealised;
  }
  return { tokens, totals };
}
