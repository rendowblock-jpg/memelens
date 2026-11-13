import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeConcentration } from "@memelens/core";
import { ingest, parseFixture, ReplayAdapter, Store, tokenRisk } from "@memelens/data";
import {
  buildFixture,
  exportFromStored,
  largestCountedOwner,
  parseReport,
  protocolWallets,
  PUMP_RESERVE_TOKENS,
  ReportError,
  snapshotFromReport,
  type ReportView,
  type StoredReport,
} from "../src/export";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const view = (name: string): ReportView => parseReport(read(name));
const NAMES = readdirSync(FIXTURES).filter((n) => /^rugcheck-(young-.*|report-established)\.json$/.test(n)).sort();

// Expected values come from test/reference/export_reference.py: a second implementation in another language that shares
// no code with src/export.ts (regenerate: python3 export_reference.py --all ../fixtures > expected.json).
interface Expected {
  quality: string;
  listed: number;
  tailHolders: number;
  curveUnlisted: number;
  remainder: number;
  countedHolders: number;
  countedTotal: number;
  top10Share: number | null;
  top1Share: number | null;
  hhi: number | null;
  creatorShare: number | null;
}
const EXPECTED = read("../reference/expected.json") as {
  protocolWallets: string[];
  reports: Record<string, { withoutProtocolWallets: Expected; withProtocolWallets: Expected }>;
};
const BWWK = "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s";

describe("parseReport on real RugCheck replies", () => {
  it("reads the numbers of a 2-billion-token report that has its curve listed", () => {
    const v = view("rugcheck-young-curve-listed-2b.json");
    expect(v.mint).toBe("8eNv2KPBo2ziPCDNE4Gv53fv4Uf28fTAfptNFTpJpump");
    expect(v.supply).toBe(2_000_000_000_000_000n);
    expect(v.decimals).toBe(6);
    expect(v.totalHolders).toBe(6);
    expect(v.holders).toHaveLength(6);
    expect(v.markets).toHaveLength(1);
    expect(v.markets[0]).toMatchObject({ type: "pump_fun" });
    expect(typeof v.markets[0]!.vault).toBe("bigint");
    expect(v.mintAuthorityActive).toBe(false);
    expect(v.freezeAuthorityActive).toBe(false);
  });

  it("reads the vault from whichever side of the pool is the token, and says null when neither is", () => {
    const raw = read("rugcheck-young-curve-listed-2b.json") as { markets: Array<Record<string, unknown>>; mint: string };
    const m = raw.markets[0]!;
    const a = m["liquidityAAccount"] as { amount: number };
    const swapped = { ...raw, markets: [{ ...m, liquidityAAccount: m["liquidityBAccount"], liquidityBAccount: m["liquidityAAccount"] }] };
    expect(parseReport(swapped).markets[0]!.vault).toBe(BigInt(a.amount));
    const neither = { ...raw, markets: [{ ...m, liquidityAAccount: { mint: "OTHER", amount: 1 }, liquidityBAccount: { mint: "OTHER2", amount: 2 } }] };
    expect(parseReport(neither).markets[0]!.vault).toBeNull();
  });

  it("collects the known accounts that are automated markets or lockers, and not the creator", () => {
    const v = view("rugcheck-young-curve-listed-2b.json");
    const raw = read("rugcheck-young-curve-listed-2b.json") as { knownAccounts: Record<string, { type: string }>; creator: string };
    const expected = Object.entries(raw.knownAccounts).filter(([, k]) => k.type === "AMM" || k.type === "LOCKER").map(([a]) => a).sort();
    expect([...v.nonHolders].sort()).toEqual(expected);
    expect(v.nonHolders.has(raw.creator)).toBe(false);
  });

  it("tells 'no authority' (false) from 'has an authority' (true) from 'not said' (null)", () => {
    const raw = read("rugcheck-young-curve-listed-2b.json") as Record<string, unknown>;
    expect(parseReport({ ...raw, mintAuthority: "SomeKey", freezeAuthority: null }).mintAuthorityActive).toBe(true);
    expect(parseReport({ ...raw, mintAuthority: null, freezeAuthority: "SomeKey" }).freezeAuthorityActive).toBe(true);
    const { mintAuthority: _m, freezeAuthority: _f, ...rest } = raw;
    expect(parseReport(rest).mintAuthorityActive).toBeNull();
    expect(parseReport(rest).freezeAuthorityActive).toBeNull();
  });
});

