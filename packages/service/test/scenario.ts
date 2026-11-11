import { ingest, ReplayAdapter, Store, type HolderSnapshot, type ReplayData, type TokenInfo, type TradeEvent } from "@memelens/data";

export const C = "solana";

export function tok(token: string, over: Partial<TokenInfo> = {}): TokenInfo {
  return {
    token,
    symbol: token.toLowerCase(),
    decimals: 6,
    createdAt: 1000,
    creator: null,
    mintAuthorityActive: null,
    freezeAuthorityActive: null,
    excluded: [],
    ...over,
  };
}

export function trade(id: string, over: Partial<TradeEvent> = {}): TradeEvent {
  return { id, time: 2000, wallet: "w1", token: "A", side: "buy", amount: 100n, quote: 10n, fee: 0n, ...over };
}

export function snap(token: string, time: number, holdings: Array<[string, bigint]>): HolderSnapshot {
  return { token, time, holdings: holdings.map(([address, amount]) => ({ address, amount })) };
}

/**
 * Hand-checkable scenario.
 *  A  created 1000, mint authority active. Snapshot @3000: CRE 300, w1 60, w9 40, h1..h9 10 each, POOL 600 (excluded)
 *     -> 12 counted holders, total 490, top-10 hold 470.   Snapshot @6000: CRE 100, w1 65, w2 135, POOL 700, zero 0 (a holder with nothing left).
 *  B  created 2000, no snapshot.
 *  C  created 3000, no snapshot.
 */
export function scenario(): ReplayData {
  const h = (n: number): [string, bigint] => [`h${n}`, 10n];
  return {
    chain: C,
    tokens: [
      tok("A", { createdAt: 1000, creator: "CRE", mintAuthorityActive: true, freezeAuthorityActive: false, excluded: ["POOL"] }),
      tok("B", { createdAt: 2000 }),
      tok("C", { createdAt: 3000 }),
    ],
    trades: [
      trade("t1", { time: 2000, wallet: "w1", token: "A", side: "buy", amount: 100n, quote: 1000n }),
      trade("t2", { time: 3000, wallet: "w1", token: "A", side: "sell", amount: 40n, quote: 600n }),
      trade("t3", { time: 4000, wallet: "w2", token: "A", side: "buy", amount: 10n, quote: 200n }),
      trade("t4", { time: 5000, wallet: "w1", token: "A", side: "buy", amount: 5n, quote: 0n }),
      trade("t5", { time: 2500, wallet: "w1", token: "B", side: "buy", amount: 50n, quote: 500n }),
      trade("t6", { time: 3500, wallet: "w3", token: "C", side: "buy", amount: 9n, quote: 0n }),
    ],
    snapshots: [
      snap("A", 3000, [["CRE", 300n], ["w1", 60n], ["POOL", 600n], ["w9", 40n], h(1), h(2), h(3), h(4), h(5), h(6), h(7), h(8), h(9)]),
      snap("A", 6000, [["CRE", 100n], ["w1", 65n], ["POOL", 700n], ["w2", 135n], ["zero", 0n]]),
    ],
  };
}

const opened: Store[] = [];

export async function load(data: ReplayData): Promise<Store> {
  const s = Store.open(":memory:");
  opened.push(s);
  await ingest(s, new ReplayAdapter(data), { now: 1 });
  return s;
}

export function closeAll(): void {
  while (opened.length) opened.pop()!.close();
}

/** The same data with everything after `t` removed, as if the world had stopped at `t`. */
export function truncate(data: ReplayData, t: number): ReplayData {
  const tokens = data.tokens.filter((x) => x.createdAt <= t);
  const known = new Set(tokens.map((x) => x.token));
  return {
    chain: data.chain,
    tokens,
    trades: data.trades.filter((x) => x.time <= t && known.has(x.token)),
    snapshots: data.snapshots.filter((x) => x.time <= t && known.has(x.token)),
  };
}
