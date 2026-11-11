import type { HolderSnapshot, TokenInfo, TradeEvent } from "../src/types";

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
  return { id, time: 2000, wallet: "W1", token: "A", side: "buy", amount: 100n, quote: 10n, fee: 0n, ...over };
}

export function snap(token: string, time: number, holdings: Array<[string, bigint]>): HolderSnapshot {
  return { token, time, holdings: holdings.map(([address, amount]) => ({ address, amount })) };
}
