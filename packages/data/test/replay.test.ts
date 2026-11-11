import { describe, expect, it } from "vitest";
import { FixtureError, ReplayAdapter, parseFixture, type ReplayData } from "../src/replay";

function fixtureJson(): any {
  return {
    format: "memelens-fixture",
    version: 1,
    chain: "solana",
    synthetic: true,
    tokens: [
      {
        token: "TOK1",
        symbol: "ONE",
        decimals: 6,
        createdAt: 1000,
        creator: "CREATOR",
        mintAuthorityActive: false,
        freezeAuthorityActive: null,
        excluded: ["POOL"],
      },
    ],
    trades: [
      { id: "t1", time: 2000, wallet: "W1", token: "TOK1", side: "buy", amount: "1000", quote: "50", fee: "1" },
      { id: "t2", time: 3000, wallet: "W1", token: "TOK1", side: "sell", amount: "400", quote: "30", fee: "0" },
    ],
    snapshots: [{ token: "TOK1", time: 2500, holdings: [{ address: "W1", amount: "1000" }] }],
  };
}

describe("parseFixture", () => {
  it("parses a valid fixture and turns decimal strings into bigint", () => {
    const d = parseFixture(fixtureJson());
    expect(d.chain).toBe("solana");
    expect(d.tokens).toHaveLength(1);
    expect(d.tokens[0]!.excluded).toEqual(["POOL"]);
    expect(d.tokens[0]!.freezeAuthorityActive).toBeNull();
    expect(d.trades[0]!.amount).toBe(1000n);
    expect(d.trades[0]!.fee).toBe(1n);
    expect(d.snapshots[0]!.holdings[0]!.amount).toBe(1000n);
  });

  it("keeps amounts above 2^64 exact", () => {
    const j = fixtureJson();
    j.trades[0].amount = "123456789012345678901234567890";
    expect(parseFixture(j).trades[0]!.amount).toBe(123456789012345678901234567890n);
  });

  it("defaults a missing fee to 0", () => {
    const j = fixtureJson();
    delete j.trades[0].fee;
    expect(parseFixture(j).trades[0]!.fee).toBe(0n);
  });

  const bad: Array<[string, (j: any) => void, RegExp]> = [
    ["wrong format tag", (j) => (j.format = "other"), /format/],
    ["unsupported version", (j) => (j.version = 2), /version/],
    ["missing chain", (j) => delete j.chain, /chain/],
    ["amount as a JSON number", (j) => (j.trades[1].amount = 400), /trades\[1\]\.amount/],
    ["negative amount string", (j) => (j.trades[0].amount = "-5"), /trades\[0\]\.amount/],
    ["decimal amount string", (j) => (j.trades[0].amount = "1.5"), /trades\[0\]\.amount/],
    ["empty amount string", (j) => (j.trades[0].amount = ""), /trades\[0\]\.amount/],
    ["zero amount", (j) => (j.trades[0].amount = "0"), /trades\[0\]\.amount/],
    ["negative quote", (j) => (j.trades[0].quote = "-1"), /trades\[0\]\.quote/],
    ["fractional time", (j) => (j.trades[0].time = 1.5), /trades\[0\]\.time/],
    ["string time", (j) => (j.trades[0].time = "2000"), /trades\[0\]\.time/],
    ["bad side", (j) => (j.trades[0].side = "hold"), /trades\[0\]\.side/],
    ["missing wallet", (j) => delete j.trades[0].wallet, /trades\[0\]\.wallet/],
    ["duplicate trade id", (j) => (j.trades[1].id = "t1"), /duplicate/],
    ["token with non-boolean authority flag", (j) => (j.tokens[0].mintAuthorityActive = "no"), /tokens\[0\]\.mintAuthorityActive/],
    ["token with non-array excluded", (j) => (j.tokens[0].excluded = "POOL"), /tokens\[0\]\.excluded/],
    ["holding amount as number", (j) => (j.snapshots[0].holdings[0].amount = 5), /snapshots\[0\]\.holdings\[0\]\.amount/],
    ["trades not an array", (j) => (j.trades = {}), /trades/],
    ["decimals above 36", (j) => (j.tokens[0].decimals = 37), /tokens\[0\]\.decimals/],
    ["negative decimals", (j) => (j.tokens[0].decimals = -1), /tokens\[0\]\.decimals/],
    ["fractional decimals", (j) => (j.tokens[0].decimals = 6.5), /tokens\[0\]\.decimals/],
    ["decimals as a string", (j) => (j.tokens[0].decimals = "6"), /tokens\[0\]\.decimals/],
  ];
  for (const [name, mutate, re] of bad) {
    it(`rejects: ${name}`, () => {
      const j = fixtureJson();
      mutate(j);
      expect(() => parseFixture(j)).toThrow(FixtureError);
      expect(() => parseFixture(j)).toThrow(re);
    });
  }

  it("rejects non-object input", () => {
    expect(() => parseFixture(null)).toThrow(FixtureError);
    expect(() => parseFixture("x")).toThrow(FixtureError);
  });
});

