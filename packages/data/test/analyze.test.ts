import { analyzeConcentration, computePnl, rankSmartMoney, scoreRisk, type Mark, type Trade } from "@memelens/core";
import { afterEach, describe, expect, it } from "vitest";
import { smartMoney, tokenConcentration, tokenRisk, walletPnl } from "../src/analyze";
import { ingest } from "../src/ingest";
import { ReplayAdapter, type ReplayData } from "../src/replay";
import { Store } from "../src/store";
import type { TradeEvent } from "../src/types";
import { snap, tok, trade } from "./helpers";

const opened: Store[] = [];
async function load(data: ReplayData): Promise<Store> {
  const s = Store.open(":memory:");
  opened.push(s);
  await ingest(s, new ReplayAdapter(data), { now: 1 });
  return s;
}
afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

const C = "solana";

function scenario(): ReplayData {
  return {
    chain: C,
    tokens: [
      tok("A", { createdAt: 1000, creator: "CRE", mintAuthorityActive: true, freezeAuthorityActive: false, excluded: ["POOL"] }),
      tok("B", { createdAt: 2000 }),
      tok("C", { createdAt: 3000 }),
    ],
    trades: [
      trade("t1", { time: 2000, wallet: "w1", token: "A", side: "buy", amount: 100n, quote: 1000n }),
      trade("t2", { time: 3000, wallet: "w1", token: "A", side: "sell", amount: 40n, quote: 600n }),
      trade("t3", { time: 4000, wallet: "w2", token: "A", side: "buy", amount: 10n, quote: 200n }),
      trade("t4", { time: 5000, wallet: "w1", token: "A", side: "buy", amount: 5n, quote: 0n }),
      trade("t5", { time: 2500, wallet: "w1", token: "B", side: "buy", amount: 50n, quote: 500n }),
      trade("t6", { time: 3500, wallet: "w3", token: "C", side: "buy", amount: 9n, quote: 0n }),
    ],
    snapshots: [
      snap("A", 3000, [["CRE", 300n], ["w1", 60n], ["POOL", 600n], ["w9", 40n]]),
      snap("A", 6000, [["CRE", 100n], ["w1", 65n], ["POOL", 700n], ["w2", 135n]]),
    ],
  };
}

// ----- independent oracles: they work on the raw ReplayData, never through the store -----------

function toCore(t: TradeEvent): Trade {
  return { id: t.id, time: t.time, token: t.token, side: t.side, amount: t.amount, quote: t.quote, fee: t.fee };
}

function oracleMarks(data: ReplayData, asOf: number): Map<string, Mark> {
  const marks = new Map<string, Mark>();
  const sorted = [...data.trades].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
  for (const t of sorted) if (t.time <= asOf && t.quote > 0n) marks.set(t.token, { amount: t.amount, quote: t.quote });
  return marks;
}

function oraclePnl(data: ReplayData, wallet: string, asOf?: number) {
  const limit = asOf ?? Infinity;
  const mine = data.trades.filter((t) => t.wallet === wallet && t.time <= limit).map(toCore);
  const tokens = new Set(mine.map((t) => t.token));
  const all = oracleMarks(data, limit);
  const marks = new Map([...all].filter(([k]) => tokens.has(k)));
  return computePnl(mine, { ...(asOf === undefined ? {} : { asOf }), marks });
}