describe("parseReport refuses what it cannot read exactly", () => {
  const good = (): Record<string, unknown> => structuredClone(read("rugcheck-young-curve-listed-2b.json")) as Record<string, unknown>;
  const edit = (f: (r: Record<string, any>) => void): unknown => {
    const r = good();
    f(r);
    return r;
  };

  it("refuses a reply that is not a report", () => {
    for (const bad of [null, 3, "x", [], {}, { mint: "M" }, { topHolders: [] }]) expect(() => parseReport(bad)).toThrow(ReportError);
  });

  it("refuses a supply that a JSON number cannot hold exactly (above 2^53)", () => {
    expect(() => parseReport(edit((r) => (r["token"].supply = 1e18)))).toThrow(/supply/);
  });

  it("refuses a missing, zero, fractional or negative supply", () => {
    for (const s of [undefined, 0, 1.5, -5, "2000"]) expect(() => parseReport(edit((r) => (r["token"].supply = s))), String(s)).toThrow(/supply/);
  });

  it("refuses decimals outside 0..36", () => {
    for (const d of [-1, 37, 1.5, "6"]) expect(() => parseReport(edit((r) => (r["token"].decimals = d))), String(d)).toThrow(/decimals/);
  });

  it("refuses a holder with a missing owner or an amount that is negative, fractional or too large", () => {
    expect(() => parseReport(edit((r) => delete r["topHolders"][0].owner))).toThrow(/owner/);
    for (const a of [-1, 0.5, 1e18, "5", null]) expect(() => parseReport(edit((r) => (r["topHolders"][0].amount = a))), String(a)).toThrow(/amount/);
  });

  it("refuses a holder list that is not a list and a holder count that is not a whole number", () => {
    expect(() => parseReport(edit((r) => (r["topHolders"] = "x")))).toThrow(/topHolders/);
    for (const n of [-1, 1.5, "6", undefined]) expect(() => parseReport(edit((r) => (r["totalHolders"] = n))), String(n)).toThrow(/totalHolders/);
  });

  it("accepts a holder whose amount is exactly 0, and refuses a negative one", () => {
    expect(parseReport(edit((r) => (r["topHolders"][0].amount = 0))).holders[0]!.amount).toBe(0n);
    expect(() => parseReport(edit((r) => (r["topHolders"][0].amount = -1)))).toThrow(/amount/);
  });

  it("accepts a report with no markets at all (a token no pool was found for)", () => {
    expect(parseReport(edit((r) => delete r["markets"])).markets).toEqual([]);
  });
});

