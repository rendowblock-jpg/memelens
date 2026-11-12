import { describe, expect, it } from "vitest";
import { parseBacktestReport, ReportError } from "../src/report";

function position(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    token: "X", signalTradeId: "t1", signalWallet: "alice", entryTradeId: "t2", entryTime: 2000, entryAmount: "1000", buyFee: "0", cost: "1000000",
    exitTradeId: "t3", exitTime: 3000, exitReason: "takeProfit", proceeds: "1500000", sellFee: "0", net: "1500000", pnl: "500000", ...over,
  };
}
const big = (s: unknown): bigint => {
  try {
    return BigInt(s as string);
  } catch {
    return 0n;
  }
};
/** The summary a correct engine would write for these positions (every signal entered). */
function summaryFor(ps: Record<string, any>[]): Record<string, any> {
  const exits: Record<string, number> = { takeProfit: 0, stopLoss: 0, maxHold: 0, end: 0 };
  let wins = 0, losses = 0, cost = 0n, net = 0n;
  for (const p of ps) {
    exits[p["exitReason"]] = (exits[p["exitReason"]] ?? 0) + 1;
    if (big(p["pnl"]) > 0n) wins++;
    if (big(p["pnl"]) < 0n) losses++;
    cost += big(p["cost"]);
    net += big(p["net"]);
  }
  const realised = net - cost;
  return {
    signals: ps.length, ignoredWhileOpen: 0, skipped: { noPrice: 0, tooSmall: 0 }, entered: ps.length, exits, wins, losses,
    totalCost: cost.toString(), totalNet: net.toString(), realised: realised.toString(), roiBps: cost === 0n ? null : Number((realised * 10000n) / cost),
  };
}
function report(over: Record<string, unknown> = {}): Record<string, any> {
  const positions = (over["positions"] as Record<string, any>[] | undefined) ?? [position()];
  return { engineVersion: "0.1.0", specHash: "a".repeat(64), dataAsOf: 3000, positions, summary: summaryFor(positions), ...over };
}
function pathOf(input: unknown): string {
  try {
    parseBacktestReport(input);
  } catch (e) {
    if (e instanceof ReportError) return e.path;
    throw e;
  }
  return "(accepted)";
}
const withSummary = (patch: Record<string, unknown>) => report({ summary: { ...report()["summary"], ...patch } });

describe("parseBacktestReport: good reports", () => {
  it("accepts a consistent report and returns an equal copy", () => {
    expect(parseBacktestReport(report())).toEqual(report());
  });
  it("accepts an empty run with null dataAsOf and null roiBps", () => {
    const empty = report({ dataAsOf: null, positions: [] });
    expect(empty["summary"]["roiBps"]).toBeNull();
    expect(pathOf(empty)).toBe("(accepted)");
  });
  it("accepts a losing position, a break-even one, and a loss that rounds to 0 bps", () => {
    expect(pathOf(report({ positions: [position({ pnl: "-5", net: "999995", proceeds: "999995" })] }))).toBe("(accepted)");
    expect(pathOf(report({ positions: [position({ pnl: "0", net: "1000000", proceeds: "1000000", exitReason: "end" })] }))).toBe("(accepted)");
    const tiny = report({ positions: [position({ pnl: "-1", net: "999999", proceeds: "999999", exitReason: "end" })] });
    expect(tiny["summary"]).toMatchObject({ losses: 1, wins: 0, realised: "-1", roiBps: 0 });
    expect(pathOf(tiny)).toBe("(accepted)");
  });
  it("accepts a report of several positions with signals that were ignored or skipped", () => {
    const ps = [position(), position({ entryTime: 5000, exitTime: 6000, exitReason: "end" })];
    const r = report({ positions: ps });
    r["summary"] = { ...r["summary"], signals: 5, ignoredWhileOpen: 2, skipped: { noPrice: 1, tooSmall: 0 } };
    expect(pathOf(r)).toBe("(accepted)");
  });
});