describe("walletPnl", () => {
  it("matches hand-computed FIFO numbers over the whole history", async () => {
    const store = await load(scenario());
    const r = walletPnl(store, C, "w1");
    const a = r.tokens.find((t) => t.token === "A")!;
    // bought 100@1000 then 5@0; sold 40 for 600 -> realised 600 - 400 = 200; open 60@600 + 5@0
    expect(a.realised).toBe(200n);
    expect(a.openAmount).toBe(65n);
    expect(a.openCost).toBe(600n);
    // mark = last non-zero-quote trade (t3: 10 for 200 -> 20 per unit), so 65 * 20 = 1300; 1300 - 600
    expect(a.unrealised).toBe(700n);
    const b = r.tokens.find((t) => t.token === "B")!;
    expect(b.unrealised).toBe(0n); // marked at its own only trade
    expect(r.totals.realised).toBe(200n);
    expect(r.totals.unrealised).toBe(700n);
    expect(r.totals.unmarkedTokens).toEqual([]);
  });

  it("asOf cuts history and the mark moves back with it", async () => {
    const store = await load(scenario());
    const r = walletPnl(store, C, "w1", { asOf: 3500 });
    const a = r.tokens.find((t) => t.token === "A")!;
    expect(a.openAmount).toBe(60n);
    expect(a.realised).toBe(200n);
    // last non-zero trade at or before 3500 is t2 (40 for 600 -> 15 per unit): 60 * 15 = 900; 900 - 600
    expect(a.unrealised).toBe(300n);
    expect(r.tokens.map((t) => t.token)).toEqual(["A", "B"]);
    expect(walletPnl(store, C, "w1", { asOf: 1999 }).tokens).toEqual([]);
  });

  it("a token with only zero-quote trades has no mark and is listed as unmarked", async () => {
    const store = await load(scenario());
    const r = walletPnl(store, C, "w3");
    expect(r.tokens[0]!.unrealised).toBeNull();
    expect(r.totals.unmarkedTokens).toEqual(["C"]);
  });

  it("an unknown wallet has an empty report", async () => {
    const store = await load(scenario());
    const r = walletPnl(store, C, "nobody");
    expect(r.tokens).toEqual([]);
    expect(r.totals.realised).toBe(0n);
    expect(r.totals.unrealised).toBe(0n);
  });

  it("agrees with computePnl run directly on the raw data, for every wallet and several times", async () => {
    const data = scenario();
    const store = await load(data);
    for (const w of ["w1", "w2", "w3", "nobody"]) {
      for (const asOf of [undefined, 1500, 2500, 3000, 3500, 4000, 5000, 9999]) {
        const got = walletPnl(store, C, w, asOf === undefined ? {} : { asOf });
        expect(got).toEqual(oraclePnl(data, w, asOf));
      }
    }
  });
});

describe("tokenConcentration", () => {
  it("uses the newest snapshot at or before asOf, excludes pool addresses, and reports its age", async () => {
    const store = await load(scenario());
    const r = tokenConcentration(store, C, "A", 5999)!;
    expect(r.snapshotTime).toBe(3000);
    expect(r.snapshotAgeMs).toBe(2999);
    expect(r.concentration.holders).toBe(3); // CRE, w1, w9 (POOL excluded)
    expect(r.concentration.total).toBe(400n);
    expect(r.concentration.topShare[1]).toBe(0.75);
  });

  it("moves to the later snapshot once asOf reaches it", async () => {
    const store = await load(scenario());
    const r = tokenConcentration(store, C, "A", 6000)!;
    expect(r.snapshotTime).toBe(6000);
    expect(r.snapshotAgeMs).toBe(0);
    expect(r.concentration.total).toBe(300n);
    expect(r.concentration.topShare[1]).toBe(0.45);
  });

  it("is null when there is no snapshot yet, no snapshot at all, or the token is unknown", async () => {
    const d = scenario();
    d.snapshots.push(snap("ZZ", 100, [["x", 1n]]));
    const store = await load(d);
    expect(tokenConcentration(store, C, "A", 2999)).toBeNull();
    expect(tokenConcentration(store, C, "B", 9999)).toBeNull();
    expect(tokenConcentration(store, C, "ZZ", 9999)).toBeNull(); // snapshot exists, token info does not
  });

  it("is null before the token existed, even if a (bad) snapshot is dated earlier", async () => {
    const d = scenario();
    d.snapshots.push(snap("B", 1500, [["w1", 5n]])); // token B is created at 2000
    const store = await load(d);
    expect(tokenConcentration(store, C, "B", 1999)).toBeNull();
    expect(tokenConcentration(store, C, "B", 2000)!.snapshotTime).toBe(1500);
  });

  it("equals analyzeConcentration run directly", async () => {
    const store = await load(scenario());
    const r = tokenConcentration(store, C, "A", 6500)!;
    expect(r.concentration).toEqual(
      analyzeConcentration(scenario().snapshots[1]!.holdings, { exclude: new Set(["POOL"]) }),
    );
  });
});