describe("snapshotFromReport agrees with the independent reference on every real report", () => {
  const wallets = new Set(EXPECTED.protocolWallets);

  it("covers every recorded report", () => {
    expect(NAMES).toEqual(Object.keys(EXPECTED.reports).sort());
    expect(NAMES.length).toBe(6);
  });

  for (const name of NAMES) {
    for (const [label, set, key] of [
      ["without protocol wallets", new Set<string>(), "withoutProtocolWallets"],
      ["with the protocol wallet excluded", wallets, "withProtocolWallets"],
    ] as const) {
      it(`${name.replace("rugcheck-", "").replace(".json", "")}, ${label}`, () => {
        const want = EXPECTED.reports[name]![key];
        const snap = snapshotFromReport(view(name), set);
        expect(snap.quality).toBe(want.quality);
        expect(snap.diagnostics.listed).toBe(want.listed);
        expect(snap.diagnostics.tailHolders).toBe(want.tailHolders);
        expect(snap.diagnostics.unlistedMarketAmount).toBe(BigInt(want.curveUnlisted));
        expect(snap.diagnostics.remainder).toBe(BigInt(want.remainder));
        expect(snap.diagnostics.countedHolders).toBe(want.countedHolders);
        expect(snap.diagnostics.countedTotal).toBe(BigInt(want.countedTotal));
        const c = analyzeConcentration(snap.holdings, { exclude: new Set(snap.excluded) });
        if (want.top10Share === null) {
          expect(c.holders === 0 || c.total === 0n).toBe(true);
        } else {
          expect(c.topShare[10]).toBeCloseTo(want.top10Share, 9);
          expect(c.topShare[1]).toBeCloseTo(want.top1Share!, 9);
          expect(c.hhi).toBeCloseTo(want.hhi!, 9);
        }
        expect(snap.creator === null).toBe(want.creatorShare === null);
      });
    }
  }

  it("holds the hand-checked numbers: a 1B token whose curve is not listed has the curve at 950,000,000 tokens", () => {
    const snap = snapshotFromReport(view("rugcheck-young-creator-1b-curve-unlisted.json"));
    expect(snap.diagnostics.unlistedMarketAmount).toBe(950_000_000_000_000n); // 950M tokens x 10^6
    expect(snap.diagnostics.countedTotal).toBe(50_000_000_000_000n); // the creator's 5%
    expect(snap.quality).toBe("exact");
  });

  it("marks a report with a pool type it does not model as unmodelled instead of guessing", () => {
    expect(snapshotFromReport(view("rugcheck-report-established.json")).quality).toBe("unmodelled");
  });

  it("marks a report where half the supply is in no field and nobody is left to hold it as unattributed", () => {
    const snap = snapshotFromReport(view("rugcheck-young-unattributed-2b.json"));
    expect(snap.quality).toBe("unattributed");
    expect(snap.diagnostics.remainder).toBe(997_674_756_308_265n);
    expect(snap.diagnostics.countedTotal).toBe(0n); // the remainder is NOT handed to anyone
  });

  it("spreads what is left over the unlisted holders of a token with more than 20 holders, and says so", () => {
    const snap = snapshotFromReport(view("rugcheck-young-tail-1b.json"));
    expect(snap.quality).toBe("estimated");
    expect(snap.diagnostics.tailHolders).toBe(5);
    const tail = snap.holdings.filter((h) => h.address.startsWith("tail:"));
    expect(tail.map((h) => h.address)).toEqual(["tail:1", "tail:2", "tail:3", "tail:4", "tail:5"]);
    expect(tail.reduce((s, h) => s + h.amount, 0n)).toBe(snap.diagnostics.remainder);
  });
});

describe("protocol wallets", () => {
  const all = NAMES.map(view);

  it("finds the one wallet that is the largest counted holder of at least a quarter of the reports", () => {
    expect([...protocolWallets(all)]).toEqual([BWWK]);
    expect([...protocolWallets(all)]).toEqual(EXPECTED.protocolWallets);
  });

  it("finds nothing at a higher bar, and nothing in an empty list", () => {
    expect(protocolWallets(all, 0.5).size).toBe(0);
    expect(protocolWallets([]).size).toBe(0);
  });

  it("counts the share against ALL the reports, not only those that have a largest holder", () => {
    // 2 of 6 = 33%: over the bar of 0.34 it must disappear, exactly at 2/6 it stays
    expect(protocolWallets(all, 0.34).size).toBe(0);
    expect(protocolWallets(all, 2 / 6).has(BWWK)).toBe(true);
  });

  it("divides by all the reports given, including those with no counted holder at all", () => {
    const withHolder = hand({ supply: 10n, holders: [{ owner: "X", amount: 10n }] });
    const none = (): ReportView => hand({ supply: 10n, holders: [{ owner: "mkt", amount: 10n }], markets: [{ pubkey: "mkt", type: "pump_fun", vault: 0n }] });
    const four = [withHolder, none(), none(), none()];
    expect(protocolWallets(four, 0.25).has("X")).toBe(true); // 1 of 4 = 25%, exactly the bar
    expect(protocolWallets(four, 0.3).has("X")).toBe(false); // 1 of 4 is below 30%, though it is 1 of 1 among the reports that have a holder
  });

  it("does not count a market, an AMM or a locker as a holder, however much it has", () => {
    const v = view("rugcheck-young-curve-listed-2b.json");
    const biggest = [...v.holders].sort((a, b) => (a.amount < b.amount ? 1 : -1))[0]!;
    expect(v.markets.some((m) => m.pubkey === biggest.owner)).toBe(true); // the curve is the biggest row in this report
    expect(largestCountedOwner(v)).not.toBe(biggest.owner);
  });

  it("breaks a tie between equal holders by the smaller address, so the answer never depends on the order of the rows", () => {
    const v = hand({ holders: [{ owner: "zzz", amount: 5n }, { owner: "aaa", amount: 5n }], supply: 10n });
    expect(largestCountedOwner(v)).toBe("aaa");
    expect(largestCountedOwner({ ...v, holders: [...v.holders].reverse() })).toBe("aaa");
  });

  it("does not count a locker or a known AMM as a holder either", () => {
    const v = hand({ supply: 100n, holders: [{ owner: "lock", amount: 90n }, { owner: "u", amount: 10n }], nonHolders: new Set(["lock"]) });
    expect(largestCountedOwner(v)).toBe("u");
  });

  it("gives null when every listed owner is not a holder", () => {
    const v = hand({ holders: [{ owner: "mkt", amount: 5n }], markets: [{ pubkey: "mkt", type: "pump_fun", vault: 0n }], supply: 5n });
    expect(largestCountedOwner(v)).toBeNull();
  });

  it("ranks by the owner's total when an owner has several rows", () => {
    const v = hand({ holders: [{ owner: "a", amount: 4n }, { owner: "b", amount: 6n }, { owner: "a", amount: 4n }], supply: 14n });
    expect(largestCountedOwner(v)).toBe("a"); // 8 > 6
  });
});

