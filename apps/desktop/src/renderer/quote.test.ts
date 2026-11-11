import { describe, expect, it } from "vitest";
import { quoteFor, RAW_QUOTE } from "./quote";

describe("quoteFor", () => {
  it("knows the quote currency of the supported chains", () => {
    expect(quoteFor("solana")).toEqual({ symbol: "SOL", decimals: 9 });
    expect(quoteFor("synthetic")).toEqual({ symbol: "SOL", decimals: 9 });
  });

  it("shows raw units for a chain it does not know, never a guessed currency", () => {
    expect(quoteFor("base")).toBe(RAW_QUOTE);
    expect(RAW_QUOTE).toEqual({ symbol: "raw units", decimals: 0 });
  });

  it("is not fooled by names that exist on every object", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", ""]) expect(quoteFor(name)).toBe(RAW_QUOTE);
  });
});
