import { describe, expect, it } from "vitest";
import { analyzeConcentration, type Holding } from "../src/concentration";

const h = (address: string, amount: bigint): Holding => ({ address, amount });

describe("analyzeConcentration", () => {
  it("returns zeros for no holders", () => {
    const r = analyzeConcentration([]);
    expect(r.holders).toBe(0);
    expect(r.total).toBe(0n);
    expect(r.hhi).toBe(0);
    expect(r.gini).toBe(0);
    expect(r.topShare).toEqual({ 1: 0, 5: 0, 10: 0, 20: 0 });
  });

  it("one holder owns everything", () => {
    const r = analyzeConcentration([h("a", 1000n)]);
    expect(r.holders).toBe(1);
    expect(r.topShare[1]).toBe(1);
    expect(r.hhi).toBe(1);
    expect(r.gini).toBe(0); // a single holder has no inequality to measure
  });

  it("four equal holders", () => {
    const r = analyzeConcentration([h("a", 5n), h("b", 5n), h("c", 5n), h("d", 5n)]);
    expect(r.holders).toBe(4);
    expect(r.topShare[1]).toBeCloseTo(0.25, 9);
    expect(r.topShare[5]).toBe(1); // N larger than holder count covers everyone
    expect(r.hhi).toBeCloseTo(0.25, 9);
    expect(r.gini).toBeCloseTo(0, 9);
  });

  it("excludes liquidity pool / burn addresses from the holder set", () => {
    const r = analyzeConcentration(
      [h("pool", 500n), h("a", 300n), h("b", 100n), h("c", 100n)],
      { exclude: new Set(["pool"]) },
    );
    expect(r.holders).toBe(3);
    expect(r.total).toBe(500n);
    expect(r.topShare[1]).toBeCloseTo(0.6, 9);
    expect(r.hhi).toBeCloseTo(0.6 * 0.6 + 0.2 * 0.2 + 0.2 * 0.2, 9);
  });

  it("merges duplicate addresses and ignores zero balances", () => {
    const r = analyzeConcentration([h("a", 10n), h("a", 30n), h("b", 60n), h("z", 0n)]);
    expect(r.holders).toBe(2);
    expect(r.total).toBe(100n);
    expect(r.topShare[1]).toBeCloseTo(0.6, 9);
  });

  it("computes the Gini coefficient of [1,2,3,4] as 0.25", () => {
    const r = analyzeConcentration([h("a", 1n), h("b", 2n), h("c", 3n), h("d", 4n)]);
    expect(r.gini).toBeCloseTo(0.25, 9);
  });

  it("honours a custom topN list", () => {
    const r = analyzeConcentration(
      [h("a", 50n), h("b", 30n), h("c", 20n)],
      { topN: [2] },
    );
    expect(Object.keys(r.topShare)).toEqual(["2"]);
    expect(r.topShare[2]).toBeCloseTo(0.8, 9);
  });

  it("stays exact for balances beyond 2^53", () => {
    const big = 10n ** 24n;
    const r = analyzeConcentration([h("a", 3n * big), h("b", big)]);
    expect(r.total).toBe(4n * big);
    expect(r.topShare[1]).toBeCloseTo(0.75, 9);
  });

  it("rejects negative balances", () => {
    expect(() => analyzeConcentration([h("a", -1n)])).toThrow(RangeError);
  });

  it("does not mutate its input", () => {
    const input = [h("a", 1n), h("b", 2n)];
    const snapshot = JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    analyzeConcentration(input);
    expect(JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(snapshot);
  });
});
