import { afterEach, describe, expect, it, vi } from "vitest";
import { ingest, validateSnapshot, validateToken, validateTrade } from "../src/ingest";
import { ReplayAdapter, type ReplayData } from "../src/replay";
import { Store } from "../src/store";
import type { ChainAdapter, TradeEvent } from "../src/types";
import { snap, tok, trade } from "./helpers";

const opened: Store[] = [];
function mem(): Store {
  const s = Store.open(":memory:");
  opened.push(s);
  return s;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (opened.length) opened.pop()!.close();
});

function data(over: Partial<ReplayData> = {}): ReplayData {
  return {
    chain: "solana",
    tokens: [tok("A", { creator: "C", excluded: ["POOL"] }), tok("B")],
    trades: [
      trade("t1", { time: 10, wallet: "w1", token: "A", amount: 100n, quote: 50n }),
      trade("t2", { time: 20, wallet: "w2", token: "A", side: "sell", amount: 40n, quote: 30n }),
      trade("t3", { time: 30, wallet: "w1", token: "B", amount: 7n, quote: 7n }),
    ],
    snapshots: [snap("A", 15, [["w1", 100n], ["POOL", 900n]])],
    ...over,
  };
}

describe("validateTrade", () => {
  const cases: Array<[string, Parameters<typeof trade>[1], string]> = [
    ["empty id", { id: "" }, "id-empty"],
    ["empty wallet", { wallet: "" }, "wallet-empty"],
    ["empty token", { token: "" }, "token-empty"],
    ["negative time", { time: -1 }, "time-invalid"],
    ["fractional time", { time: 1.5 }, "time-invalid"],
    ["NaN time", { time: NaN }, "time-invalid"],
    ["Infinity time", { time: Infinity }, "time-invalid"],
    ["bad side", { side: "hold" as any }, "side-invalid"],
    ["zero amount", { amount: 0n }, "amount-not-positive"],
    ["negative amount", { amount: -1n }, "amount-not-positive"],
    ["amount as number", { amount: 5 as any }, "amount-not-positive"],
    ["negative quote", { quote: -1n }, "quote-negative"],
    ["quote as number", { quote: 1 as any }, "quote-negative"],
    ["negative fee", { fee: -1n }, "fee-negative"],
    ["fee as string", { fee: "0" as any }, "fee-negative"],
  ];
  for (const [name, over, reason] of cases) {
    it(`flags ${name} as ${reason}`, () => {
      expect(validateTrade(trade("t", over))).toBe(reason);
    });
  }
  it("accepts a valid trade, including a free (zero-quote) buy and a zero time", () => {
    expect(validateTrade(trade("t"))).toBeNull();
    expect(validateTrade(trade("t", { quote: 0n, time: 0 }))).toBeNull();
  });
});

describe("validateToken", () => {
  it("flags empty address, bad decimals and bad creation time", () => {
    expect(validateToken(tok(""))).toBe("token-empty");
    expect(validateToken(tok("A", { decimals: -1 }))).toBe("decimals-invalid");
    expect(validateToken(tok("A", { decimals: 37 }))).toBe("decimals-invalid");
    expect(validateToken(tok("A", { decimals: 1.5 }))).toBe("decimals-invalid");
    expect(validateToken(tok("A", { createdAt: -5 }))).toBe("created-at-invalid");
    expect(validateToken(tok("A", { createdAt: NaN }))).toBe("created-at-invalid");
  });
  it("accepts decimals 0 and 36", () => {
    expect(validateToken(tok("A", { decimals: 0 }))).toBeNull();
    expect(validateToken(tok("A", { decimals: 36 }))).toBeNull();
  });
});

describe("validateSnapshot", () => {
  it("flags empty token, bad time, empty or duplicate addresses and negative or non-bigint amounts", () => {
    expect(validateSnapshot(snap("", 1, []))).toBe("token-empty");
    expect(validateSnapshot(snap("A", -1, []))).toBe("time-invalid");
    expect(validateSnapshot(snap("A", 1, [["", 1n]]))).toBe("holding-address-empty");
    expect(validateSnapshot(snap("A", 1, [["w", -1n]]))).toBe("holding-amount-invalid");
    expect(validateSnapshot({ token: "A", time: 1, holdings: [{ address: "w", amount: 5 as any }] })).toBe("holding-amount-invalid");
    expect(validateSnapshot(snap("A", 1, [["w", 1n], ["w", 2n]]))).toBe("holding-address-duplicate");
  });
  it("accepts an empty snapshot and zero balances", () => {
    expect(validateSnapshot(snap("A", 1, []))).toBeNull();
    expect(validateSnapshot(snap("A", 1, [["w", 0n]]))).toBeNull();
  });
});

