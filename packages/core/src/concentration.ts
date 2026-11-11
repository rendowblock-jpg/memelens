export interface Holding {
  address: string;
  /** Raw token units (no decimals applied). */
  amount: bigint;
}

export interface ConcentrationOptions {
  /** Addresses that are not real holders: LP pools, burn address, bonding curve, program accounts. */
  exclude?: ReadonlySet<string>;
  /** Which top-N shares to report. Default [1, 5, 10, 20]. */
  topN?: readonly number[];
}

export interface Concentration {
  /** Number of distinct non-zero, non-excluded holders. */
  holders: number;
  /** Sum of the counted balances, in raw units. */
  total: bigint;
  /** Share of the counted supply held by the top N holders, keyed by N. 0..1. */
  topShare: Record<number, number>;
  /** Herfindahl-Hirschman index of the shares. 1/holders (even) .. 1 (one holder). */
  hhi: number;
  /** Gini coefficient of the balances. 0 (even) .. 1 (one holder has it all). */
  gini: number;
}

const DEFAULT_TOP_N: readonly number[] = [1, 5, 10, 20];

// Ratios are computed on bigints and only converted to a float at the end,
// so balances far beyond 2^53 keep full precision. Resolution: 1e-12.
const SCALE = 10n ** 12n;

function ratio(numerator: bigint, denominator: bigint): number {
  return Number((numerator * SCALE) / denominator) / Number(SCALE);
}

export function analyzeConcentration(
  holdings: readonly Holding[],
  options: ConcentrationOptions = {},
): Concentration {
  const exclude = options.exclude ?? new Set<string>();
  const topN = options.topN ?? DEFAULT_TOP_N;

  for (const n of topN) {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`topN entries must be positive integers, got ${n}`);
    }
  }

  // Validate everything first, so bad data is rejected even on excluded addresses.
  for (const holding of holdings) {
    if (holding.amount < 0n) {
      throw new RangeError(`negative balance for ${holding.address}`);
    }
  }

  const merged = new Map<string, bigint>();
  for (const { address, amount } of holdings) {
    if (exclude.has(address)) continue;
    merged.set(address, (merged.get(address) ?? 0n) + amount);
  }

  const descending = [...merged.values()]
    .filter((amount) => amount > 0n)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  const holders = descending.length;
  const total = descending.reduce((sum, amount) => sum + amount, 0n);

  const topShare: Record<number, number> = {};
  if (holders === 0) {
    for (const n of topN) topShare[n] = 0;
    return { holders: 0, total: 0n, topShare, hhi: 0, gini: 0 };
  }

  for (const n of topN) {
    const sum = descending.slice(0, n).reduce((s, amount) => s + amount, 0n);
    topShare[n] = ratio(sum, total);
  }

  // HHI = sum(share^2) = sum(amount^2) / total^2, exact on bigints.
  const sumSquares = descending.reduce((s, amount) => s + amount * amount, 0n);
  const hhi = ratio(sumSquares, total * total);

  // Gini = sum((2i - n - 1) * x_i) / (n * total), x sorted ascending, i = 1..n.
  const n = BigInt(holders);
  let weighted = 0n;
  [...descending].reverse().forEach((amount, index) => {
    const i = BigInt(index + 1);
    weighted += (2n * i - n - 1n) * amount;
  });
  const gini = ratio(weighted, n * total);

  return { holders, total, topShare, hhi, gini };
}
