import { describe, expect, it } from "vitest";
import { parseBacktestSpec, SpecError } from "../src/spec";

function good(): Record<string, any> {
  return {
    version: 1,
    from: 0,
    to: 10_000_000,
    strategy: { kind: "follow-wallets", wallets: ["alice", "bob"], latencyMs: 500, positionQuote: "1000000", takeProfitBps: 5000, stopLossBps: 2000, maxHoldMs: 3_600_000 },
    costs: { feeBps: 100, slippageBps: 50 },
  };
}
function withChange(path: (string | number)[], value: unknown): unknown {
  const s = good();
  let node: any = s;
  for (const k of path.slice(0, -1)) node = node[k];
  node[path[path.length - 1]!] = value;
  return s;
}
function without(path: string[]): unknown {
  const s = good();
  let node: any = s;
  for (const k of path.slice(0, -1)) node = node[k];
  delete node[path[path.length - 1]!];
  return s;
}
function pathOf(input: unknown): string {
  try {
    parseBacktestSpec(input);
  } catch (e) {
    if (e instanceof SpecError) return e.path;
    throw e;
  }
  return "(accepted)";
}

describe("parseBacktestSpec: valid specs", () => {
  it("accepts a complete spec and returns an equal copy", () => {
    expect(parseBacktestSpec(good())).toEqual(good());
  });
  it("returns a copy, so later changes to the input do not change the result", () => {
    const input = good();
    const out = parseBacktestSpec(input);
    input["strategy"].wallets.push("mallory");
    input["costs"].feeBps = 999;
    expect(out.strategy.wallets).toEqual(["alice", "bob"]);
    expect(out.costs.feeBps).toBe(100);
  });
  it("accepts null for take profit and stop loss, and the edges of every range", () => {
    const s = good();
    Object.assign(s["strategy"], { takeProfitBps: null, stopLossBps: null, latencyMs: 0, maxHoldMs: 1 });
    Object.assign(s["costs"], { feeBps: 0, slippageBps: 0 });
    Object.assign(s, { from: 5, to: 5 });
    expect(() => parseBacktestSpec(s)).not.toThrow();
    Object.assign(s["strategy"], { takeProfitBps: 1_000_000, stopLossBps: 9999, latencyMs: 86_400_000, maxHoldMs: 2_592_000_000, positionQuote: "9".repeat(39) });
    Object.assign(s["costs"], { feeBps: 1000, slippageBps: 5000 });
    Object.assign(s, { from: 0, to: 5 * 366 * 86_400_000 });
    expect(() => parseBacktestSpec(s)).not.toThrow();
  });
  it("accepts 1 wallet and 100 wallets", () => {
    expect(() => parseBacktestSpec(withChange(["strategy", "wallets"], ["a"]))).not.toThrow();
    expect(() => parseBacktestSpec(withChange(["strategy", "wallets"], Array.from({ length: 100 }, (_, i) => `w${i}`)))).not.toThrow();
  });
});

