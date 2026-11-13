import { describe, expect, it } from "vitest";
import { wilson } from "../src/wilson";

// The expected numbers were computed in Python from the formula with z = 1.959963984540054, a separate implementation.
describe("wilson (95% interval for a proportion)", () => {
  const cases: Array<[number, number, number, number]> = [
    [24, 30, 0.626943035868518, 0.904948928227101],
    [18, 30, 0.423203602533225, 0.754093718831982],
    [0, 30, 0, 0.113513393173969],
    [30, 30, 0.886486606826031, 1],
    [1, 1, 0.206549314377237, 1],
    [0, 1, 0, 0.793450685622763],
    [5, 60, 0.036120456601731, 0.180689420183344],
    [13, 17, 0.52738201880435, 0.904449556779199],
  ];
  for (const [k, n, low, high] of cases) {
    it(`${k} of ${n}`, () => {
      const w = wilson(k, n)!;
      expect(w.rate).toBeCloseTo(k / n, 14);
      expect(w.low).toBeCloseTo(low, 12);
      expect(w.high).toBeCloseTo(high, 12);
    });
  }

  it("never leaves 0..1, even where rounding would push it out", () => {
    for (let n = 1; n <= 40; n++) for (let k = 0; k <= n; k++) {
      const w = wilson(k, n)!;
      expect(w.low).toBeGreaterThanOrEqual(0);
      expect(w.high).toBeLessThanOrEqual(1);
      expect(w.low).toBeLessThanOrEqual(w.rate + 1e-12);
      expect(w.high).toBeGreaterThanOrEqual(w.rate - 1e-12);
    }
    expect(wilson(0, 10)!.low).toBe(0);
    expect(wilson(10, 10)!.high).toBe(1);
  });

  it("has no interval for nothing at all", () => {
    expect(wilson(0, 0)).toBeNull();
  });

  it("refuses a count that is not a whole number from 0 to n", () => {
    for (const [k, n] of [[-1, 5], [6, 5], [1.5, 5], [1, 5.5], [Number.NaN, 5], [1, -2]] as const) expect(() => wilson(k, n), `${k}/${n}`).toThrow(RangeError);
  });
});
