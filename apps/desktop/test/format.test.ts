import { describe, expect, it } from "vitest";
import { FormatError, formatAge, formatPercent, formatPrice, formatSignalValue, formatTime, formatUnits, shortAddress, formatSigned, formatSignedPercent } from "../src/renderer/format";

// Expected values were worked out by hand and cross-checked with Python's decimal module (round half up),
// not with the code under test.

describe("formatUnits", () => {
  it.each([
    ["1500000", 6, undefined, "1.5"],
    ["123456789", 6, undefined, "123.4568"],
    ["1000000000", 6, undefined, "1,000"],
    ["0", 6, undefined, "0"],
    ["10000", 6, undefined, "0.01"],
    ["99999", 6, undefined, "0.1"],
    ["1234567", 0, undefined, "1,234,567"],
    ["999999", 6, 2, "1"],
    ["1500000", 6, 0, "2"],
    ["2500000", 6, 0, "3"],
  ])("formatUnits(%s, %i, %s) = %s", (raw, decimals, maxFraction, expected) => {
    expect(maxFraction === undefined ? formatUnits(raw, decimals) : formatUnits(raw, decimals, maxFraction)).toBe(expected);
  });

  it("keeps full precision far beyond 2^53", () => {
    expect(formatUnits("12345678901234567890123456789012", 6)).toBe("12,345,678,901,234,567,890,123,456.789");
  });

  it("rounds half up at exactly the rounding boundary and shows <min only below it", () => {
    expect(formatUnits("50", 6)).toBe("0.0001"); // 0.00005 rounds up
    expect(formatUnits("100", 6)).toBe("0.0001");
    expect(formatUnits("49", 6)).toBe("<0.0001");
    expect(formatUnits("1", 6)).toBe("<0.0001");
    expect(formatUnits("1", 6, 2)).toBe("<0.01");
  });

  it("handles negative amounts with a leading minus", () => {
    expect(formatUnits("-1500000", 6)).toBe("-1.5");
    expect(formatUnits("-1000000000", 6)).toBe("-1,000");
    expect(formatUnits("-1", 6)).toBe("-<0.0001");
    expect(formatUnits("-50", 6)).toBe("-0.0001");
  });

  it("never prints a minus sign for zero", () => {
    expect(formatUnits("-0", 6)).toBe("0");
  });

  it.each(["", "-", "1.5", " 1", "1 ", "1e6", "abc", "+1", "0x10", "١٢٣"])("rejects the malformed amount %j", (raw) => {
    expect(() => formatUnits(raw, 6)).toThrow(FormatError);
  });

  it.each([-1, 1.5, 37, Number.NaN, Number.POSITIVE_INFINITY])("rejects the decimals value %s", (decimals) => {
    expect(() => formatUnits("1", decimals)).toThrow(FormatError);
  });

  it.each([-1, 1.5, 19, Number.NaN])("rejects the maxFraction value %s", (maxFraction) => {
    expect(() => formatUnits("1", 6, maxFraction)).toThrow(FormatError);
  });
});

describe("formatUnits limits", () => {
  it("accepts exactly the maximum decimals (36) and maxFraction (18), and a tiny value rounds to <1 with maxFraction 0", () => {
    expect(formatUnits("1", 36)).toBe("<0.0001");
    expect(formatUnits(`1${"0".repeat(36)}`, 36)).toBe("1");
    expect(formatUnits("1", 18, 18)).toBe("0.000000000000000001");
    expect(formatUnits("1", 6, 0)).toBe("<1");
    expect(formatUnits("5", 0, 0)).toBe("5");
  });
});