/** A report built by hand, in whole tokens (decimals 0), for the rules that no recorded report happens to show. */
function hand(over: Partial<ReportView> & { supply: bigint }): ReportView {
  return {
    mint: "MINT",
    decimals: 0,
    creator: "creator",
    totalHolders: over.holders?.length ?? 0,
    holders: [],
    markets: [],
    nonHolders: new Set(),
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    ...over,
  };
}

describe("snapshotFromReport rules on hand-built reports", () => {
  it("adds the pump.fun reserve to the vault of a curve that is not listed, once per such market", () => {
    const supply = 800_000_000n;
    const v = hand({
      supply,
      holders: [{ owner: "mA", amount: 300_000_000n }, { owner: "u1", amount: 93_100_000n }],
      markets: [
        { pubkey: "mA", type: "pump_fun", vault: 123n }, // listed: its listed row is the truth, the vault is ignored
        { pubkey: "mB", type: "pump_fun", vault: 200_000_000n }, // unlisted: 200,000,000 + the 206,900,000 reserve
      ],
    });
    const snap = snapshotFromReport(v);
    expect(snap.diagnostics.unlistedMarketAmount).toBe(200_000_000n + PUMP_RESERVE_TOKENS);
    expect(snap.diagnostics.remainder).toBe(0n);
    expect(snap.quality).toBe("exact");
  });

  it("adds only the vault for a graduated pool (no reserve)", () => {
    const v = hand({ supply: 1000n, holders: [{ owner: "u1", amount: 400n }], markets: [{ pubkey: "pool", type: "pump_fun_amm", vault: 600n }] });
    const snap = snapshotFromReport(v);
    expect(snap.diagnostics.unlistedMarketAmount).toBe(600n);
    expect(snap.quality).toBe("exact");
  });

  it("is unmodelled for a market of another type or with no vault of this token, even when the numbers happen to add up", () => {
    const other = hand({ supply: 100n, holders: [{ owner: "u1", amount: 100n }], markets: [{ pubkey: "x", type: "raydium", vault: 5n }] });
    expect(snapshotFromReport(other).quality).toBe("unmodelled");
    const noVault = hand({ supply: 100n, holders: [{ owner: "u1", amount: 100n }], markets: [{ pubkey: "x", type: "pump_fun", vault: null }] });
    expect(snapshotFromReport(noVault).quality).toBe("unmodelled");
  });

  it("is inconsistent when the rows add up to more than the supply by more than a tenth of a percent, and exact within it", () => {
    const over = hand({ supply: 10_000n, holders: [{ owner: "a", amount: 6_000n }, { owner: "b", amount: 4_011n }] }); // 11 over: 0.11%
    expect(snapshotFromReport(over).quality).toBe("inconsistent");
    const within = hand({ supply: 10_000n, holders: [{ owner: "a", amount: 6_000n }, { owner: "b", amount: 4_010n }] }); // 10 over: 0.10%
    expect(snapshotFromReport(within).quality).toBe("exact");
  });

  it("is unattributed when more than a tenth of a percent is missing and no unlisted holder exists to carry it, exact within it", () => {
    const gap = hand({ supply: 10_000n, holders: [{ owner: "a", amount: 9_989n }] }); // 11 missing
    expect(snapshotFromReport(gap).quality).toBe("unattributed");
    const small = hand({ supply: 10_000n, holders: [{ owner: "a", amount: 9_990n }] }); // 10 missing
    expect(snapshotFromReport(small).quality).toBe("exact");
  });

  it("splits the remainder over the unlisted holders so that nothing is lost, the odd tokens going to the first", () => {
    const v = hand({ supply: 110n, holders: [{ owner: "a", amount: 100n }], totalHolders: 4 }); // 3 unlisted holders share 10
    const snap = snapshotFromReport(v);
    const tail = snap.holdings.filter((h) => h.address.startsWith("tail:")).map((h) => h.amount);
    expect(tail).toEqual([4n, 3n, 3n]);
    expect(snap.quality).toBe("estimated");
  });

  it("gives no tail holdings when nothing is left over, however many unlisted holders there are", () => {
    const v = hand({ supply: 100n, holders: [{ owner: "a", amount: 100n }], totalHolders: 9 });
    const snap = snapshotFromReport(v);
    expect(snap.holdings.filter((h) => h.address.startsWith("tail:"))).toEqual([]);
    expect(snap.quality).toBe("estimated");
  });

  it("adds up the rows of an owner that has several, and counts rows (not owners) as listed", () => {
    const v = hand({ supply: 30n, holders: [{ owner: "a", amount: 10n }, { owner: "b", amount: 10n }, { owner: "a", amount: 10n }] });
    const snap = snapshotFromReport(v);
    expect(snap.holdings.find((h) => h.address === "a")!.amount).toBe(20n);
    expect(snap.holdings.filter((h) => h.address === "a")).toHaveLength(1);
    expect(snap.diagnostics.listed).toBe(3);
  });

  it("does not count a market's own row as a holder even when no known account names it", () => {
    const v = hand({ supply: 400n, holders: [{ owner: "mkt", amount: 300n }, { owner: "u", amount: 100n }], markets: [{ pubkey: "mkt", type: "pump_fun", vault: 0n }] });
    const snap = snapshotFromReport(v);
    expect(snap.diagnostics.countedTotal).toBe(100n);
    expect(snap.diagnostics.countedHolders).toBe(1);
    expect(snap.excluded).toContain("mkt");
  });

  it("does not count a known AMM or locker row as a holder even when it is not one of the markets", () => {
    const v = hand({ supply: 400n, holders: [{ owner: "lock", amount: 300n }, { owner: "u", amount: 100n }], nonHolders: new Set(["lock"]) });
    const snap = snapshotFromReport(v);
    expect(snap.diagnostics.countedTotal).toBe(100n);
    expect(snap.excluded).toContain("lock");
  });

  it("lists the excluded addresses in one fixed order, whatever order the wallets were found in", () => {
    const v = hand({ supply: 100n, holders: [{ owner: "u", amount: 100n }], markets: [{ pubkey: "m2", type: "pump_fun", vault: 0n }, { pubkey: "m1", type: "pump_fun", vault: 0n }], nonHolders: new Set(["z", "a"]) });
    const one = snapshotFromReport(v, new Set(["q", "b"])).excluded;
    const two = snapshotFromReport(v, new Set(["b", "q"])).excluded;
    expect(one).toEqual(["a", "b", "m1", "m2", "q", "z"]);
    expect(two).toEqual(one);
  });

  it("keeps an excluded owner in the holdings, named in `excluded`, so the report can be read back as it was", () => {
    const v = hand({ supply: 100n, holders: [{ owner: "proto", amount: 60n }, { owner: "u", amount: 40n }] });
    const snap = snapshotFromReport(v, new Set(["proto"]));
    expect(snap.holdings.map((h) => h.address).sort()).toEqual(["proto", "u"]);
    expect(snap.excluded).toContain("proto");
    expect(snap.diagnostics.countedTotal).toBe(40n);
    expect(snap.diagnostics.countedHolders).toBe(1);
  });

  describe("the creator", () => {
    it("is named when it is listed and counted", () => {
      const v = hand({ supply: 100n, creator: "c", holders: [{ owner: "c", amount: 7n }, { owner: "u", amount: 93n }] });
      expect(snapshotFromReport(v).creator).toBe("c");
    });
    it("is named, as holding nothing, when every holder is listed and it is not one of them", () => {
      const v = hand({ supply: 100n, creator: "c", holders: [{ owner: "u", amount: 100n }] });
      expect(snapshotFromReport(v).creator).toBe("c");
    });
    it("is NOT named when unlisted holders exist, because it may be one of them (never read as 'holds nothing')", () => {
      const v = hand({ supply: 150n, creator: "c", holders: [{ owner: "u", amount: 100n }], totalHolders: 5 });
      expect(snapshotFromReport(v).creator).toBeNull();
    });
    it("is NOT named when the report does not add up, or the pools are not understood", () => {
      expect(snapshotFromReport(hand({ supply: 10n, creator: "c", holders: [{ owner: "u", amount: 99n }] })).creator).toBeNull();
      expect(snapshotFromReport(hand({ supply: 100n, creator: "c", holders: [{ owner: "u", amount: 100n }], markets: [{ pubkey: "m", type: "raydium", vault: 1n }] })).creator).toBeNull();
    });
    it("is NOT named when it is itself a market, a locker or a protocol wallet (other holders are counted, so that is not why)", () => {
      const v = hand({ supply: 100n, creator: "c", holders: [{ owner: "c", amount: 60n }, { owner: "u", amount: 40n }] });
      expect(snapshotFromReport(v, new Set(["c"])).diagnostics.countedTotal).toBe(40n);
      expect(snapshotFromReport(v, new Set(["c"])).creator).toBeNull();
      expect(snapshotFromReport({ ...v, nonHolders: new Set(["c"]) }).creator).toBeNull();
      expect(snapshotFromReport({ ...v, markets: [{ pubkey: "c", type: "pump_fun", vault: 0n }] }).creator).toBeNull();
      expect(snapshotFromReport(v).creator).toBe("c"); // and named when it is none of those
    });
    it("is NOT named when nobody at all is counted", () => {
      expect(snapshotFromReport(hand({ supply: 100n, creator: "c", holders: [{ owner: "c", amount: 100n }] }), new Set(["u"])).creator).toBe("c"); // c is counted: 100n
      expect(snapshotFromReport(hand({ supply: 100n, creator: "c", holders: [{ owner: "p", amount: 100n }] }), new Set(["p"])).creator).toBeNull(); // only the protocol wallet holds
    });
    it("is NOT named when the report names none", () => {
      expect(snapshotFromReport(hand({ supply: 100n, creator: null, holders: [{ owner: "u", amount: 100n }] })).creator).toBeNull();
    });
  });
});

