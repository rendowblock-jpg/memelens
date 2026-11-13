/** z for a two-sided 95% interval. */
const Z = 1.959963984540054;

/**
 * The Wilson score interval (95%) for k successes in n tries: better than the plain +-sqrt(p(1-p)/n) at small n and near 0 or 1,
 * where this study lives (30 per group). Null when there are no tries; refuses a count that is not a whole number from 0 to n.
 */
export function wilson(k: number, n: number): { rate: number; low: number; high: number } | null {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0 || k > n) throw new RangeError(`need whole numbers with 0 <= k <= n, got ${k} of ${n}`);
  if (n === 0) return null;
  const p = k / n;
  const z2 = Z * Z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  // At 0 of n the lower end is exactly 0 and at n of n the upper end is exactly 1; rounding must not say otherwise. Anywhere else
  // the interval is well inside 0..1.
  return { rate: p, low: k === 0 ? 0 : centre - half, high: k === n ? 1 : centre + half };
}
