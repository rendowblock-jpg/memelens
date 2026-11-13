import { describe, expect, it } from "vitest";
import { pickGroup } from "../src/pick";
import type { LabelRow } from "../src/load";

const row = (mint: string, label: LabelRow["label"], createdAt = 1): LabelRow => ({ mint, createdAt, label, reason: "r" });
const ten = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"].map((m) => row(m, "rugged"));

// The expected order was computed in Python: sha256("memelens-calibration-v1:pick:" + mint) ascending.
describe("pickGroup", () => {
  it("orders the group by the pick key and takes the first n", () => {
    expect(pickGroup(ten, "rugged", 4)).toEqual(["m6", "m1", "m5", "m4"]);
    expect(pickGroup(ten, "rugged", 10)).toEqual(["m6", "m1", "m5", "m4", "m3", "m2", "m8", "m9", "m0", "m7"]);
  });

  it("gives the same picks whatever order the rows come in, and whatever their creation times are", () => {
    const shuffled = [...ten].reverse().map((r, i) => ({ ...r, createdAt: 100 - i }));
    expect(pickGroup(shuffled, "rugged", 4)).toEqual(["m6", "m1", "m5", "m4"]);
  });

  it("takes only rows with the asked label", () => {
    const mixed = [row("m6", "survived"), row("m1", "rugged"), row("m5", "neither"), row("m4", "collapsed-before-scoring"), row("m3", "rugged")];
    expect(pickGroup(mixed, "rugged", 30)).toEqual(["m1", "m3"]);
    expect(pickGroup(mixed, "survived", 30)).toEqual(["m6"]);
  });

  it("takes all of a group that has fewer than n, in the same order", () => {
    expect(pickGroup(ten.slice(0, 3), "rugged", 30)).toEqual(["m1", "m2", "m0"]);
  });

  it("takes none for a size of 0 or a group with no rows, and refuses a negative or fractional size", () => {
    expect(pickGroup(ten, "rugged", 0)).toEqual([]);
    expect(pickGroup([], "rugged", 5)).toEqual([]);
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => pickGroup(ten, "rugged", bad)).toThrow(RangeError);
  });

  it("does not depend on the other group: adding survivors does not change who is picked among the rugged", () => {
    const withSurvivors = [...ten, ...["sur-1", "sur-2", "sur-3"].map((m) => row(m, "survived"))];
    expect(pickGroup(withSurvivors, "rugged", 4)).toEqual(["m6", "m1", "m5", "m4"]);
  });
});
