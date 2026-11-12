import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computePnl, type Mark, type Trade } from "@memelens/core";
import { canonicalJson, sha256Hex, specHash } from "../src/canonical";
import { parseBacktestReport } from "../src/report";
import { parseBacktestSpec, SpecError } from "../src/spec";

// The vectors are written by scripts/sidecar-vectors/gen.py, an implementation that shares no code with this one.
// The TypeScript core is the reference for FIFO PnL: it must agree with them, and so must the Go engine.
function load(name: string): any {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../vectors/${name}.json`, import.meta.url)), "utf8"));
}

const DIGITS = /^(0|[1-9][0-9]*)$/;
function big(name: string, s: unknown): bigint {
  if (typeof s !== "string" || !DIGITS.test(s)) throw new RangeError(`${name} must be a whole number written in digits`);
  return BigInt(s);
}
function toCore(params: any): { trades: Trade[]; asOf: number | undefined; marks: Map<string, Mark> | undefined } {
  const trades: Trade[] = params.trades.map((t: any) => ({
    id: t.id, time: t.time, token: t.token, side: t.side, amount: big("amount", t.amount), quote: big("quote", t.quote),
    ...(t.fee === undefined ? {} : { fee: big("fee", t.fee) }),
  }));
  let marks: Map<string, Mark> | undefined;
  if (params.marks) {
    marks = new Map();
    for (const m of params.marks) {
      if (marks.has(m.token)) throw new RangeError(`two marks for ${m.token}`);
      marks.set(m.token, { amount: big("mark amount", m.amount), quote: big("mark quote", m.quote) });
    }
  }
  return { trades, asOf: params.asOf, marks };
}
function wire(r: ReturnType<typeof computePnl>): unknown {
  const s = (x: bigint | null) => (x === null ? null : x.toString());
  return {
    tokens: r.tokens.map((t) => ({
      token: t.token, boughtAmount: s(t.boughtAmount), soldAmount: s(t.soldAmount), buyCost: s(t.buyCost), sellProceeds: s(t.sellProceeds),
      realisedCost: s(t.realisedCost), realisedProceeds: s(t.realisedProceeds), realised: s(t.realised), openAmount: s(t.openAmount),
      openCost: s(t.openCost), unmatchedSoldAmount: s(t.unmatchedSoldAmount), unmatchedProceeds: s(t.unmatchedProceeds), unrealised: s(t.unrealised),
    })),
    totals: { realised: s(r.totals.realised), unrealised: s(r.totals.unrealised), unmarkedTokens: r.totals.unmarkedTokens, unmatchedProceeds: s(r.totals.unmatchedProceeds) },
  };
}

describe("pnl vectors: the TypeScript core agrees with the independent implementation", () => {
  const { cases } = load("pnl");
  it("has the cases it should", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(cases.filter((c: any) => c.expectError).length).toBeGreaterThanOrEqual(8);
  });
  for (const c of cases) {
    it(c.name, () => {
      const run = () => {
        const { trades, asOf, marks } = toCore(c.params);
        return computePnl(trades, { ...(asOf === undefined ? {} : { asOf }), ...(marks === undefined ? {} : { marks }) });
      };
      if (c.expectError) expect(run).toThrow();
      else expect(wire(run())).toEqual(c.expected);
    });
  }
});

describe("canonical vectors", () => {
  const v = load("canonical");
  for (const c of v.cases) {
    it(c.name, () => {
      expect(canonicalJson(c.value)).toBe(c.canonical);
      expect(sha256Hex(c.canonical)).toBe(c.sha256);
      expect(specHash(c.value)).toBe(c.sha256);
    });
  }
  for (const c of v.invalid) it(`refuses ${c.name}`, () => expect(() => canonicalJson(c.value)).toThrow(TypeError));
});

describe("backtest vectors: specs and reports", () => {
  const v = load("backtest");
  it("has the cases it should", () => {
    expect(v.cases.length).toBeGreaterThanOrEqual(19);
    expect(v.invalidSpecs.length).toBeGreaterThanOrEqual(50);
  });
  for (const c of v.cases) {
    it(`${c.name}: the spec is valid, its hash matches, the expected report is well formed`, () => {
      expect(() => parseBacktestSpec(c.spec)).not.toThrow();
      expect(c.expected.specHash).toBe(specHash(c.spec));
      expect(() => parseBacktestReport({ engineVersion: "0.0.0", ...c.expected })).not.toThrow();
      const s = c.expected.summary;
      expect(s.signals).toBe(s.ignoredWhileOpen + s.skipped.noPrice + s.skipped.tooSmall + s.entered);
      expect(c.expected.positions.length).toBe(s.entered);
    });
  }
  for (const c of v.invalidSpecs) it(`refuses a spec with: ${c.name}`, () => expect(() => parseBacktestSpec(c.spec)).toThrow(SpecError));
});