describe("tokenRisk", () => {
  it("builds the risk input from stored facts and scores it with the core", async () => {
    const store = await load(scenario());
    const r = tokenRisk(store, C, "A", 5999)!;
    const expectedInput = {
      concentration: analyzeConcentration(scenario().snapshots[0]!.holdings, { exclude: new Set(["POOL"]) }),
      creatorShare: 0.75,
      mintAuthorityActive: true,
      freezeAuthorityActive: false,
      ageMs: 4999,
    };
    expect(r.input).toEqual(expectedInput);
    expect(r.report).toEqual(scoreRisk(expectedInput));
    expect(r.snapshotTime).toBe(3000);
    expect(r.report.hardFlags).toContain("mintAuthority");
    expect(["high", "critical"]).toContain(r.report.level);
  });

  it("says which signals are unknown and why", async () => {
    const store = await load(scenario());
    const r = tokenRisk(store, C, "A", 5999)!;
    expect(Object.keys(r.unavailable).sort()).toEqual(["clustering", "creatorDumps", "liquidity", "washTrading"]);
    for (const reason of Object.values(r.unavailable)) expect(reason!.length).toBeGreaterThan(5);
    const known = r.report.signals.filter((s) => s.known).map((s) => s.id).sort();
    expect(known).toEqual(["age", "creatorShare", "freezeAuthority", "hhi", "mintAuthority", "top10Share"]);
  });

  it("without a snapshot or authority facts, only age is known and the level is unknown (never 'safe')", async () => {
    const store = await load(scenario());
    const r = tokenRisk(store, C, "B", 5999)!;
    expect(r.input).toEqual({ ageMs: 3999 });
    expect(r.snapshotTime).toBeNull();
    expect(r.report.level).toBe("unknown");
    expect(r.unavailable.top10Share).toMatch(/snapshot/i);
    expect(r.unavailable.hhi).toMatch(/snapshot/i);
    expect(r.unavailable.creatorShare).toMatch(/snapshot|creator/i);
    expect(r.unavailable.mintAuthority).toMatch(/mint/i);
    expect(r.unavailable.freezeAuthority).toMatch(/freeze/i);
  });

  it("explains an unknown creator separately from a missing snapshot", async () => {
    const d = scenario();
    d.snapshots.push(snap("B", 2500, [["w1", 10n]]));
    const store = await load(d);
    const r = tokenRisk(store, C, "B", 5999)!;
    expect(r.input.concentration).toBeDefined();
    expect(r.input.creatorShare).toBeUndefined();
    expect(r.unavailable.creatorShare).toMatch(/creator/i);
    expect(r.unavailable.top10Share).toBeUndefined();
  });

  it("treats a creator who holds nothing in the snapshot as 0% (known), not as unknown", async () => {
    const d = scenario();
    d.tokens.push(tok("D", { createdAt: 1500, creator: "X" }));
    d.snapshots.push(snap("D", 1600, [["w1", 10n], ["w2", 30n]]));
    const store = await load(d);
    const r = tokenRisk(store, C, "D", 2000)!;
    expect(r.input.creatorShare).toBe(0);
  });

  it("a snapshot with no countable holders says nothing: concentration and creator share stay unknown", async () => {
    const d = scenario();
    d.tokens.push(tok("E", { createdAt: 1500, creator: "X", excluded: ["POOL"] }));
    d.snapshots.push(snap("E", 1600, [["POOL", 1000n], ["w1", 0n]]));
    const store = await load(d);
    const r = tokenRisk(store, C, "E", 2000)!;
    expect(r.input.concentration).toBeUndefined();
    expect(r.input.creatorShare).toBeUndefined();
    expect(r.unavailable.top10Share).toMatch(/holder/i);
    expect(r.unavailable.hhi).toMatch(/holder/i);
    expect(r.unavailable.creatorShare).toMatch(/holder/i);
    expect(r.report.signals.find((s) => s.id === "top10Share")!.known).toBe(false);
    // the snapshot was used, so it is still reported
    expect(r.snapshotTime).toBe(1600);
  });

  it("a creator that is on the token's non-holder list gives an unknown creator share, not a wrong one", async () => {
    const d = scenario();
    d.tokens.push(tok("F", { createdAt: 1500, creator: "POOL", excluded: ["POOL"] }));
    d.snapshots.push(snap("F", 1600, [["POOL", 1000n], ["w1", 10n]]));
    const store = await load(d);
    const r = tokenRisk(store, C, "F", 2000)!;
    expect(r.input.creatorShare).toBeUndefined();
    expect(r.unavailable.creatorShare).toMatch(/non-holder/i);
    expect(r.input.concentration!.topShare[1]).toBe(1); // only w1 is counted; the pool is excluded
  });

  it("age is asOf minus creation time, and 0 at the moment of creation", async () => {
    const store = await load(scenario());
    expect(tokenRisk(store, C, "A", 1000)!.input.ageMs).toBe(0);
    expect(tokenRisk(store, C, "A", 1001)!.input.ageMs).toBe(1);
  });

  it("is null before the token exists and for unknown tokens", async () => {
    const store = await load(scenario());
    expect(tokenRisk(store, C, "A", 999)).toBeNull();
    expect(tokenRisk(store, C, "NOPE", 5000)).toBeNull();
  });

  it("does not use a snapshot taken after asOf", async () => {
    const store = await load(scenario());
    const r = tokenRisk(store, C, "A", 5000)!;
    expect(r.snapshotTime).toBe(3000);
  });
});

