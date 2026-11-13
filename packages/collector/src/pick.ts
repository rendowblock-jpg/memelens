import type { LabelRow } from "./load";
import { pickKey } from "./sampling";

/**
 * The tokens of one outcome group that go to the scoring, chosen without any look at a score: the group ordered by
 * sha256("memelens-calibration-v1:pick:" + mint), ascending, and the first `size` taken. A group with fewer gives all it has.
 */
export function pickGroup(rows: readonly LabelRow[], label: "rugged" | "survived", size: number): string[] {
  if (!Number.isInteger(size) || size < 0) throw new RangeError(`the group size must be a whole number of 0 or more, got ${size}`);
  const keyed = rows.filter((r) => r.label === label).map((r) => ({ mint: r.mint, key: pickKey(r.mint) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.slice(0, size).map((k) => k.mint);
}