describe("buildFixture and the real pipeline", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const T0 = 1_794_562_000_000;
  const rows = ["rugcheck-young-tail-1b.json", "rugcheck-young-creator-1b-curve-unlisted.json", "rugcheck-young-curve-listed-2b.json"].map((n, i) => ({
    view: view(n),
    createdAt: T0 + i,
    asOf: T0 + 3_700_000 + i,
  }));
  const wallets = new Set([BWWK]);
  const fixture = buildFixture(rows, wallets);

  it("makes a fixture the existing reader accepts, with one token and one snapshot per report and no trades", () => {
    const data = parseFixture(JSON.parse(JSON.stringify(fixture)));
    expect(data.chain).toBe("solana");
    expect(data.tokens.map((t) => t.token)).toEqual(rows.map((r) => r.view.mint));
    expect(data.snapshots).toHaveLength(3);
    expect(data.trades).toEqual([]);
    expect(data.snapshots[0]!.time).toBe(T0 + 3_700_000);
    expect(data.tokens[0]!.createdAt).toBe(T0);
  });

  it("says in its note that the data is real and what the amounts are", () => {
    expect(fixture.note).toMatch(/REAL/);
    expect(fixture.note).toMatch(/RugCheck/);
  });

  it("writes amounts as decimal strings, never as numbers (they pass 2^53 in other tokens)", () => {
    for (const s of fixture.snapshots) for (const h of s.holdings) expect(h.amount).toMatch(/^[0-9]+$/);
  });

  it("is the same fixture however many times it is built", () => {
    expect(JSON.stringify(buildFixture(rows, wallets))).toBe(JSON.stringify(fixture));
  });

  it("scores through the real risk code to the numbers the reference gives, and says unknown where the creator or the holders are not known", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-export-"));
    dirs.push(dir);
    const store = Store.open(join(dir, "x.sqlite"));
    await ingest(store, new ReplayAdapter(parseFixture(JSON.parse(JSON.stringify(fixture)))));

    const tail = tokenRisk(store, "solana", rows[0]!.view.mint, rows[0]!.asOf)!;
    const want = EXPECTED.reports["rugcheck-young-tail-1b.json"]!.withProtocolWallets;
    expect(tail.input.concentration!.topShare[10]).toBeCloseTo(want.top10Share!, 9);
    expect(tail.input.concentration!.hhi).toBeCloseTo(want.hhi!, 9);
    expect(tail.input.creatorShare).toBeUndefined(); // 5 unlisted holders: the creator may be one of them
    expect(tail.unavailable.creatorShare).toMatch(/creator is not known/);
    expect(tail.input.mintAuthorityActive).toBe(false);
    expect(tail.input.ageMs).toBe(3_700_000);

    const dev = tokenRisk(store, "solana", rows[1]!.view.mint, rows[1]!.asOf)!;
    expect(dev.input.creatorShare).toBeCloseTo(EXPECTED.reports["rugcheck-young-creator-1b-curve-unlisted.json"]!.withProtocolWallets.creatorShare!, 9);

    const mayhem = tokenRisk(store, "solana", rows[2]!.view.mint, rows[2]!.asOf)!;
    expect(mayhem.input.concentration).toBeUndefined();
    expect(mayhem.unavailable.top10Share).toMatch(/no countable holders/);
    expect(mayhem.report.level).toBe("unknown");
    store.close();
  });
});