describe("smartMoney", () => {
  it("returns exactly what rankSmartMoney gives for the raw data (wallets with a trade up to `to`)", async () => {
    const data = randomData(7);
    const store = await load(data);
    for (const opts of [
      { from: 2000, to: 9000, minClosedTokens: 1 },
      { from: 0, to: 11000, minClosedTokens: 2 },
      { from: 4000, to: 6000 },
    ]) {
      const byWallet = new Map<string, Trade[]>();
      for (const t of data.trades) {
        if (t.time > opts.to) continue;
        const list = byWallet.get(t.wallet) ?? [];
        list.push(toCore(t));
        byWallet.set(t.wallet, list);
      }
      const expected = rankSmartMoney(
        [...byWallet].sort(([a], [b]) => (a < b ? -1 : 1)).map(([address, trades]) => ({ address, trades })),
        opts,
      );
      expect(smartMoney(store, C, opts)).toEqual(expected);
    }
  });

  it("never mentions a wallet whose first trade is after the window", async () => {
    const d = scenario();
    d.trades.push(trade("late", { time: 99000, wallet: "latecomer", token: "A" }));
    const store = await load(d);
    const r = smartMoney(store, C, { from: 0, to: 6000, minClosedTokens: 1 });
    const names = [...r.ranked, ...r.unranked].map((w) => w.address);
    expect(names).not.toContain("latecomer");
    expect(names).toContain("w1");
  });
});