function data(): ReplayData {
  const tok = (token: string, createdAt: number): ReplayData["tokens"][number] => ({
    token,
    symbol: null,
    decimals: 6,
    createdAt,
    creator: null,
    mintAuthorityActive: null,
    freezeAuthorityActive: null,
    excluded: [],
  });
  const tr = (id: string, time: number, wallet: string, token: string): ReplayData["trades"][number] => ({
    id,
    time,
    wallet,
    token,
    side: "buy",
    amount: 10n,
    quote: 1n,
    fee: 0n,
  });
  return {
    chain: "solana",
    tokens: [tok("A", 100), tok("B", 500)],
    trades: [
      tr("z", 300, "w1", "A"),
      tr("b", 200, "w1", "A"),
      tr("a", 200, "w2", "A"),
      tr("c", 600, "w2", "B"),
    ],
    snapshots: [
      { token: "A", time: 150, holdings: [{ address: "w1", amount: 1n }] },
      { token: "A", time: 400, holdings: [{ address: "w1", amount: 2n }] },
      { token: "A", time: 900, holdings: [{ address: "w1", amount: 3n }] },
    ],
  };
}

describe("ReplayAdapter", () => {
  it("exposes the chain id", () => {
    expect(new ReplayAdapter(data()).chain).toBe("solana");
  });

  it("lists trades oldest first, ties broken by id", async () => {
    const t = await new ReplayAdapter(data()).listTrades();
    expect(t.map((x) => x.id)).toEqual(["a", "b", "z", "c"]);
  });

  it("filters by token, wallet and an inclusive time range", async () => {
    const a = new ReplayAdapter(data());
    expect((await a.listTrades({ token: "A" })).map((x) => x.id)).toEqual(["a", "b", "z"]);
    expect((await a.listTrades({ wallet: "w2" })).map((x) => x.id)).toEqual(["a", "c"]);
    expect((await a.listTrades({ from: 200, to: 300 })).map((x) => x.id)).toEqual(["a", "b", "z"]);
    expect((await a.listTrades({ from: 201, to: 299 })).map((x) => x.id)).toEqual([]);
  });

  it("hides everything after its clock (the clock itself is visible)", async () => {
    const a = new ReplayAdapter(data(), 300);
    expect((await a.listTrades()).map((x) => x.id)).toEqual(["a", "b", "z"]);
    expect((await a.listTokens()).map((x) => x.token)).toEqual(["A"]);
    expect((await a.listSnapshots()).map((s) => s.time)).toEqual([150]);
  });

  it("a range cannot reach past the clock", async () => {
    const a = new ReplayAdapter(data(), 300);
    expect((await a.listTrades({ from: 0, to: 10_000 })).map((x) => x.id)).toEqual(["a", "b", "z"]);
  });

  it("holderSnapshot returns the newest snapshot at or before asOf", async () => {
    const a = new ReplayAdapter(data());
    expect(await a.holderSnapshot("A", 149)).toBeNull();
    expect((await a.holderSnapshot("A", 150))!.time).toBe(150);
    expect((await a.holderSnapshot("A", 399))!.time).toBe(150);
    expect((await a.holderSnapshot("A", 400))!.time).toBe(400);
    expect((await a.holderSnapshot("A", 10_000))!.time).toBe(900);
    expect(await a.holderSnapshot("NOPE", 10_000)).toBeNull();
  });

  it("holderSnapshot cannot see past the clock even when asOf is later", async () => {
    const a = new ReplayAdapter(data(), 500);
    expect((await a.holderSnapshot("A", 10_000))!.time).toBe(400);
  });

  it("withClock returns a new adapter and leaves the original alone", async () => {
    const a = new ReplayAdapter(data());
    const b = a.withClock(250);
    expect(b).not.toBe(a);
    expect((await b.listTrades()).map((x) => x.id)).toEqual(["a", "b"]);
    expect((await a.listTrades()).map((x) => x.id)).toEqual(["a", "b", "z", "c"]);
  });

  it("returned arrays are copies: mutating them does not change the adapter", async () => {
    const a = new ReplayAdapter(data());
    (await a.listTrades()).length = 0;
    (await a.listTokens()).length = 0;
    expect(await a.listTrades()).toHaveLength(4);
    expect(await a.listTokens()).toHaveLength(2);
  });

  it("returned objects are copies too: changing one does not change the adapter", async () => {
    const a = new ReplayAdapter(data());
    const first = (await a.listTrades())[0]!;
    first.amount = 999n;
    first.wallet = "hacked";
    const t = (await a.listTrades())[0]!;
    expect(t.amount).toBe(10n);
    expect(t.wallet).toBe("w2");
    const s = (await a.holderSnapshot("A", 150))!;
    s.holdings[0]!.amount = 777n;
    expect((await a.holderSnapshot("A", 150))!.holdings[0]!.amount).toBe(1n);
  });

  it("does not change when the input data is mutated afterwards", async () => {
    const d = data();
    const a = new ReplayAdapter(d);
    d.trades.length = 0;
    expect(await a.listTrades()).toHaveLength(4);
  });
});
