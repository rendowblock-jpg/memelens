import { describe, expect, it } from "vitest";
import { labelStored, loadLabelInput, summarizeLabels, type StoredTask, type StoredToken } from "../src/load";
import type { Payload } from "../src/store";

// Hand-made stored tokens, built the way the collector stores them: one task per reading, each holding the replies as received.
const M = 60_000;
const H = 3_600_000;
const T0 = 1_800_000_000_000;
const S = T0 + 61 * M;
const MINT = "MINT1";
const CREATOR = "creator1";

const payload = (step: string, status: number, body: string, over: Partial<Payload> = {}): Payload => ({ step, url: "u", fetchedAt: S, status, valid: true, body, ...over });
const task = (payloads: Payload[], status: StoredTask["status"] = "done"): StoredTask => ({ status, payloads });

/** A GeckoTerminal candle reply from rows of [start ms, open, high, low, close, volume] (the reply carries seconds, newest first). */
const candles = (rows: number[][]): string => JSON.stringify({ data: { attributes: { ohlcv_list: rows.map(([t, ...rest]) => [t! / 1000, ...rest]).reverse() } } });
const flatMinutes = (price = 1): number[][] => Array.from({ length: 60 }, (_, m) => [T0 + m * M, price, price, price, price, 10]);
const hourRows = (k0: number, k1: number, price: number): number[][] => Array.from({ length: k1 - k0 + 1 }, (_, i) => [T0 + (k0 + i) * H, price, price, price, price, 100]);
const rugRows = (): number[][] => [...hourRows(2, 5, 1), [T0 + 6 * H, 1, 1, 0.05, 0.05, 100], ...hourRows(7, 71, 0.02)];

/** A RugCheck report in which the given owners hold the given amounts (a 1,000-token supply). */
const report = (rows: Array<[string, number]>, creator: string | null = CREATOR): string =>
  JSON.stringify({ mint: MINT, creator, token: { supply: 1000, decimals: 0 }, topHolders: rows.map(([owner, amount]) => ({ owner, amount })), totalHolders: rows.length, markets: [], mintAuthority: null, freezeAuthority: null });
const poolsReply = (rows: Array<[string, string | null]>): string =>
  JSON.stringify({ data: rows.map(([address, reserve]) => ({ attributes: { address, reserve_in_usd: reserve, volume_usd: { h24: "1" } }, relationships: { dex: { data: { id: "pump-fun" } } } })) });

const snapshot = (over: { report?: Payload; minute?: Payload } = {}): StoredTask =>
  task([over.minute ?? payload("candles-minute", 200, candles(flatMinutes())), over.report ?? payload("report", 200, report([[CREATOR, 600], ["u1", 400]]))]);
const token = (over: Partial<StoredToken> = {}): StoredToken => ({ mint: MINT, createdAt: T0, snapshot: snapshot(), path72: null, path30d: null, ...over });

