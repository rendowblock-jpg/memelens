import { describe, expect, it } from "vitest";
import { analyze, type Analysis } from "../src/analyze";
import type { StoredTask, StoredToken } from "../src/load";
import type { Payload } from "../src/store";

// A small made-up world, built the way the collector stores it, so the whole pipeline runs: labels, the protocol-wallet census,
// the pick, the scoring through the real risk code, and the tally.
const M = 60_000;
const H = 3_600_000;
const T0 = 1_800_000_000_000;
const S = T0 + 61 * M;

const payload = (step: string, status: number, body: string): Payload => ({ step, url: "u", fetchedAt: S, status, valid: true, body });
const task = (payloads: Payload[], status: StoredTask["status"] = "done"): StoredTask => ({ status, payloads });
const candles = (rows: number[][]): string => JSON.stringify({ data: { attributes: { ohlcv_list: rows.map(([t, ...r]) => [t! / 1000, ...r]).reverse() } } });
const minutes = (price = 1): number[][] => Array.from({ length: 60 }, (_, m) => [T0 + m * M, price, price, price, price, 10]);
const hourRows = (k0: number, k1: number, price: number): number[][] => Array.from({ length: k1 - k0 + 1 }, (_, i) => [T0 + (k0 + i) * H, price, price, price, price, 100]);
const rugRows = (): number[][] => [...hourRows(2, 5, 1), [T0 + 6 * H, 1, 1, 0.05, 0.05, 100], ...hourRows(7, 71, 0.02)];
const pools = (reserve: string): string => JSON.stringify({ data: [{ attributes: { address: "POOL", reserve_in_usd: reserve, volume_usd: { h24: "1" } }, relationships: { dex: { data: { id: "pump-fun" } } } }] });

type Holders = Array<[string, number]>;
const report = (mint: string, holders: Holders, totalHolders = holders.length, supply = 1000, decimals = 0): string =>
  JSON.stringify({ mint, creator: "creator1", token: { supply, decimals }, topHolders: holders.map(([owner, amount]) => ({ owner, amount })), totalHolders, markets: [], mintAuthority: null, freezeAuthority: null });

const CONC: Holders = [["whale", 1000]];
const DISP: Holders = Array.from({ length: 20 }, (_, i) => [`h${i + 1}`, 50] as [string, number]);
const PW: Holders = [["PW", 1000]];
const TEN: Holders = Array.from({ length: 10 }, (_, i) => [`x${i + 1}`, 100] as [string, number]); // ten holders of a tenth each
const UNATTRIBUTED: Holders = [["u1", 500]]; // half the supply is in no field and no unlisted holder exists

type Kind = "rugged" | "survived" | "faded" | "collapsed";
/** Real tokens do not share holder addresses by accident: the dispersed holders get the token's name in front. */
const own = (mint: string, holders: Holders): Holders => holders.map(([o, a]) => (/^[htx]\d/.test(o) ? [`${mint}:${o}`, a] : [o, a]));

function world(mint: string, kind: Kind, holders: Holders = CONC, first: "report" | "404" = "report", report72: Payload = payload("report", 404, "{}")): StoredToken {
  const firstReport = first === "404" ? payload("report", 404, "{}") : payload("report", 200, report(mint, own(mint, holders)));
  const minute = kind === "collapsed" ? candles(minutes().map((r, i) => (i === 59 ? [r[0]!, 0.05, 0.05, 0.05, 0.05, 10] : r))) : candles(minutes());
  const snapshot = task([payload("candles-minute", 200, minute), firstReport]);
  if (kind === "collapsed") return { mint, createdAt: T0, snapshot, path72: task([], "missed"), path30d: task([], "missed") };
  if (kind === "rugged") return { mint, createdAt: T0, snapshot, path72: task([report72, payload("candles-hour:POOL", 200, candles(rugRows()))]), path30d: task([], "missed") };
  const reserve = kind === "faded" ? "10" : "5000";
  return {
    mint,
    createdAt: T0,
    snapshot,
    path72: task([payload("report", 404, "{}"), payload("candles-hour:POOL", 200, candles(hourRows(2, 71, 1)))]),
    path30d: task([payload("report", 404, "{}"), payload("token-pools", 200, pools(reserve)), payload("candles-hour:POOL", 200, candles(hourRows(2, 719, 1)))]),
  };
}

const must = (r: ReturnType<typeof analyze>): Analysis => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
};