describe("quality does not depend on who is excluded", () => {
  it("is the same with and without the protocol wallets, for every real report", () => {
    for (const n of NAMES) expect(snapshotFromReport(view(n), new Set([BWWK])).quality, n).toBe(snapshotFromReport(view(n)).quality);
  });
});

describe("exportFromStored", () => {
  const T0 = 1_794_562_000_000;
  const body = (n: string): string => readFileSync(join(FIXTURES, n), "utf8");
  const real: StoredReport[] = NAMES.map((n, i) => ({ mint: view(n).mint, createdAt: T0 + i * 1000, asOf: T0 + 3_700_000 + i * 1000, status: 200, body: body(n) }));
  const extras: StoredReport[] = [
    { mint: "M404", createdAt: T0 + 50_000, asOf: T0 + 3_750_000, status: 404, body: '{"error":"not found"}' },
    { mint: "MHTML", createdAt: T0 + 51_000, asOf: T0 + 3_751_000, status: 200, body: "<html>captcha</html>" },
    { mint: "MBAD", createdAt: T0 + 52_000, asOf: T0 + 3_752_000, status: 200, body: '{"mint":"MBAD"}' },
    { mint: "M500", createdAt: T0 + 53_000, asOf: T0 + 3_753_000, status: 500, body: "{}" },
  ];
  const all = [...real, ...extras];
  const tally = (key: "withProtocolWallets" | "withoutProtocolWallets"): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of Object.values(EXPECTED.reports)) out[r[key].quality] = (out[r[key].quality] ?? 0) + 1;
    return out;
  };

  it("counts every stored row once: used, no report (404), or unreadable, and says why for each unreadable one", () => {
    const r = exportFromStored(all, { minCensus: 6 });
    expect(r.summary.stored).toBe(10);
    expect(r.summary.used).toBe(6);
    expect(r.summary.noReport).toBe(1);
    expect(r.summary.unreadable).toBe(3);
    expect(r.unreadable.map((u) => u.mint).sort()).toEqual(["M500", "MBAD", "MHTML"]);
    expect(r.unreadable.find((u) => u.mint === "MHTML")!.why).toMatch(/JSON/);
    expect(r.unreadable.find((u) => u.mint === "MBAD")!.why).toMatch(/token/);
    expect(r.unreadable.find((u) => u.mint === "M500")!.why).toMatch(/500/);
  });

  it("refuses a report that is for another token than the pool it was stored under", () => {
    const wrong: StoredReport = { ...real[0]!, mint: "SOMEONE-ELSE" };
    const r = exportFromStored([wrong]);
    expect(r.summary.used).toBe(0);
    expect(r.unreadable).toEqual([{ mint: "SOMEONE-ELSE", why: expect.stringMatching(/another token/) }]);
  });

  it("finds the protocol wallet over ALL the readable reports and tallies the quality of each with it excluded", () => {
    const r = exportFromStored(all, { minCensus: 6 });
    expect(r.summary.protocolWallets).toEqual([BWWK]);
    expect(r.summary.censusUsed).toBe(true);
    expect(r.summary.byQuality).toEqual({ exact: 0, estimated: 0, unattributed: 0, inconsistent: 0, unmodelled: 0, ...tally("withProtocolWallets") });
  });

  it("puts the protocol wallets into every exported token's `excluded` when the census ran, and none when it did not", () => {
    const used = exportFromStored(all, { minCensus: 6 }).fixture;
    for (const t of used.tokens) expect(t.excluded).toContain(BWWK);
    const skipped = exportFromStored(all).fixture;
    for (const t of skipped.tokens) expect(t.excluded).not.toContain(BWWK);
  });

  it("lists several protocol wallets in one fixed order, whichever was met first", () => {
    const fake = (mint: string, big: string, i: number): StoredReport => ({
      mint,
      createdAt: T0 + i,
      asOf: T0 + 3_700_000 + i,
      status: 200,
      body: JSON.stringify({ mint, creator: "c", token: { supply: 100, decimals: 0 }, topHolders: [{ owner: big, amount: 60 }, { owner: `small${i}`, amount: 40 }], totalHolders: 2, markets: [], mintAuthority: null, freezeAuthority: null }),
    });
    const rows = [fake("M1", "zz", 1), fake("M2", "aa", 2), fake("M3", "zz", 3), fake("M4", "aa", 4)];
    const r = exportFromStored(rows, { minCensus: 4 });
    expect(r.summary.protocolWallets).toEqual(["aa", "zz"]);
    expect(r.fixture.tokens[0]!.excluded).toEqual(expect.arrayContaining(["aa", "zz"]));
  });

  it("does not use a census over fewer than 100 readable reports (a quarter of 4 is one token), and says so", () => {
    const r = exportFromStored(all);
    expect(r.summary.censusUsed).toBe(false);
    expect(r.summary.protocolWallets).toEqual([]);
    expect(r.summary.byQuality).toEqual({ exact: 0, estimated: 0, unattributed: 0, inconsistent: 0, unmodelled: 0, ...tally("withoutProtocolWallets") });
    expect(exportFromStored(all, { minCensus: 7 }).summary.censusUsed).toBe(false);
    expect(exportFromStored(all, { minCensus: 6 }).summary.censusUsed).toBe(true);
  });

  it("makes one token and one snapshot per readable report, in the order the pools were created, and a fixture the reader accepts", () => {
    const r = exportFromStored(all, { minCensus: 6 });
    const data = parseFixture(JSON.parse(JSON.stringify(r.fixture)));
    expect(data.tokens.map((t) => t.token)).toEqual(NAMES.map((n) => view(n).mint));
    expect(data.snapshots.map((x) => x.time)).toEqual(real.map((x) => x.asOf));
  });

  it("gives the same fixture whatever order the rows come in, ties in creation time broken by the address", () => {
    const a = exportFromStored(all, { minCensus: 6 });
    const b = exportFromStored([...all].reverse(), { minCensus: 6 });
    expect(JSON.stringify(b.fixture)).toBe(JSON.stringify(a.fixture));
    const tied: StoredReport[] = real.map((x) => ({ ...x, createdAt: T0 }));
    expect(exportFromStored([...tied].reverse(), { minCensus: 6 }).fixture.tokens.map((t) => t.token)).toEqual(exportFromStored(tied, { minCensus: 6 }).fixture.tokens.map((t) => t.token));
    expect(exportFromStored(tied, { minCensus: 6 }).fixture.tokens.map((t) => t.token)).toEqual([...real.map((x) => x.mint)].sort());
  });

  it("exports nothing from nothing", () => {
    const r = exportFromStored([]);
    expect(r.fixture.tokens).toEqual([]);
    expect(r.summary).toMatchObject({ stored: 0, used: 0, noReport: 0, unreadable: 0, censusUsed: false });
  });
});
