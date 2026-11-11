import { describe, expect, it } from "vitest";
import { toWire } from "../src/wire";

describe("toWire", () => {
  it("turns a bigint into its decimal string", () => {
    expect(toWire(123n)).toBe("123");
    expect(toWire(-5n)).toBe("-5");
    expect(toWire(0n)).toBe("0");
  });

  it("keeps every digit of a bigint far beyond 2^53 and 2^63", () => {
    const big = 10n ** 30n + 7n;
    expect(toWire(big)).toBe("1000000000000000000000000000007");
    expect(toWire(-(2n ** 70n))).toBe("-1180591620717411303424");
  });

  it("converts bigints nested in objects and arrays and leaves other values alone", () => {
    const input = { a: 1n, b: [2n, { c: 3n }], s: "x", n: 4.5, t: true, z: null };
    expect(toWire(input)).toEqual({ a: "1", b: ["2", { c: "3" }], s: "x", n: 4.5, t: true, z: null });
  });

  it("does not change the input", () => {
    const input = { a: 1n, b: [2n] };
    toWire(input);
    expect(input).toEqual({ a: 1n, b: [2n] });
  });

  it("keeps numeric record keys (as strings, as JSON does)", () => {
    expect(toWire({ 1: 0.5, 10: 0.9 })).toEqual({ "1": 0.5, "10": 0.9 });
  });

  it("produces something JSON.stringify accepts and round-trips unchanged", () => {
    const wire = toWire({ a: 10n ** 25n, list: [1n, 2n], x: 0.25 });
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });

  it("drops no property: an undefined property is omitted, as JSON would, but undefined in an array is an error", () => {
    expect(toWire({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(() => toWire([1, undefined])).toThrow(/undefined/);
  });

  it("refuses a number JSON would silently turn into null", () => {
    expect(() => toWire(NaN)).toThrow(/NaN/);
    expect(() => toWire(Infinity)).toThrow(/Infinity/);
    expect(() => toWire({ a: { b: -Infinity } })).toThrow(/a\.b/);
  });

  it("refuses values that have no JSON form", () => {
    expect(() => toWire(() => 1)).toThrow(/function/);
    expect(() => toWire(Symbol("s"))).toThrow(/symbol/);
    expect(() => toWire(new Map())).toThrow(/Map/);
    expect(() => toWire(new Set())).toThrow(/Set/);
    expect(() => toWire(new Date(0))).toThrow(/Date/);
  });

  it("accepts an object with no prototype (a plain dictionary)", () => {
    const dict = Object.create(null) as Record<string, bigint>;
    dict["a"] = 5n;
    expect(toWire(dict)).toEqual({ a: "5" });
  });

  it("names the path of the offending value", () => {
    expect(() => toWire({ rows: [{ ok: 1 }, { bad: NaN }] })).toThrow(/rows\[1\]\.bad/);
  });

  it("refuses a cyclic structure instead of overflowing the stack", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => toWire(a)).toThrow(/cycl/i);
  });

  it("allows the same object twice (a shared reference is not a cycle)", () => {
    const shared = { v: 1n };
    expect(toWire({ x: shared, y: shared })).toEqual({ x: { v: "1" }, y: { v: "1" } });
  });
});
