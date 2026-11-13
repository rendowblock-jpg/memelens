import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isCandles, isReport, ParseError, parseNewPools, parseTokenPools } from "../src/parse";

const fixture = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

// The fixtures are real replies recorded on 13 Nov 2026 (GeckoTerminal, RugCheck).
describe("parseNewPools on a real GeckoTerminal page", () => {
  const { launches, skipped } = parseNewPools(fixture("gt-new-pools.json"));

  it("keeps only the pump.fun pools (11 of the page's 20) and skips none", () => {
    expect(launches).toHaveLength(11);
    expect(skipped).toBe(0);
  });

  it("reads the token address without the 'solana_' prefix, the pool address, the name and the time in milliseconds", () => {
    expect(launches[0]).toEqual({
      mint: "2xqTL8FKS7GR1s6VLbSXNbkyRQjAhsz114afbMGvpump",
      pool: "G5PjEgd8f8ToU1UdEETkfMVHriAwH6rZKapiwLmBBPXT",
      name: "$REXTON / SOL",
      createdAt: Date.parse("2026-11-13T09:27:59Z"),
    });
    expect(launches.at(-1)?.mint).toBe("Fucr4Z9bTrqyPFXrEsPV74xG2iHD79h1p9nqTbukpump");
    expect(launches.at(-1)?.createdAt).toBe(1_794_562_036_000);
  });

  it("keeps the order of the page", () => {
    const times = launches.map((l) => l.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe("parseNewPools on bad input", () => {
  const good = (over: Record<string, unknown> = {}): unknown => ({
    data: [
      {
        attributes: { address: "POOL1", name: "X / SOL", pool_created_at: "2026-11-13T09:27:59Z", ...over },
        relationships: { base_token: { data: { id: "solana_MINT1" } }, dex: { data: { id: "pump-fun" } } },
      },
    ],
  });

  it("accepts a minimal pool", () => {
    expect(parseNewPools(good()).launches).toEqual([{ mint: "MINT1", pool: "POOL1", name: "X / SOL", createdAt: 1_794_562_079_000 }]);
  });

  it("counts a pump.fun pool with a missing or unreadable field as skipped, and keeps the rest", () => {
    for (const over of [{ address: undefined }, { address: "" }, { pool_created_at: "not a date" }, { pool_created_at: undefined }]) {
      const r = parseNewPools(good(over));
      expect(r.launches).toEqual([]);
      expect(r.skipped).toBe(1);
    }
  });

  it("counts a pump.fun pool whose base token id is not 'solana_<address>' as skipped", () => {
    const j = good() as { data: Array<{ relationships: { base_token: { data: { id: string } } } }> };
    j.data[0]!.relationships.base_token.data.id = "eth_0xabc";
    expect(parseNewPools(j)).toEqual({ launches: [], skipped: 1 });
  });

  it("ignores pools of other venues without counting them", () => {
    const j = good() as { data: Array<{ relationships: { dex: { data: { id: string } } } }> };
    j.data[0]!.relationships.dex.data.id = "raydium";
    expect(parseNewPools(j)).toEqual({ launches: [], skipped: 0 });
  });

  it("throws a ParseError when the reply is not a list of pools", () => {
    for (const bad of [null, 3, "x", [], {}, { data: {} }, { errors: [{ status: "429" }] }]) expect(() => parseNewPools(bad)).toThrow(ParseError);
  });
});

describe("parseTokenPools", () => {
  it("lists a young token's pools with their liquidity and 24-hour volume", () => {
    expect(parseTokenPools(fixture("gt-token-pools-young.json"))).toEqual([
      { pool: "2DAFkTbMVQ4apJ1QiEb1XqpwJ6qXkzpQA3bu2JCjUPbf", dex: "pump-fun", reserveUsd: 230.3144, volume24hUsd: 133.3594645239 },
    ]);
  });

  it("gives null for a liquidity or volume that is missing or not a number", () => {
    const j = { data: [{ attributes: { address: "P", reserve_in_usd: null, volume_usd: { h24: "x" } }, relationships: { dex: { data: { id: "d" } } } }] };
    expect(parseTokenPools(j)).toEqual([{ pool: "P", dex: "d", reserveUsd: null, volume24hUsd: null }]);
  });

  it("orders the pools by liquidity, largest first, with unknown liquidity last", () => {
    const pool = (address: string, reserve: string | null) => ({ attributes: { address, reserve_in_usd: reserve }, relationships: { dex: { data: { id: "d" } } } });
    const r = parseTokenPools({ data: [pool("A", "5"), pool("B", null), pool("C", "50")] });
    expect(r.map((p) => p.pool)).toEqual(["C", "A", "B"]);
  });

  it("throws a ParseError when the reply is not a list", () => {
    for (const bad of [null, {}, { data: "x" }]) expect(() => parseTokenPools(bad)).toThrow(ParseError);
  });
});

describe("the shape checks on the replies that are stored whole", () => {
  it("accepts a real RugCheck report and a real candle reply", () => {
    expect(isReport(fixture("rugcheck-report-established.json"))).toBe(true);
    expect(isCandles(fixture("gt-ohlcv-minute.json"))).toBe(true);
    expect(isCandles(fixture("gt-ohlcv-hour.json"))).toBe(true);
  });

  it("refuses a reply that is not a report or not candles", () => {
    expect(isReport({ mint: "M" })).toBe(false); // no holders list
    expect(isReport({ topHolders: [] })).toBe(false); // no mint
    expect(isReport(null)).toBe(false);
    expect(isCandles({ data: { attributes: { ohlcv_list: "x" } } })).toBe(false);
    expect(isCandles({ data: { attributes: { ohlcv_list: [[1, 2, 3]] } } })).toBe(false); // a candle has six numbers
    expect(isCandles({ errors: [] })).toBe(false);
  });

  it("accepts an empty candle list (a pool with no trade in the window)", () => {
    expect(isCandles({ data: { attributes: { ohlcv_list: [] } } })).toBe(true);
  });
});