describe("formatPrice (quote per whole token, significant digits)", () => {
  // formatPrice(tokenAmount, quoteAmount, tokenDecimals, quoteDecimals)
  it.each([
    ["1000000", "1000000000", 6, 9, "1"],
    ["1000000", "1234", 6, 9, "0.000001234"],
    ["1000000000", "123456", 6, 9, "0.0000001235"],
    ["1000000000", "123450", 6, 9, "0.0000001235"], // exact tie rounds up
    ["1000000", "99996", 6, 9, "0.0001"], // rounding carries into the next digit
    ["1000000", "12345678000000", 6, 9, "12,346"], // the integer part is never rounded away
    ["1000000", "1234567800000", 6, 9, "1,235"],
    ["1000000", "12345600000", 6, 9, "12.35"],
    ["1000000", "1500000000", 6, 9, "1.5"],
    ["2000000000", "1000000000", 9, 9, "0.5"],
    ["1000000", "0", 6, 9, "0"],
  ])("formatPrice(%s, %s, %i, %i) = %s", (amount, quote, td, qd, expected) => {
    expect(formatPrice(amount, quote, td, qd)).toBe(expected);
  });

  it("accepts exactly the maximum decimals (36) and significant digits (40)", () => {
    expect(formatPrice("1", "1", 0, 0, 40)).toBe("1");
    expect(formatPrice(`1${"0".repeat(36)}`, `1${"0".repeat(36)}`, 36, 36)).toBe("1");
    expect(formatPrice("1", "1", 0, 36)).toBe("0.000000000000000000000000000000000001");
  });

  it("honours the number of significant digits", () => {
    expect(formatPrice("1000000000", "123456", 6, 9, 2)).toBe("0.00000012");
    expect(formatPrice("1000000000", "123456", 6, 9, 6)).toBe("0.000000123456");
  });

  it("refuses a zero token amount (no price can be derived)", () => {
    expect(() => formatPrice("0", "100", 6, 9)).toThrow(FormatError);
  });

  it.each([
    ["-1", "100"],
    ["100", "-1"],
    ["1.5", "100"],
    ["100", ""],
  ])("refuses malformed or negative input (%s, %s)", (amount, quote) => {
    expect(() => formatPrice(amount, quote, 6, 9)).toThrow(FormatError);
  });

  it.each([0, -1, 1.5, 41])("refuses the significant digits value %s", (significant) => {
    expect(() => formatPrice("1000000", "1000", 6, 9, significant)).toThrow(FormatError);
  });
});

describe("formatPercent", () => {
  it("formats a 0..1 share with a fixed number of digits", () => {
    expect(formatPercent(0.5)).toBe("50.0%");
    expect(formatPercent(0.125)).toBe("12.5%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(0.3333333, 2)).toBe("33.33%");
    expect(formatPercent(0.5, 0)).toBe("50%");
  });

  it("shows a dash for unknown, never 0%", () => {
    expect(formatPercent(null)).toBe("—");
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])("rejects the impossible share %s", (share) => {
    expect(() => formatPercent(share)).toThrow(FormatError);
  });

  it.each([-1, 1.5, 7])("rejects the digits value %s", (digits) => {
    expect(() => formatPercent(0.5, digits)).toThrow(FormatError);
  });
});

describe("formatAge", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [3_599_999, "59m"],
    [3_600_000, "1h"],
    [3_660_000, "1h 1m"],
    [86_399_999, "23h 59m"],
    [86_400_000, "1d"],
    [90_000_000, "1d 1h"],
    [8_640_000_000, "100d"],
  ])("formatAge(%i) = %s", (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (ms) => {
    expect(() => formatAge(ms)).toThrow(FormatError);
  });
});

describe("formatTime", () => {
  it("prints UTC to the minute, independent of locale and time zone", () => {
    expect(formatTime(1_700_000_000_000)).toBe("2023-11-14 22:13 UTC");
    expect(formatTime(0)).toBe("1970-01-01 00:00 UTC");
    expect(formatTime(1_700_000_000_000 - 13_000)).toBe("2023-11-14 22:13 UTC"); // seconds are dropped, not rounded
    expect(formatTime(1_700_000_000_000 + 40_000)).toBe("2023-11-14 22:14 UTC"); // 22:14:00 is the next minute
  });

  it("accepts the last instant that has a 4-digit year, and refuses the next millisecond", () => {
    expect(formatTime(253_402_300_799_999)).toBe("9999-12-31 23:59 UTC");
    expect(() => formatTime(253_402_300_800_000)).toThrow(FormatError);
  });

  it.each([-1, 1.5, Number.NaN, 8.64e15 + 1])("rejects %s", (ms) => {
    expect(() => formatTime(ms)).toThrow(FormatError);
  });
});

