import { describe, expect, it } from "vitest";
import { reduceSample, type SampleState } from "./empty";

const idle: SampleState = { phase: "idle" };
const loading: SampleState = { phase: "loading" };
const loaded: SampleState = { phase: "loaded" };
const failed: SampleState = { phase: "failed", message: "x" };
const good = { type: "answered", result: { state: "ok", data: { chain: "synthetic", tokens: 5, trades: 40 } } } as const;
const bad = { type: "answered", result: { state: "error", message: "this database already holds data; the sample is only loaded into an empty one" } } as const;

describe("reduceSample", () => {
  it("starts loading on a click, from idle and from a failure (so a person can try again)", () => {
    expect(reduceSample(idle, { type: "click" })).toEqual(loading);
    expect(reduceSample(failed, { type: "click" })).toEqual(loading);
  });
  it("ignores a click while loading or after loading: one load at a time", () => {
    expect(reduceSample(loading, { type: "click" })).toBe(loading);
    expect(reduceSample(loaded, { type: "click" })).toBe(loaded);
  });
  it("is 'loaded' when the answer is good, and stays so until the screen is replaced by the data", () => {
    expect(reduceSample(loading, good)).toEqual(loaded);
  });
  it("shows the reason when the answer is an error", () => {
    expect(reduceSample(loading, bad)).toEqual({ phase: "failed", message: "this database already holds data; the sample is only loaded into an empty one" });
  });
  it("ignores an answer that arrives when nothing was asked", () => {
    for (const s of [idle, loaded, failed]) {
      expect(reduceSample(s, good), s.phase).toBe(s);
      expect(reduceSample(s, bad), s.phase).toBe(s);
    }
  });
});
