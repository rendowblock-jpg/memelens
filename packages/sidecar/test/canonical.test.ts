import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, specHash } from "../src/canonical";

describe("canonicalJson", () => {
  it("sorts object keys and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: {} })).toBe('{"a":[true,null,"x"],"b":1,"c":{}}');
  });
  it("keeps the order of array items", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
  it("sorts keys by their UTF-8 bytes, not by UTF-16 units (U+FF5E comes before U+10000)", () => {
    expect(canonicalJson({ "\u{10000}": 1, "\uff5e": 2, a: 3 })).toBe('{"a":3,"\uff5e":2,"\u{10000}":1}');
  });
  it("escapes only quote, backslash and the C0 controls; \\b \\f \\n \\r \\t get short forms, the rest \\u00xx in lower case", () => {
    expect(canonicalJson('q" b\\ \b \f \n \r \t \u0001 \u001f')).toBe('"q\\" b\\\\ \\b \\f \\n \\r \\t \\u0001 \\u001f"');
  });
  it("leaves DEL, <, >, &, U+2028, U+2029 and non-ASCII text raw", () => {
    expect(canonicalJson("\u007f<>&\u2028\u2029é中😀")).toBe('"\u007f<>&\u2028\u2029é中😀"');
  });
  it("writes integers, including negative ones, and writes -0 as 0", () => {
    expect(canonicalJson([0, -5, 9007199254740991, -9007199254740991, -0])).toBe("[0,-5,9007199254740991,-9007199254740991,0]");
  });
  it("refuses numbers that are not safe integers", () => {
    for (const n of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53), 1e21]) expect(() => canonicalJson(n), String(n)).toThrow(TypeError);
    expect(() => canonicalJson({ a: [1, 0.25] })).toThrow(TypeError);
  });
  it("refuses values JSON has no form for, and says where", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined })).toThrow(/\$\.a/);
    expect(() => canonicalJson([1n])).toThrow(/\$\[0\]/);
    for (const v of [() => 1, Symbol("s"), new Map(), new Set(), new Date(0), new (class X {})(), /x/]) expect(() => canonicalJson(v)).toThrow(TypeError);
  });
  it("refuses a cycle", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => canonicalJson(a)).toThrow(/cycl/i);
  });
  it("accepts the same object twice when it is not a cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
  it("refuses a lone surrogate in a string or a key, and accepts a proper pair", () => {
    expect(() => canonicalJson("\ud800")).toThrow(TypeError);
    expect(() => canonicalJson("\udc00x")).toThrow(TypeError);
    expect(() => canonicalJson({ "\ud800": 1 })).toThrow(TypeError);
    expect(canonicalJson("\ud83d\ude00")).toBe('"😀"');
  });
  it("accepts objects without a prototype", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o["a"] = 1;
    expect(canonicalJson(o)).toBe('{"a":1}');
  });
});

describe("sha256Hex and specHash", () => {
  it("matches the published SHA-256 of the empty string and of 'abc'", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("hashes the UTF-8 bytes of the text (é is the two bytes c3 a9, not one)", () => {
    expect(sha256Hex("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
    expect(sha256Hex("\u00c3\u00a9")).toBe("54ece1f236a7b69df09fd138f193ce0fea6d4936f8cf966f799449c2150f23f2");
  });
  it("hashes the canonical form, so key order does not matter", () => {
    expect(specHash({ b: 1, a: 2 })).toBe(specHash({ a: 2, b: 1 }));
    expect(specHash({ a: 1 })).toBe(sha256Hex('{"a":1}'));
  });
  it("gives 64 lower-case hex digits", () => {
    expect(specHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
