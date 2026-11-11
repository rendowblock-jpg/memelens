// What the quote side of a trade is worth, per chain. The data stores quote amounts as raw integers (on Solana,
// lamports); only the display needs to know the unit. An unknown chain shows raw units, never a guessed currency.

export interface Quote {
  symbol: string;
  decimals: number;
}

export const RAW_QUOTE: Quote = { symbol: "raw units", decimals: 0 };

const QUOTES: Record<string, Quote> = {
  solana: { symbol: "SOL", decimals: 9 },
  synthetic: { symbol: "SOL", decimals: 9 },
};

export function quoteFor(chain: string): Quote {
  return Object.hasOwn(QUOTES, chain) ? QUOTES[chain]! : RAW_QUOTE;
}
