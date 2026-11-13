import { describe, expect, it } from "vitest";
import { planTasks, HOUR, MINUTE, DAY } from "../src/plan";

describe("the schedule of one followed token", () => {
  const t0 = 1_794_562_000_000;

  it("has the three tasks of the protocol, in time order", () => {
    expect(planTasks(t0).map((p) => p.kind)).toEqual(["snapshot", "path72", "path30d"]);
  });

  it("reads the first-hour snapshot at +60 minutes and gives up 15 minutes later", () => {
    const p = planTasks(t0)[0]!;
    expect(p.dueAt).toBe(t0 + 60 * MINUTE);
    expect(p.deadlineAt).toBe(t0 + 75 * MINUTE);
  });

  it("reads the 72-hour path at +72 hours with 6 hours of grace", () => {
    const p = planTasks(t0)[1]!;
    expect(p.dueAt).toBe(t0 + 72 * HOUR);
    expect(p.deadlineAt).toBe(t0 + 78 * HOUR);
  });

  it("reads the 30-day path at +30 days with 12 hours of grace", () => {
    const p = planTasks(t0)[2]!;
    expect(p.dueAt).toBe(t0 + 30 * DAY);
    expect(p.deadlineAt).toBe(t0 + 30 * DAY + 12 * HOUR);
  });

  it("measures time in milliseconds", () => {
    expect([MINUTE, HOUR, DAY]).toEqual([60_000, 3_600_000, 86_400_000]);
  });

  it("refuses a creation time that is not a whole non-negative number of milliseconds", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => planTasks(bad)).toThrow(RangeError);
  });
});