describe("loadLabelInput: the first hour", () => {
  it("takes the scoring time from the first-hour report's fetch time, and the minute candles oldest first", () => {
    const r = loadLabelInput(token({ snapshot: snapshot({ report: payload("report", 200, report([["u1", 1000]]), { fetchedAt: S + 7 }) }) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.createdAt).toBe(T0);
    expect(r.input.scoredAt).toBe(S + 7);
    expect(r.input.minute).toHaveLength(60);
    expect(r.input.minute[0]).toEqual({ start: T0, open: 1, high: 1, low: 1, close: 1, volume: 10 });
    expect(r.input.minute[59]!.start).toBe(T0 + 59 * M);
  });

  it("takes the scoring time from a 404 report too: the source said it has nothing, and when it said so is still known", () => {
    const r = loadLabelInput(token({ snapshot: snapshot({ report: payload("report", 404, "{}", { fetchedAt: S + 3 }) }) }));
    expect(r.ok && r.input.scoredAt).toBe(S + 3);
  });

  it("says the first hour is missing when the snapshot was never planned, was missed, or is done with no report", () => {
    expect(loadLabelInput(token({ snapshot: null }))).toEqual({ ok: false, reason: "missing-first-hour" });
    expect(loadLabelInput(token({ snapshot: task([payload("candles-minute", 200, candles(flatMinutes()))], "missed") }))).toEqual({ ok: false, reason: "missing-first-hour" });
    expect(loadLabelInput(token({ snapshot: task([payload("candles-minute", 200, candles(flatMinutes()))], "done") }))).toEqual({ ok: false, reason: "missing-first-hour" });
  });

  it("says the first hour is missing when the snapshot was missed even though its report was saved (the candles are the part that failed)", () => {
    expect(loadLabelInput(token({ snapshot: task([payload("report", 200, report([["u1", 1000]]))], "missed") }))).toEqual({ ok: false, reason: "missing-first-hour" });
  });

  it("says the first hour is pending, not missing, while it has not been read yet", () => {
    expect(loadLabelInput(token({ snapshot: { ...snapshot(), status: "pending" } }))).toEqual({ ok: false, reason: "pending-first-hour" });
    expect(loadLabelInput(token({ snapshot: task([], "pending") }))).toEqual({ ok: false, reason: "pending-first-hour" });
  });

  it("reads no minute candles from a 404, from a payload marked invalid, or from a task without that step", () => {
    const empty = (minute: Payload | null): number => {
      const s = minute === null ? task([payload("report", 200, report([["u1", 1000]]))]) : snapshot({ minute });
      const r = loadLabelInput(token({ snapshot: s }));
      return r.ok ? r.input.minute.length : -1;
    };
    expect(empty(payload("candles-minute", 404, "{}"))).toBe(0);
    expect(empty(payload("candles-minute", 200, "<html>", { valid: false }))).toBe(0);
    expect(empty(null)).toBe(0);
  });

  it("is unreadable when the minute candles are not sane (a high below a low)", () => {
    expect(loadLabelInput(token({ snapshot: snapshot({ minute: payload("candles-minute", 200, candles([[T0, 1, 1, 2, 1, 1]])) }) }))).toEqual({ ok: false, reason: "unreadable-candles" });
  });

  it("is unreadable when the minute reply is not JSON although it was stored as valid", () => {
    expect(loadLabelInput(token({ snapshot: snapshot({ minute: payload("candles-minute", 200, "<html>") }) }))).toEqual({ ok: false, reason: "unreadable-candles" });
  });
});

describe("loadLabelInput: the creator", () => {
  const creatorAt = (r: Payload | null): bigint | null | "unknown" | "failed" => {
    const s = r === null ? task([payload("candles-minute", 200, candles(flatMinutes())), payload("report", 404, "{}")]) : snapshot({ report: r });
    const out = loadLabelInput(token({ snapshot: s }));
    return out.ok ? out.input.creatorAtScoring : "failed";
  };

  it("is what the creator's listed rows add up to at the scoring time", () => {
    expect(creatorAt(payload("report", 200, report([[CREATOR, 300], ["u1", 100], [CREATOR, 200]])))).toBe(500n);
  });

  it("is null when the creator is not listed, holds 0, is not named, or the report is a 404 or unreadable", () => {
    expect(creatorAt(payload("report", 200, report([["u1", 1000]])))).toBeNull();
    expect(creatorAt(payload("report", 200, report([[CREATOR, 0], ["u1", 1000]])))).toBeNull();
    expect(creatorAt(payload("report", 200, report([[CREATOR, 600]], null)))).toBeNull();
    expect(creatorAt(payload("report", 404, "{}"))).toBeNull();
    expect(creatorAt(payload("report", 200, "<html>"))).toBeNull();
    expect(creatorAt(null)).toBeNull();
  });
});

describe("loadLabelInput: the 72-hour and 30-day readings", () => {
  const p72 = (over: { report?: Payload; pools?: Payload[]; status?: StoredTask["status"] } = {}): StoredTask =>
    task([over.report ?? payload("report", 200, report([[CREATOR, 600], ["u1", 400]])), ...(over.pools ?? [payload("candles-hour:POOL", 200, candles(rugRows()))])], over.status ?? "done");

  it("has no hourly candles and an unknown creator report when the 72 hour reading was missed, still pending, or never planned", () => {
    for (const t of [null, task([], "missed"), task([], "pending")]) {
      const r = loadLabelInput(token({ path72: t }));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.input.hourly72).toBeNull();
      expect(r.input.creatorAt72h).toBe("unknown");
    }
  });

  it("reads each stored pool's hourly candles, keyed by the pool address, ignoring the other steps", () => {
    const r = loadLabelInput(
      token({ path72: p72({ pools: [payload("candles-hour:POOL", 200, candles(hourRows(2, 3, 1))), payload("candles-hour:OTHER", 200, candles(hourRows(2, 4, 2))), payload("token-pools", 200, poolsReply([["POOL", "5"]]))] }) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.hourly72!.map((p) => [p.pool, p.candles.length])).toEqual([["POOL", 2], ["OTHER", 3]]);
    expect(r.input.hourly72![1]!.candles[0]!.close).toBe(2);
  });

  it("ignores a candle step that is marked invalid", () => {
    const r = loadLabelInput(token({ path72: p72({ pools: [payload("candles-hour:BAD", 200, "<html>", { valid: false }), payload("candles-hour:POOL", 200, candles(hourRows(2, 3, 1)))] }) }));
    expect(r.ok && r.input.hourly72!.map((p) => p.pool)).toEqual(["POOL"]);
  });

  it("gives a pool with no candle data (404) as a pool with no candles, not as a missing reading", () => {
    const r = loadLabelInput(token({ path72: p72({ pools: [payload("candles-hour:POOL", 404, "{}")] }) }));
    expect(r.ok && r.input.hourly72).toEqual([{ pool: "POOL", candles: [] }]);
  });

  it("gives an empty list when the reading was done but stored no candle step at all", () => {
    const r = loadLabelInput(token({ path72: p72({ pools: [] }) }));
    expect(r.ok && r.input.hourly72).toEqual([]);
  });

  it("reads the creator's listed amount at 72 hours: null when no longer listed, unknown when the report is a 404 or unreadable", () => {
    const at = (rep: Payload): bigint | null | "unknown" | undefined => {
      const r = loadLabelInput(token({ path72: p72({ report: rep }) }));
      return r.ok ? r.input.creatorAt72h : undefined;
    };
    expect(at(payload("report", 200, report([[CREATOR, 950], ["u1", 50]])))).toBe(950n);
    expect(at(payload("report", 200, report([["u1", 1000]])))).toBeNull();
    expect(at(payload("report", 404, "{}"))).toBe("unknown");
    expect(at(payload("report", 200, "<html>"))).toBe("unknown");
  });

  it("uses the creator named at the first hour, not the one the later report names", () => {
    const r = loadLabelInput(token({ path72: p72({ report: payload("report", 200, report([[CREATOR, 777], ["other", 223]], "other")) }) }));
    expect(r.ok && r.input.creatorAt72h).toBe(777n);
  });

  it("is unreadable when a stored 72 hour candle reply is not sane", () => {
    expect(loadLabelInput(token({ path72: p72({ pools: [payload("candles-hour:POOL", 200, candles([[T0 + 2 * H, 1, 0, 2, 1, 1]]))] }) }))).toEqual({ ok: false, reason: "unreadable-candles" });
  });

  it("reads the 30 day candles and the pools' liquidity as numbers, and has neither when that reading was missed", () => {
    const done = loadLabelInput(token({ path30d: task([payload("report", 200, report([["u1", 1000]])), payload("token-pools", 200, poolsReply([["POOL", "1234.5"], ["AMM", null]])), payload("candles-hour:POOL", 200, candles(hourRows(2, 5, 1)))]) }));
    expect(done.ok && done.input.hourly30d!.map((p) => p.pool)).toEqual(["POOL"]);
    expect(done.ok && done.input.pools30d).toEqual([{ pool: "POOL", reserveUsd: 1234.5 }, { pool: "AMM", reserveUsd: null }]);
    const missed = loadLabelInput(token({ path30d: task([], "missed") }));
    expect(missed.ok && [missed.input.hourly30d, missed.input.pools30d]).toEqual([null, null]);
  });

  it("has no pools when the 30 day pools reply is a 404 or unreadable", () => {
    for (const bad of [payload("token-pools", 404, "{}"), payload("token-pools", 200, "<html>"), payload("token-pools", 200, '{"nothing":1}')]) {
      const r = loadLabelInput(token({ path30d: task([bad, payload("candles-hour:POOL", 200, candles(hourRows(2, 3, 1)))]) }));
      expect(r.ok && r.input.pools30d, bad.body).toBeNull();
      expect(r.ok && r.input.hourly30d).not.toBeNull();
    }
  });

  it("has no pools when the 30 day reading stored no pools step at all", () => {
    const r = loadLabelInput(token({ path30d: task([payload("candles-hour:POOL", 200, candles(hourRows(2, 3, 1)))]) }));
    expect(r.ok && r.input.pools30d).toBeNull();
  });
});

describe("labelStored: from stored replies to a label", () => {
  const rugged = (over: Partial<StoredToken> = {}): StoredToken => token({ path72: task([payload("report", 200, report([[CREATOR, 0], ["u1", 1000]])), payload("candles-hour:POOL", 200, candles(rugRows()))]), ...over });

  it("labels a collapse with no recovery as rugged", () => {
    expect(labelStored(rugged())).toMatchObject({ label: "rugged" });
  });

  it("does not call it a rug when the creator, listed at the first hour, still holds more than 90% of it at 72 hours", () => {
    const sat = rugged({ path72: task([payload("report", 200, report([[CREATOR, 560], ["u1", 440]])), payload("candles-hour:POOL", 200, candles(rugRows()))]) });
    expect(labelStored(sat)).toEqual({ label: "neither", reason: "no-recovery-with-creator-held" });
  });

  it("does call it a rug when the creator sold (is no longer listed) at 72 hours", () => {
    const sold = rugged({ path72: task([payload("report", 200, report([["u1", 1000]])), payload("candles-hour:POOL", 200, candles(rugRows()))]) });
    expect(labelStored(sold).label).toBe("rugged");
  });

  it("says the creator at 72 hours is unknown when that report is missing and the creator held tokens", () => {
    const unknown = rugged({ path72: task([payload("report", 404, "{}"), payload("candles-hour:POOL", 200, candles(rugRows()))]) });
    expect(labelStored(unknown)).toEqual({ label: "neither", reason: "creator-at-72h-unknown" });
  });

  it("reports a reading as missing when it was missed or never planned, and as pending while it is still to come", () => {
    expect(labelStored(token({ path72: task([], "missed") }))).toEqual({ label: "neither", reason: "missing-72h" });
    expect(labelStored(token({ path72: null }))).toEqual({ label: "neither", reason: "missing-72h" });
    expect(labelStored(token({ path72: task([], "pending") }))).toEqual({ label: "neither", reason: "pending-72h" });
  });

  it("does the same for the 30 day reading, once the 72 hour one is in and found no rug", () => {
    const flat = hourRows(2, 71, 1);
    const p72 = task([payload("report", 200, report([["u1", 1000]])), payload("candles-hour:POOL", 200, candles(flat))]);
    expect(labelStored(token({ path72: p72, path30d: task([], "pending") }))).toEqual({ label: "neither", reason: "pending-30d" });
    expect(labelStored(token({ path72: p72, path30d: task([], "missed") }))).toEqual({ label: "neither", reason: "missing-30d" });
    expect(labelStored(token({ path72: p72, path30d: null }))).toEqual({ label: "neither", reason: "missing-30d" });
  });

  it("a rug is a rug even while the 30 day reading is still to come", () => {
    expect(labelStored(rugged({ path30d: task([], "pending") })).label).toBe("rugged");
  });

  it("reports an unreadable candle reply and a missing first hour as neither, with the reason", () => {
    expect(labelStored(token({ snapshot: null }))).toEqual({ label: "neither", reason: "missing-first-hour" });
    expect(labelStored(token({ snapshot: snapshot({ minute: payload("candles-minute", 200, "<html>") }) }))).toEqual({ label: "neither", reason: "unreadable-candles" });
  });

  it("labels a token that held its price and its liquidity for 30 days as a survivor", () => {
    const flat = (k0: number, k1: number): number[][] => hourRows(k0, k1, 1);
    const alive = token({
      path72: task([payload("report", 200, report([["u1", 1000]])), payload("candles-hour:POOL", 200, candles(flat(2, 71)))]),
      path30d: task([payload("report", 200, report([["u1", 1000]])), payload("token-pools", 200, poolsReply([["POOL", "5000"]])), payload("candles-hour:POOL", 200, candles(flat(2, 719)))]),
    });
    expect(labelStored(alive)).toEqual({ label: "survived", reason: "traded and kept liquidity at 30 days" });
  });
});

describe("summarizeLabels", () => {
  it("counts every row once, by label and by reason, and keeps the reason of each neither", () => {
    const rows = [
      { mint: "a", createdAt: 1, label: "rugged" as const, reason: "x" },
      { mint: "b", createdAt: 2, label: "rugged" as const, reason: "x" },
      { mint: "c", createdAt: 3, label: "survived" as const, reason: "y" },
      { mint: "d", createdAt: 4, label: "neither" as const, reason: "missing-72h" },
      { mint: "e", createdAt: 5, label: "neither" as const, reason: "missing-72h" },
      { mint: "f", createdAt: 6, label: "neither" as const, reason: "faded" },
      { mint: "g", createdAt: 7, label: "collapsed-before-scoring" as const, reason: "z" },
    ];
    expect(summarizeLabels(rows)).toEqual({
      total: 7,
      byLabel: { rugged: 2, survived: 1, neither: 3, "collapsed-before-scoring": 1 },
      neitherByReason: { "missing-72h": 2, faded: 1 },
    });
  });

  it("is all zeros for nothing", () => {
    expect(summarizeLabels([])).toEqual({ total: 0, byLabel: { rugged: 0, survived: 0, neither: 0, "collapsed-before-scoring": 0 }, neitherByReason: {} });
  });
});