describe("parseBacktestSpec: what it refuses, and where", () => {
  it("refuses anything that is not an object", () => {
    for (const v of [null, undefined, 5, "x", [], [good()]]) expect(pathOf(v), String(v)).toBe("$");
  });
  it("names the field that is missing", () => {
    const paths: [string[], string][] = [
      [["version"], "$.version"], [["from"], "$.from"], [["to"], "$.to"], [["strategy"], "$.strategy"], [["costs"], "$.costs"],
      [["strategy", "kind"], "$.strategy.kind"], [["strategy", "wallets"], "$.strategy.wallets"], [["strategy", "latencyMs"], "$.strategy.latencyMs"],
      [["strategy", "positionQuote"], "$.strategy.positionQuote"], [["strategy", "takeProfitBps"], "$.strategy.takeProfitBps"],
      [["strategy", "stopLossBps"], "$.strategy.stopLossBps"], [["strategy", "maxHoldMs"], "$.strategy.maxHoldMs"],
      [["costs", "feeBps"], "$.costs.feeBps"], [["costs", "slippageBps"], "$.costs.slippageBps"],
    ];
    for (const [p, expected] of paths) expect(pathOf(without(p)), expected).toBe(expected);
  });
  it("refuses a field it does not know, at every level", () => {
    expect(pathOf(withChange(["extra"], 1))).toBe("$.extra");
    expect(pathOf(withChange(["strategy", "extra"], 1))).toBe("$.strategy.extra");
    expect(pathOf(withChange(["costs", "extra"], 1))).toBe("$.costs.extra");
    expect(pathOf(JSON.parse('{"__proto__":{}, "version":1}'))).toBe("$.__proto__");
  });
  it("refuses a wrong version or kind", () => {
    for (const v of [0, 2, "1", null, 1.5]) expect(pathOf(withChange(["version"], v)), String(v)).toBe("$.version");
    expect(pathOf(withChange(["strategy", "kind"], "random"))).toBe("$.strategy.kind");
  });
  it("checks the window", () => {
    for (const v of [1.5, -1, Number.NaN, "5", null, 2 ** 53]) expect(pathOf(withChange(["from"], v)), `from ${String(v)}`).toBe("$.from");
    for (const v of [1.5, -1, "5", null]) expect(pathOf(withChange(["to"], v)), `to ${String(v)}`).toBe("$.to");
    expect(pathOf(withChange(["from"], 10_000_001))).toBe("$.to");
    expect(pathOf(withChange(["to"], 5 * 366 * 86_400_000 + 1))).toBe("$.to");
  });
  it("checks the wallet list", () => {
    const bad: unknown[] = [[], Array.from({ length: 101 }, (_, i) => `w${i}`), "alice", null];
    for (const v of bad) expect(pathOf(withChange(["strategy", "wallets"], v))).toBe("$.strategy.wallets");
    expect(pathOf(withChange(["strategy", "wallets"], ["a", "a"]))).toBe("$.strategy.wallets[1]");
    for (const w of ["", "a b", "é", "x".repeat(129), 5, null, "tab\t"]) expect(pathOf(withChange(["strategy", "wallets"], ["ok", w])), JSON.stringify(w)).toBe("$.strategy.wallets[1]");
  });
  it("checks latency and hold", () => {
    for (const v of [-1, 86_400_001, 1.5, "0", null]) expect(pathOf(withChange(["strategy", "latencyMs"], v)), String(v)).toBe("$.strategy.latencyMs");
    for (const v of [0, null, 2_592_000_001, -5, 1.5]) expect(pathOf(withChange(["strategy", "maxHoldMs"], v)), String(v)).toBe("$.strategy.maxHoldMs");
  });
  it("checks the position size: digits only, no leading zero, 1 to 39 digits, text not a number", () => {
    for (const v of ["0", "01", "-5", "1.5", "", " 5", "5 ", "1e3", "0x10", 5, null, "1".repeat(40)]) expect(pathOf(withChange(["strategy", "positionQuote"], v)), JSON.stringify(v)).toBe("$.strategy.positionQuote");
  });
  it("checks take profit and stop loss", () => {
    for (const v of [0, 1_000_001, 1.5, "5", undefined, -1]) expect(pathOf(withChange(["strategy", "takeProfitBps"], v)), String(v)).toBe("$.strategy.takeProfitBps");
    for (const v of [0, 10_000, -1, 1.5, "5", undefined]) expect(pathOf(withChange(["strategy", "stopLossBps"], v)), String(v)).toBe("$.strategy.stopLossBps");
  });
  it("checks the costs", () => {
    for (const v of [-1, 1001, 1.5, "1", null]) expect(pathOf(withChange(["costs", "feeBps"], v)), String(v)).toBe("$.costs.feeBps");
    for (const v of [-1, 5001, 1.5, "1", null]) expect(pathOf(withChange(["costs", "slippageBps"], v)), String(v)).toBe("$.costs.slippageBps");
  });
  it("is a SpecError with a readable message", () => {
    expect(() => parseBacktestSpec(withChange(["costs", "feeBps"], 5000))).toThrow(/\$\.costs\.feeBps: .*0 to 1000/);
  });
});

describe("parseBacktestSpec: more refusals", () => {
  it("says a missing member is missing (not only 'wrong')", () => {
    expect(() => parseBacktestSpec(without(["costs", "feeBps"]))).toThrow(/is missing/);
    expect(() => parseBacktestSpec(without(["strategy"]))).toThrow(/is missing/);
    expect(() => parseBacktestSpec(without(["strategy", "takeProfitBps"]))).toThrow(/is missing/);
  });
  it("refuses an object made by a class, and accepts one without a prototype", () => {
    class Looks {
      version = 1;
    }
    expect(pathOf(new Looks())).toBe("$");
    const bare = Object.assign(Object.create(null), good());
    expect(pathOf(bare)).toBe("(accepted)");
  });
  it("does not hand back the caller's own list of wallets", () => {
    const input = good();
    const out = parseBacktestSpec(input);
    expect(out.strategy.wallets).not.toBe(input["strategy"].wallets);
  });
});