describe("ingest", () => {
  it("stores everything an adapter offers and reports the counts", async () => {
    const store = mem();
    const r = await ingest(store, new ReplayAdapter(data()), { now: 999 });
    expect(r.chain).toBe("solana");
    expect(r.tokens).toEqual({ received: 2, inserted: 2, updated: 0, unchanged: 0, rejected: 0 });
    expect(r.trades).toEqual({ received: 3, inserted: 3, duplicates: 0, rejected: 0 });
    expect(r.snapshots).toEqual({ received: 1, inserted: 1, duplicates: 0, rejected: 0 });
    expect(r.rejectReasons).toEqual({});
    expect(store.counts("solana")).toEqual({ tokens: 2, trades: 3, snapshots: 1, rejects: 0 });
    expect(store.getToken("solana", "A")!.excluded).toEqual(["POOL"]);
    expect(store.tradesForWallet("solana", "w1").map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(store.holderSnapshot("solana", "A", 100)!.holdings).toHaveLength(2);
  });

  it("is idempotent: a second run inserts nothing and changes nothing", async () => {
    const store = mem();
    const adapter = new ReplayAdapter(data());
    await ingest(store, adapter);
    const r = await ingest(store, adapter);
    expect(r.tokens).toEqual({ received: 2, inserted: 0, updated: 0, unchanged: 2, rejected: 0 });
    expect(r.trades).toEqual({ received: 3, inserted: 0, duplicates: 3, rejected: 0 });
    expect(r.snapshots).toEqual({ received: 1, inserted: 0, duplicates: 1, rejected: 0 });
    expect(store.counts("solana")).toEqual({ tokens: 2, trades: 3, snapshots: 1, rejects: 0 });
  });

  it("an updated token is reported as updated and the new value wins", async () => {
    const store = mem();
    await ingest(store, new ReplayAdapter(data({ tokens: [tok("A", { mintAuthorityActive: true })] })));
    const r = await ingest(store, new ReplayAdapter(data({ tokens: [tok("A", { mintAuthorityActive: false })] })));
    expect(r.tokens.updated).toBe(1);
    expect(store.getToken("solana", "A")!.mintAuthorityActive).toBe(false);
  });

  it("rejects invalid items, keeps the valid ones, and records every reject with its raw payload", async () => {
    const store = mem();
    const bad = trade("bad", { amount: 0n, quote: 123456789012345678901234567890n });
    const d = data({
      tokens: [tok("A"), tok("", { decimals: 6 }), tok("Z", { decimals: 99 })],
      trades: [trade("ok"), bad, trade("neg", { quote: -1n })],
      snapshots: [snap("A", 5, [["w", 1n], ["w", 2n]]), snap("A", 6, [["w", 1n]])],
    });
    const r = await ingest(store, new ReplayAdapter(d), { now: 4242 });
    expect(r.tokens).toMatchObject({ received: 3, inserted: 1, rejected: 2 });
    expect(r.trades).toMatchObject({ received: 3, inserted: 1, rejected: 2 });
    expect(r.snapshots).toMatchObject({ received: 2, inserted: 1, rejected: 1 });
    expect(r.rejectReasons).toEqual({
      "token-empty": 1,
      "decimals-invalid": 1,
      "amount-not-positive": 1,
      "quote-negative": 1,
      "holding-address-duplicate": 1,
    });
    const rej = store.rejects("solana");
    expect(rej).toHaveLength(5);
    const badRow = rej.find((x) => x.ref === "bad")!;
    expect(badRow).toMatchObject({ kind: "trade", reason: "amount-not-positive", at: 4242 });
    expect(JSON.parse(badRow.raw).quote).toBe("123456789012345678901234567890");
    expect(rej.find((x) => x.kind === "snapshot")!.ref).toBe("A@5");
    expect(store.counts("solana")).toMatchObject({ tokens: 1, trades: 1, snapshots: 1, rejects: 5 });
  });

  it("reports a same-id-different-content trade as a conflict, keeps the original, and records it", async () => {
    const store = mem();
    await ingest(store, new ReplayAdapter(data({ tokens: [], snapshots: [], trades: [trade("t1", { amount: 100n })] })));
    const r = await ingest(store, new ReplayAdapter(data({ tokens: [], snapshots: [], trades: [trade("t1", { amount: 101n })] })), { now: 7 });
    expect(r.trades).toMatchObject({ received: 1, inserted: 0, duplicates: 0, rejected: 1 });
    expect(r.rejectReasons).toEqual({ "id-conflict": 1 });
    expect(store.tradesForToken("solana", "A")[0]!.amount).toBe(100n);
    expect(store.rejects("solana")[0]).toMatchObject({ kind: "trade", ref: "t1", reason: "id-conflict", at: 7 });
  });

  it("reports a conflicting snapshot the same way", async () => {
    const store = mem();
    await ingest(store, new ReplayAdapter(data({ tokens: [], trades: [], snapshots: [snap("A", 5, [["w", 1n]])] })));
    const r = await ingest(store, new ReplayAdapter(data({ tokens: [], trades: [], snapshots: [snap("A", 5, [["w", 2n]])] })));
    expect(r.snapshots).toMatchObject({ inserted: 0, duplicates: 0, rejected: 1 });
    expect(r.rejectReasons).toEqual({ "id-conflict": 1 });
    expect(store.holderSnapshot("solana", "A", 5)!.holdings[0]!.amount).toBe(1n);
  });

  it("keeps chains apart even when ids collide", async () => {
    const store = mem();
    await ingest(store, new ReplayAdapter(data({ chain: "solana", trades: [trade("t1", { amount: 1n })] })));
    const r = await ingest(store, new ReplayAdapter(data({ chain: "base", trades: [trade("t1", { amount: 2n })] })));
    expect(r.trades.inserted).toBe(1);
    expect(store.tradesForToken("solana", "A")[0]!.amount).toBe(1n);
    expect(store.tradesForToken("base", "A")[0]!.amount).toBe(2n);
  });

  it("writes nothing when the adapter fails part-way through reading", async () => {
    const store = mem();
    const base = new ReplayAdapter(data());
    const broken: ChainAdapter = {
      chain: "solana",
      listTokens: () => base.listTokens(),
      listTrades: () => base.listTrades(),
      holderSnapshot: (t, a) => base.holderSnapshot(t, a),
      listSnapshots: () => Promise.reject(new Error("rpc down")),
    };
    await expect(ingest(store, broken)).rejects.toThrow("rpc down");
    expect(store.counts()).toEqual({ tokens: 0, trades: 0, snapshots: 0, rejects: 0 });
  });

  it("rolls everything back when a database write fails part-way", async () => {
    const store = mem();
    const real = store.insertTrade.bind(store);
    let calls = 0;
    vi.spyOn(store, "insertTrade").mockImplementation((chain, t) => {
      if (++calls === 2) throw new Error("disk full");
      return real(chain, t);
    });
    await expect(ingest(store, new ReplayAdapter(data()))).rejects.toThrow("disk full");
    expect(store.counts()).toEqual({ tokens: 0, trades: 0, snapshots: 0, rejects: 0 });
  });

  it("report counts always add up (seeded fuzz of valid, invalid and repeated trades)", async () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const trades: TradeEvent[] = [];
    const validIds = new Set<string>();
    for (let i = 0; i < 300; i++) {
      if (trades.length > 0 && rnd() < 0.15) {
        trades.push({ ...trades[Math.floor(rnd() * trades.length)]! }); // an exact copy
        continue;
      }
      const id = `t${Math.floor(rnd() * 120)}`; // plenty of same-id repeats with different content
      const invalid = rnd() < 0.2;
      const t = trade(id, { amount: invalid ? 0n : BigInt(1 + Math.floor(rnd() * 1000)), time: 1 + i });
      trades.push(t);
    }
    // The adapter would sort and could expose same-id repeats with different content; feed them as-is.
    const store = mem();
    const asIs: ChainAdapter = {
      chain: "solana",
      listTokens: async () => [],
      listTrades: async () => trades,
      holderSnapshot: async () => null,
      listSnapshots: async () => [],
    };
    const r = await ingest(store, asIs);
    expect(r.trades.received).toBe(300);
    expect(r.trades.inserted + r.trades.duplicates + r.trades.rejected).toBe(300);
    // the fuzz must actually reach all three outcomes, or it proves little
    expect(r.trades.inserted).toBeGreaterThan(20);
    expect(r.trades.duplicates).toBeGreaterThan(0);
    expect(r.trades.rejected).toBeGreaterThan(20);
    expect(store.counts("solana").trades).toBe(r.trades.inserted);
    expect(store.counts("solana").rejects).toBe(r.trades.rejected);
    // Every stored trade is valid and is the first valid one seen for its id.
    const firstValid = new Map<string, bigint>();
    for (const t of trades) if (t.amount > 0n && !firstValid.has(t.id)) firstValid.set(t.id, t.amount);
    for (const id of firstValid.keys()) validIds.add(id);
    const stored = store.tradesForToken("solana", "A");
    expect(stored.map((t) => t.id).sort()).toEqual([...validIds].sort());
    for (const t of stored) expect(t.amount).toBe(firstValid.get(t.id));
  });
});