describe("shortAddress", () => {
  it("keeps the first and last 4 characters of a long address", () => {
    expect(shortAddress("ABCDEFGHIJKLMNOP")).toBe("ABCD…MNOP");
    expect(shortAddress("ABCDEFGHIJ")).toBe("ABCD…GHIJ");
  });

  it("leaves a short address alone (shortening it would not make it shorter)", () => {
    expect(shortAddress("ABCDEFGHI")).toBe("ABCDEFGHI");
    expect(shortAddress("TOK1")).toBe("TOK1");
    expect(shortAddress("")).toBe("");
  });

  it("allows a zero-length head or tail, and exactly 64 characters at each end", () => {
    expect(shortAddress("ABCDEFGHIJKLMNOP", 0, 4)).toBe("…MNOP");
    expect(shortAddress("ABCDEFGHIJKLMNOP", 4, 0)).toBe("ABCD…");
    const long = "x".repeat(64) + "m".repeat(10) + "y".repeat(64);
    expect(shortAddress(long, 64, 64)).toBe(`${"x".repeat(64)}…${"y".repeat(64)}`);
    expect(() => shortAddress(long, 65, 4)).toThrow(FormatError);
    expect(() => shortAddress(long, 4, 65)).toThrow(FormatError);
  });

  it("takes the head and tail lengths as options", () => {
    expect(shortAddress("ABCDEFGHIJKLMNOP", 2, 3)).toBe("AB…NOP");
  });

  it("refuses silly head and tail lengths", () => {
    expect(() => shortAddress("ABCDEFGHIJKLMNOP", -1, 4)).toThrow(FormatError);
    expect(() => shortAddress("ABCDEFGHIJKLMNOP", 4, 1.5)).toThrow(FormatError);
  });
});

describe("formatSignalValue", () => {
  it("says unknown for null, yes/no for booleans, and 4 significant digits for numbers", () => {
    expect(formatSignalValue(null)).toBe("unknown");
    expect(formatSignalValue(true)).toBe("yes");
    expect(formatSignalValue(false)).toBe("no");
    expect(formatSignalValue(0.123456)).toBe("0.1235");
    expect(formatSignalValue(0)).toBe("0");
    expect(formatSignalValue(12)).toBe("12");
    expect(formatSignalValue(86_400_000)).toBe("86,400,000");
  });

  it("never prints exponent notation, and keeps the sign", () => {
    expect(formatSignalValue(0.00000012346)).toBe("0.0000001235");
    expect(formatSignalValue(-0.5)).toBe("-0.5");
    expect(formatSignalValue(9.9996)).toBe("10");
    expect(formatSignalValue(1234.5678)).toBe("1,235");
  });

  it("never throws a RangeError for tiny numbers, and never shows a non-zero value as 0", () => {
    expect(formatSignalValue(1e-16)).toBe("0.0000000000000001");
    expect(formatSignalValue(6e-19)).toBe("0.000000000000000001");
    expect(formatSignalValue(1e-19)).toBe("<0.000000000000000001");
    expect(formatSignalValue(-1e-200)).toBe("-<0.000000000000000001");
  });

  it("rejects numbers that are not finite", () => {
    expect(() => formatSignalValue(Number.NaN)).toThrow(FormatError);
    expect(() => formatSignalValue(Number.POSITIVE_INFINITY)).toThrow(FormatError);
  });
});

describe("formatSigned", () => {
  it("puts + on gains and - on losses, and nothing on zero", () => {
    expect(formatSigned("5000000", 9)).toBe("+0.005");
    expect(formatSigned("-5000000", 9)).toBe("-0.005");
    expect(formatSigned("0", 9)).toBe("0");
    expect(formatSigned("-0", 9)).toBe("0");
    expect(formatSigned("1500000000000", 9)).toBe("+1,500");
  });
  it("keeps the sign on an amount too small to show, so a tiny loss is never printed as a gain", () => {
    expect(formatSigned("1", 9)).toBe("+<0.0001");
    expect(formatSigned("-1", 9)).toBe("-<0.0001");
  });
  it("refuses what formatUnits refuses", () => {
    expect(() => formatSigned("1.5", 9)).toThrow(FormatError);
    expect(() => formatSigned("12", -1)).toThrow(FormatError);
  });
});

describe("formatSignedPercent", () => {
  it("signs gains and losses and allows more than 100%", () => {
    expect(formatSignedPercent(1)).toBe("+100.0%");
    expect(formatSignedPercent(-0.5)).toBe("-50.0%");
    expect(formatSignedPercent(12.345)).toBe("+1234.5%");
    expect(formatSignedPercent(0.25, 0)).toBe("+25%");
  });
  it("prints zero, and anything that rounds to zero, without a sign", () => {
    expect(formatSignedPercent(0)).toBe("0.0%");
    expect(formatSignedPercent(0.00004)).toBe("0.0%");
    expect(formatSignedPercent(-0.00004)).toBe("0.0%");
  });
  it("prints a dash for unknown, never 0%, and refuses numbers that are not numbers", () => {
    expect(formatSignedPercent(null)).toBe("—");
    expect(() => formatSignedPercent(Number.NaN)).toThrow(FormatError);
    expect(() => formatSignedPercent(Number.POSITIVE_INFINITY)).toThrow(FormatError);
  });
});