// 5 rugged: three concentrated, one dispersed, one with no readable first-hour report. 4 survivors: one concentrated, three dispersed.
const standard = (): StoredToken[] => [
  world("rug-1", "rugged", CONC),
  world("rug-2", "rugged", CONC),
  world("rug-3", "rugged", CONC),
  world("rug-4", "rugged", DISP),
  world("rug-5", "rugged", CONC, "404"),
  world("sur-1", "survived", CONC),
  world("sur-2", "survived", DISP),
  world("sur-3", "survived", DISP),
  world("sur-4", "survived", DISP),
  world("fad-1", "faded", DISP),
  world("fad-2", "faded", CONC),
  world("col-1", "collapsed", CONC),
];

describe("analyze: labels, pick and tally", () => {
  it("counts every token by label and keeps the neither and collapsed ones out of both groups", () => {
    const a = must(analyze(standard()));
    expect(a.labels.byLabel).toEqual({ rugged: 5, survived: 4, neither: 2, "collapsed-before-scoring": 1 });
    expect(a.labels.neitherByReason).toEqual({ faded: 2 });
    expect(a.rugged.available).toBe(5);
    expect(a.survived.available).toBe(4);
  });

  it("tallies how many of each group were flagged high or critical, left at medium or below, or unknown", () => {
    const a = must(analyze(standard()));
    expect(a.rugged.all).toEqual({ n: 5, flagged: 3, left: 1, unknown: 1 });
    expect(a.survived.all).toEqual({ n: 4, flagged: 1, left: 3, unknown: 0 });
    expect(a.rugged.bySupply).toEqual({ "below 1.5B": 4, "1.5B or more": 0, "no report": 1 });
    expect(a.survived.bySupply).toEqual({ "below 1.5B": 4, "1.5B or more": 0, "no report": 0 });
  });

  it("reports each picked token with its level, score, coverage and the quality of its snapshot", () => {
    const a = must(analyze(standard()));
    const byMint = new Map(a.rugged.picked.map((p) => [p.mint, p]));
    expect(byMint.get("rug-1")).toMatchObject({ label: "rugged", level: "high", quality: "exact" });
    expect(byMint.get("rug-1")!.score).toBeGreaterThan(50);
    expect(byMint.get("rug-1")!.coverage).toBeCloseTo(0.57, 2);
    expect(byMint.get("rug-4")).toMatchObject({ level: expect.stringMatching(/^(low|medium)$/), quality: "exact" });
    expect(byMint.get("rug-5")).toEqual({ mint: "rug-5", label: "rugged", level: "unknown", score: null, coverage: null, quality: "no-report", supplyTokens: null });
  });

  it("takes the smaller number of tokens when asked, by the pick key, and scores only those", () => {
    const a = must(analyze(standard(), { groupSize: 2 }));
    expect(a.rugged.picked.map((p) => p.mint)).toEqual(["rug-2", "rug-3"]); // sha256 order, computed independently
    expect(a.survived.picked.map((p) => p.mint)).toEqual(["sur-1", "sur-2"]);
    expect(a.rugged.available).toBe(5);
    expect(a.survived.available).toBe(4);
    expect(a.rugged.all.n).toBe(2);
    expect(a.scored).toBe(4);
  });

  it("gives the same answer whatever order the tokens come in", () => {
    const one = analyze(standard());
    const two = analyze([...standard()].reverse());
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it("accepts a generator, not only an array (so a large state file is never held whole)", () => {
    function* gen(): Generator<StoredToken> {
      yield* standard();
    }
    expect(JSON.stringify(analyze(gen()))).toBe(JSON.stringify(analyze(standard())));
  });

  it("is a result with nothing in it for no tokens at all", () => {
    const a = must(analyze([]));
    expect(a.labels.total).toBe(0);
    expect(a.rugged.all).toEqual({ n: 0, flagged: 0, left: 0, unknown: 0 });
    expect(a.survived.picked).toEqual([]);
  });
});

describe("analyze: what counts as flagged and what as left", () => {
  it("counts critical as flagged: a creator that held everything and then sold", () => {
    const sold = world("rug-c", "rugged", [["creator1", 1000]], "report", payload("report", 200, report("rug-c", [["someone", 1000]])));
    const a = must(analyze([sold]));
    expect(a.rugged.picked[0]).toMatchObject({ level: "critical", label: "rugged" });
    expect(a.rugged.all).toEqual({ n: 1, flagged: 1, left: 0, unknown: 0 });
  });

  it("counts high as flagged, low and medium as left, in both groups", () => {
    const a = must(analyze([world("sur-1", "survived", CONC), world("sur-2", "survived", DISP), world("sur-3", "survived", TEN)]));
    const level = (m: string) => a.survived.picked.find((p) => p.mint === m)!.level;
    expect([level("sur-1"), level("sur-2"), level("sur-3")]).toEqual(["high", "low", "medium"]);
    expect(a.survived.all).toEqual({ n: 3, flagged: 1, left: 2, unknown: 0 });
  });
});

describe("analyze: the defaults", () => {
  it("takes 30 from each group when no size is given", () => {
    const many = Array.from({ length: 31 }, (_, i) => world(`rug-${i + 1}`, "rugged", CONC));
    const a = must(analyze(many));
    expect(a.rugged.available).toBe(31);
    expect(a.rugged.picked).toHaveLength(30);
    expect(a.scored).toBe(30);
  });

  it("asks for 100 readable reports before it runs the census", () => {
    const a = must(analyze(standard()));
    expect(a.census).toEqual({ readable: 11, used: false, wallets: [] });
  });

  it("treats a first-hour report that names another token as no report", () => {
    const wrong: StoredToken = { ...world("sur-1", "survived"), snapshot: task([payload("candles-minute", 200, candles(minutes())), payload("report", 200, report("SOMEONE-ELSE", CONC))]) };
    const a = must(analyze([wrong]));
    expect(a.survived.picked[0]).toMatchObject({ level: "unknown", quality: "no-report" });
    expect(a.census.readable).toBe(0);
  });

  it("keeps the order of the neither reasons the same whatever order the tokens come in", () => {
    const gap = (m: string): StoredToken => ({ ...world(m, "survived"), path72: task([], "missed"), path30d: task([], "missed") });
    const tokens = [world("fad-1", "faded"), gap("gap-1")];
    const one = must(analyze(tokens));
    const two = must(analyze([...tokens].reverse()));
    expect(JSON.stringify(one.labels)).toBe(JSON.stringify(two.labels));
    expect(Object.keys(one.labels.neitherByReason)).toEqual(Object.keys(two.labels.neitherByReason));
  });
});

describe("analyze: it will not give a result while a reading is still to come", () => {
  it("refuses, and says how many tokens are still waiting, when any reading is pending", () => {
    const waiting: StoredToken = { ...world("wait-1", "survived"), path30d: task([], "pending") };
    const r = analyze([...standard(), waiting, { ...world("wait-2", "rugged"), path72: task([], "pending") }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/2 token/);
    expect(!r.ok && r.reason).toMatch(/pending/);
  });

  it("refuses for a pending first hour too", () => {
    const r = analyze([{ ...world("wait-1", "survived"), snapshot: task([], "pending") }]);
    expect(r.ok).toBe(false);
  });

  it("does not mind a reading that was missed or never planned", () => {
    const r = analyze([world("col-1", "collapsed"), { mint: "plain", createdAt: T0, snapshot: null, path72: null, path30d: null }]);
    expect(r.ok).toBe(true);
  });
});

describe("analyze: the protocol-wallet census", () => {
  // 11 tokens whose only holder is the protocol wallet "PW" (a quarter or more of them), the rest dispersed
  const withWallet = (): StoredToken[] => [
    world("rug-1", "rugged", PW),
    world("rug-2", "rugged", PW),
    world("rug-3", "rugged", DISP),
    world("sur-1", "survived", PW),
    world("sur-2", "survived", DISP),
    world("sur-3", "survived", DISP),
    world("fad-1", "faded", PW), // not in either group, but it still counts in the census
    world("fad-2", "faded", DISP),
    world("fad-3", "faded", DISP),
    world("col-1", "collapsed", DISP),
    world("col-2", "collapsed", DISP),
  ];

  it("is skipped under the minimum number of readable reports, and the wallet then counts as a holder (flagged)", () => {
    const a = must(analyze(withWallet(), { minCensus: 12 }));
    expect(a.census).toEqual({ readable: 11, used: false, wallets: [] });
    expect(a.rugged.all).toEqual({ n: 3, flagged: 2, left: 1, unknown: 0 });
    expect(a.survived.all).toEqual({ n: 3, flagged: 1, left: 2, unknown: 0 });
  });

  it("is used from the minimum on, counts every readable report (also tokens in neither group), and takes the wallet out: nobody is left to score", () => {
    const a = must(analyze(withWallet(), { minCensus: 11 }));
    expect(a.census).toEqual({ readable: 11, used: true, wallets: ["PW"] });
    expect(a.rugged.all).toEqual({ n: 3, flagged: 0, left: 1, unknown: 2 });
    expect(a.survived.all).toEqual({ n: 3, flagged: 0, left: 2, unknown: 1 });
  });

  it("lists several protocol wallets in one fixed order, whichever was met first", () => {
    const two = [world("a-1", "survived", [["PW2", 1000]]), world("a-2", "survived", [["PW2", 1000]]), world("b-1", "survived", [["PW1", 1000]]), world("b-2", "survived", [["PW1", 1000]])];
    expect(must(analyze(two, { minCensus: 4 })).census.wallets).toEqual(["PW1", "PW2"]);
  });

  it("does not count a 404 as a readable report", () => {
    const tokens = [...withWallet(), world("sur-9", "survived", PW, "404")];
    expect(must(analyze(tokens, { minCensus: 12 })).census).toMatchObject({ readable: 11, used: false });
  });
});

describe("analyze: the second reading, snapshots that can be trusted", () => {
  it("also tallies the picked tokens whose snapshot is exact or estimated, apart from the rest", () => {
    const tokens = [...standard(), world("sur-5", "survived", UNATTRIBUTED)];
    const a = must(analyze(tokens));
    expect(a.survived.all).toEqual({ n: 5, flagged: 2, left: 3, unknown: 0 });
    expect(a.survived.wellFormed).toEqual({ n: 4, flagged: 1, left: 3, unknown: 0 });
    expect(a.survived.picked.find((p) => p.mint === "sur-5")!.quality).toBe("unattributed");
    expect(a.rugged.wellFormed).toEqual({ n: 4, flagged: 3, left: 1, unknown: 0 }); // rug-5 has no report: not well formed
  });

  it("calls a snapshot with unlisted holders (estimated) well formed", () => {
    const tail: Holders = Array.from({ length: 20 }, (_, i) => [`t${i + 1}`, 40] as [string, number]); // 800 of 1000 listed, 5 more holders share the rest
    const tokens = [world("sur-1", "survived", tail)].map((t) => ({ ...t, snapshot: task([t.snapshot!.payloads[0]!, payload("report", 200, report("sur-1", own("sur-1", tail), 25))]) }));
    const a = must(analyze(tokens));
    expect(a.survived.picked[0]!.quality).toBe("estimated");
    expect(a.survived.wellFormed.n).toBe(1);
  });
});

describe("analyze: what the picked tokens are made of", () => {
  const big = (mint: string, supply: number): StoredToken => {
    const t = world(mint, "survived", [["whale", supply]]);
    return { ...t, snapshot: task([t.snapshot!.payloads[0]!, payload("report", 200, report(mint, [["whale", supply]], 1, supply))]) };
  };

  it("counts the picked tokens by supply, below or at 1.5 billion, and those with no report", () => {
    const a = must(analyze([big("sur-1", 1_000_000_000), big("sur-2", 2_000_000_000), big("sur-3", 2_000_000_000), big("sur-4", 1_499_999_999), big("sur-5", 1_500_000_000), world("sur-6", "survived", CONC, "404")]));
    expect(a.survived.bySupply).toEqual({ "below 1.5B": 2, "1.5B or more": 3, "no report": 1 });
    expect(a.survived.picked.find((p) => p.mint === "sur-2")!.supplyTokens).toBe(2_000_000_000);
    expect(a.survived.picked.find((p) => p.mint === "sur-6")!.supplyTokens).toBeNull();
  });

  it("reads the supply in tokens, not in raw units: a 1-billion-token supply with 6 decimals is 10^15 raw and still below 1.5B", () => {
    const t = world("sur-1", "survived", [["whale", 1e15]]);
    const six: StoredToken = { ...t, snapshot: task([t.snapshot!.payloads[0]!, payload("report", 200, report("sur-1", [["whale", 1e15]], 1, 1e15, 6))]) };
    const a = must(analyze([six]));
    expect(a.survived.picked[0]!.supplyTokens).toBe(1_000_000_000);
    expect(a.survived.bySupply).toEqual({ "below 1.5B": 1, "1.5B or more": 0, "no report": 0 });
    const two = { ...t, snapshot: task([t.snapshot!.payloads[0]!, payload("report", 200, report("sur-1", [["whale", 2e15]], 1, 2e15, 6))]) };
    expect(must(analyze([two])).survived.bySupply).toEqual({ "below 1.5B": 0, "1.5B or more": 1, "no report": 0 });
  });

  it("counts only the picked ones, not every token that has the label", () => {
    const tokens = Array.from({ length: 5 }, (_, i) => big(`sur-${i + 1}`, 2_000_000_000));
    const a = must(analyze(tokens, { groupSize: 2 }));
    expect(a.survived.bySupply).toEqual({ "below 1.5B": 0, "1.5B or more": 2, "no report": 0 });
  });
});