describe("no look-ahead: analysing at T over all data == analysing over data that stops at T", () => {
  const WALLETS = ["w1", "w2", "w3", "w4", "w5", "w6"];
  const TOKENS = ["A", "B", "C", "D"];

  function everything(store: Store, asOf: number) {
    return {
      pnl: WALLETS.map((w) => walletPnl(store, C, w, { asOf })),
      conc: TOKENS.map((t) => tokenConcentration(store, C, t, asOf)),
      risk: TOKENS.map((t) => tokenRisk(store, C, t, asOf)),
      smart: smartMoney(store, C, { from: 0, to: asOf, minClosedTokens: 1 }),
    };
  }

  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}`, async () => {
      const data = randomData(seed);
      const full = await load(data);
      for (const asOf of [1000, 2500, 4000, 6000, 8500, 11000]) {
        const cut = await load({ ...data, ...(await truncated(data, asOf)) });
        expect(everything(full, asOf)).toEqual(everything(cut, asOf));
      }
    });
  }

  it("the check has teeth: the answers really do change over time", async () => {
    const store = await load(randomData(1));
    expect(everything(store, 2500)).not.toEqual(everything(store, 8500));
  });
});

async function truncated(data: ReplayData, asOf: number): Promise<Pick<ReplayData, "tokens" | "trades" | "snapshots">> {
  const view = new ReplayAdapter(data).withClock(asOf);
  return { tokens: await view.listTokens(), trades: await view.listTrades(), snapshots: await view.listSnapshots() };
}

function randomData(seed: number): ReplayData {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const wallets = ["w1", "w2", "w3", "w4", "w5", "w6"];
  const names = ["A", "B", "C", "D"];
  const created = (i: number) => 500 + i * 2500;
  const flags: Array<[boolean | null, boolean | null]> = [[true, false], [false, false], [null, null], [true, null]];
  const tokens = names.map((n, i) =>
    tok(n, { createdAt: created(i), creator: i === 0 ? "w1" : null, mintAuthorityActive: flags[i]![0], freezeAuthorityActive: flags[i]![1], excluded: ["POOL"] }),
  );
  const trades: TradeEvent[] = [];
  for (let i = 0; i < 150; i++) {
    const ti = Math.floor(rnd() * 4);
    trades.push(
      trade(`r${String(i).padStart(3, "0")}`, {
        time: created(ti) + 1 + Math.floor(rnd() * (10500 - created(ti))),
        wallet: wallets[Math.floor(rnd() * wallets.length)]!,
        token: names[ti]!,
        side: rnd() < 0.6 ? "buy" : "sell",
        amount: BigInt(1 + Math.floor(rnd() * 1000)),
        quote: BigInt(Math.floor(rnd() * 5000)),
        fee: BigInt(Math.floor(rnd() * 5)),
      }),
    );
  }
  const snapshots = names.flatMap((n, i) =>
    [500, 3000, 6000].map((off) =>
      snap(n, created(i) + off, [...wallets, "POOL"].map((w): [string, bigint] => [w, BigInt(Math.floor(rnd() * 1000))])),
    ),
  );
  return { chain: C, tokens, trades, snapshots };
}

// ----- the time cut is enforced twice (store query + core function); each layer must hold on its own -------

/**
 * Wraps a store so a test can see which trades `tradesForWallet` handed back, and can make it leak:
 * with `leak: true` it ignores the time limit it was given and returns the wallet's whole history.
 */
function tapped(store: Store, options: { leak?: boolean } = {}): { store: Store; fetchedTimes: number[] } {
  const fetchedTimes: number[] = [];
  const wrapper = new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "tradesForWallet") {
        return (chain: string, wallet: string, asOf?: number) => {
          const rows = target.tradesForWallet(chain, wallet, options.leak === true ? undefined : asOf);
          for (const r of rows) fetchedTimes.push(r.time);
          return rows;
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { store: wrapper, fetchedTimes };
}

describe("the time cut holds in each layer on its own", () => {
  it("walletPnl never pulls a trade after asOf out of the store", async () => {
    const { store, fetchedTimes } = tapped(await load(scenario()));
    walletPnl(store, C, "w1", { asOf: 3500 });
    expect(fetchedTimes.length).toBeGreaterThan(0);
    expect(Math.max(...fetchedTimes)).toBeLessThanOrEqual(3500);
  });

  it("walletPnl still cuts at asOf if the store were to hand back later trades", async () => {
    const base = await load(scenario());
    const honest = walletPnl(base, C, "w1", { asOf: 3500 });
    const leaky = tapped(base, { leak: true });
    const result = walletPnl(leaky.store, C, "w1", { asOf: 3500 });
    expect(Math.max(...leaky.fetchedTimes)).toBeGreaterThan(3500); // the leak is real, so this test can fail
    expect(result).toEqual(honest);
  });

  it("smartMoney never pulls a trade after `to` out of the store", async () => {
    const { store, fetchedTimes } = tapped(await load(scenario()));
    smartMoney(store, C, { from: 0, to: 3500, minClosedTokens: 1 });
    expect(fetchedTimes.length).toBeGreaterThan(0);
    expect(Math.max(...fetchedTimes)).toBeLessThanOrEqual(3500);
  });
});
