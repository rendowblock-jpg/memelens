import { describe, expect, it } from "vitest";
import { FormatError } from "./format";
import { gaugeArc, riskBar, smartWindow } from "./model";

const sig = (id: string, weight: number, risk: number, known = true) => ({ id: id as never, label: `L-${id}`, known, weight, risk });

describe("riskBar", () => {
  it("gives each signal a width in proportion to its weight and places them left to right", () => {
    const bar = riskBar([sig("a", 30, 0.5), sig("b", 10, 0.2), sig("c", 60, 0.9)]);
    expect(bar.map((s) => [s.id, s.x, s.width, s.fill])).toEqual([
      ["a", 0, 30, 0.5],
      ["b", 30, 10, 0.2],
      ["c", 40, 60, 0.9],
    ]);
  });

  it("scales to the total, so weights that do not add up to 100 still fill the bar", () => {
    const bar = riskBar([sig("a", 1, 0), sig("b", 1, 0), sig("c", 2, 0)]);
    expect(bar.map((s) => [s.x, s.width])).toEqual([[0, 25], [25, 25], [50, 50]]);
  });

  it("keeps an unknown signal in the bar at its full width, empty, so missing data is visible and never counts as safe", () => {
    const bar = riskBar([sig("a", 50, 0.4), sig("b", 50, 0.7, false)]);
    expect(bar[1]).toMatchObject({ known: false, x: 50, width: 50, fill: 0 });
  });

  it("carries the label through", () => {
    expect(riskBar([sig("a", 1, 0)])[0]!.label).toBe("L-a");
  });

  it("leaves out a signal whose weight is zero (it is removed from the score)", () => {
    const bar = riskBar([sig("a", 10, 0.1), sig("b", 0, 0.9), sig("c", 10, 0.3)]);
    expect(bar.map((s) => s.id)).toEqual(["a", "c"]);
    expect(bar[1]!.x).toBe(50);
  });

  it("gives an empty bar when nothing has weight", () => {
    expect(riskBar([])).toEqual([]);
    expect(riskBar([sig("a", 0, 0.5)])).toEqual([]);
  });

  it("refuses numbers that cannot be drawn instead of drawing something wrong", () => {
    expect(() => riskBar([sig("a", Number.NaN, 0)])).toThrow(FormatError);
    expect(() => riskBar([sig("a", -1, 0)])).toThrow(FormatError);
    expect(() => riskBar([sig("a", 1, 1.01)])).toThrow(FormatError);
    expect(() => riskBar([sig("a", 1, -0.01)])).toThrow(FormatError);
    expect(() => riskBar([sig("a", 1, Number.POSITIVE_INFINITY)])).toThrow(FormatError);
  });

  it("accepts the edges of the range", () => {
    expect(riskBar([sig("a", 1, 0), sig("b", 1, 1)]).map((s) => s.fill)).toEqual([0, 1]);
  });

  it("does not check the risk of an unknown signal (it is 0 by contract and not used)", () => {
    expect(() => riskBar([sig("a", 1, Number.NaN, false)])).not.toThrow();
  });
});

describe("gaugeArc", () => {
  // circumference = 2 * pi * 10 = 62.8318...
  it("splits the circle into the filled part and the rest, rounded to 3 places", () => {
    expect(gaugeArc(25, 10)).toEqual({ circumference: 62.832, dash: 15.708, gap: 47.124 });
  });
  it("is empty at 0 and full at 100", () => {
    expect(gaugeArc(0, 10)).toEqual({ circumference: 62.832, dash: 0, gap: 62.832 });
    expect(gaugeArc(100, 10)).toEqual({ circumference: 62.832, dash: 62.832, gap: 0 });
  });
  it("refuses a percentage outside 0..100 and a radius that is not positive", () => {
    expect(() => gaugeArc(-1, 10)).toThrow(FormatError);
    expect(() => gaugeArc(100.5, 10)).toThrow(FormatError);
    expect(() => gaugeArc(Number.NaN, 10)).toThrow(FormatError);
    expect(() => gaugeArc(50, 0)).toThrow(FormatError);
    expect(() => gaugeArc(50, -3)).toThrow(FormatError);
  });
});

describe("smartWindow", () => {
  const LATEST = 1_700_020_700_000;
  it("ends at the newest data and starts the chosen number of days before it", () => {
    expect(smartWindow(LATEST, "1d")).toEqual({ from: 1_699_934_300_000, to: LATEST });
    expect(smartWindow(LATEST, "7d")).toEqual({ from: 1_699_415_900_000, to: LATEST });
    expect(smartWindow(LATEST, "30d")).toEqual({ from: 1_697_428_700_000, to: LATEST });
  });
  it("starts at 0 for all data", () => {
    expect(smartWindow(LATEST, "all")).toEqual({ from: 0, to: LATEST });
  });
  it("never starts before 0", () => {
    expect(smartWindow(1000, "1d")).toEqual({ from: 0, to: 1000 });
  });
  it("refuses a time that is not whole milliseconds, 0 or more", () => {
    expect(() => smartWindow(-1, "7d")).toThrow(FormatError);
    expect(() => smartWindow(1.5, "7d")).toThrow(FormatError);
    expect(() => smartWindow(Number.NaN, "all")).toThrow(FormatError);
  });
});