describe("parseBacktestReport: refusals", () => {
  it("refuses a report that is not an object or lacks a field", () => {
    expect(pathOf(null)).toBe("$");
    for (const k of ["engineVersion", "specHash", "dataAsOf", "positions", "summary"]) {
      const r = report();
      delete r[k];
      expect(pathOf(r), k).toBe(`$.${k}`);
    }
  });
  it("refuses unknown fields in the report, a position and the summary", () => {
    expect(pathOf(report({ extra: 1 }))).toBe("$.extra");
    expect(pathOf(report({ positions: [position({ extra: 1 })] }))).toBe("$.positions[0].extra");
    expect(pathOf(withSummary({ extra: 1 }))).toBe("$.summary.extra");
  });
  it("refuses a spec hash that is not 64 lower-case hex digits", () => {
    for (const h of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64), 5]) expect(pathOf(report({ specHash: h })), String(h)).toBe("$.specHash");
  });
  it("refuses an engine version that is not text, and a dataAsOf that is not a time or null", () => {
    expect(pathOf(report({ engineVersion: "" }))).toBe("$.engineVersion");
    expect(pathOf(report({ engineVersion: 5 }))).toBe("$.engineVersion");
    for (const v of [-1, 1.5, "5", undefined]) expect(pathOf(report({ dataAsOf: v })), String(v)).toBe("$.dataAsOf");
  });
  it("checks every position field", () => {
    expect(pathOf(report({ positions: "x" }))).toBe("$.positions");
    expect(pathOf(report({ positions: [position({ exitReason: "panic" })] }))).toBe("$.positions[0].exitReason");
    for (const k of ["token", "signalTradeId", "signalWallet", "entryTradeId", "exitTradeId"]) expect(pathOf(report({ positions: [position({ [k]: "" })] })), k).toBe(`$.positions[0].${k}`);
    for (const k of ["entryAmount", "buyFee", "cost", "proceeds", "sellFee", "net"]) {
      expect(pathOf(report({ positions: [position({ [k]: "1.5" })] })), k).toBe(`$.positions[0].${k}`);
      expect(pathOf(report({ positions: [position({ [k]: "-5" })] })), k).toBe(`$.positions[0].${k}`);
    }
    for (const k of ["entryTime", "exitTime"]) expect(pathOf(report({ positions: [position({ [k]: -1 })] })), k).toBe(`$.positions[0].${k}`);
    expect(pathOf(report({ positions: [position({ pnl: "05" })] }))).toBe("$.positions[0].pnl");
    expect(pathOf(report({ positions: [position({ pnl: "-0" })] }))).toBe("$.positions[0].pnl");
    expect(pathOf(report({ positions: [position({ entryAmount: "0" })] }))).toBe("$.positions[0].entryAmount");
  });
  it("refuses a position that exits before it enters, or whose arithmetic does not add up", () => {
    expect(pathOf(report({ positions: [position({ exitTime: 1999 })] }))).toBe("$.positions[0].exitTime");
    expect(pathOf(report({ positions: [position({ net: "1499999" })] }))).toBe("$.positions[0].net");
    expect(pathOf(report({ positions: [position({ sellFee: "1" })] }))).toBe("$.positions[0].net");
    expect(pathOf(report({ positions: [position({ pnl: "499999" })] }))).toBe("$.positions[0].pnl");
    expect(pathOf(report({ positions: [position({ cost: "1", buyFee: "1", pnl: "1499999" })] }))).toBe("$.positions[0].cost");
  });
  it("checks that the summary adds up to the positions", () => {
    expect(pathOf(withSummary({ signals: 2 }))).toBe("$.summary.signals");
    expect(pathOf(withSummary({ entered: 2, signals: 2 }))).toBe("$.summary.entered");
    expect(pathOf(withSummary({ exits: { takeProfit: 0, stopLoss: 1, maxHold: 0, end: 0 } }))).toBe("$.summary.exits");
    expect(pathOf(withSummary({ wins: 0 }))).toBe("$.summary.wins");
    expect(pathOf(withSummary({ losses: 1 }))).toBe("$.summary.losses");
    expect(pathOf(withSummary({ totalCost: "999" }))).toBe("$.summary.totalCost");
    expect(pathOf(withSummary({ totalNet: "1" }))).toBe("$.summary.totalNet");
    expect(pathOf(withSummary({ realised: "1" }))).toBe("$.summary.realised");
    expect(pathOf(withSummary({ roiBps: 4999 }))).toBe("$.summary.roiBps");
    expect(pathOf(withSummary({ roiBps: null }))).toBe("$.summary.roiBps");
    expect(pathOf(withSummary({ skipped: { noPrice: -1, tooSmall: 0 } }))).toBe("$.summary.skipped.noPrice");
    expect(pathOf(withSummary({ ignoredWhileOpen: 1.5 }))).toBe("$.summary.ignoredWhileOpen");
  });
  it("wants a null roiBps exactly when nothing was spent", () => {
    const none = report({ positions: [], dataAsOf: null });
    none["summary"].roiBps = 0;
    expect(pathOf(none)).toBe("$.summary.roiBps");
  });
});

describe("parseBacktestReport: the written form of a loss or gain", () => {
  const evenPosition = (pnl: string) => position({ pnl, net: "1000000", proceeds: "1000000", exitReason: "end" });
  it("accepts 0 as the profit of a break-even position, and refuses -0 and 00", () => {
    expect(pathOf(report({ positions: [evenPosition("0")] }))).toBe("(accepted)");
    expect(pathOf(report({ positions: [evenPosition("-0")] }))).toBe("$.positions[0].pnl");
    expect(pathOf(report({ positions: [evenPosition("00")] }))).toBe("$.positions[0].pnl");
  });
  it("refuses a profit written with a leading zero even when its value is right", () => {
    expect(pathOf(report({ positions: [position({ pnl: "0500000" })] }))).toBe("$.positions[0].pnl");
    expect(pathOf(report({ positions: [position({ pnl: "+500000" })] }))).toBe("$.positions[0].pnl");
    expect(pathOf(report({ positions: [position({ cost: "01000000" })] }))).toBe("$.positions[0].cost");
  });
  it("wants the return in basis points to be a whole number", () => {
    const r = report();
    r["summary"].roiBps = 5000.5;
    expect(() => parseBacktestReport(r)).toThrow(/whole number or null/);
    r["summary"].roiBps = "5000";
    expect(() => parseBacktestReport(r)).toThrow(/whole number or null/);
  });
});
