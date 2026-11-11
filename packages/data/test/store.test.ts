import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaError, Store } from "../src/store";
import { snap, tok, trade } from "./helpers";

const opened: Store[] = [];
function mem(): Store {
  const s = Store.open(":memory:");
  opened.push(s);
  return s;
}
afterEach(() => {
  while (opened.length) {
    try {
      opened.pop()!.close();
    } catch {
      /* already closed */
    }
  }
});

describe("Store schema", () => {
  it("opens an empty in-memory database at schema version 1", () => {
    const s = mem();
    expect(s.schemaVersion()).toBe(1);
    expect(s.counts()).toEqual({ tokens: 0, trades: 0, snapshots: 0, rejects: 0 });
  });

  it("keeps data across close and reopen of a file database", () => {
    const dir = mkdtempSync(join(tmpdir(), "memelens-"));
    try {
      const path = join(dir, "t.sqlite");
      const a = Store.open(path);
      a.upsertToken("solana", tok("A", { creator: "C" }));
      a.insertTrade("solana", trade("t1"));
      a.close();
      const b = Store.open(path);
      opened.push(b);
      expect(b.schemaVersion()).toBe(1);
      expect(b.getToken("solana", "A")!.creator).toBe("C");
      expect(b.counts("solana").trades).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a database written by a newer version", () => {
    const dir = mkdtempSync(join(tmpdir(), "memelens-"));
    try {
      const path = join(dir, "t.sqlite");
      const a = Store.open(path);
      a.db.exec("PRAGMA user_version = 99");
      a.close();
      expect(() => Store.open(path)).toThrow(SchemaError);
      expect(() => Store.open(path)).toThrow(/newer/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the database itself rejects non-digit amounts and unknown sides", () => {
    const s = mem();
    const ins = (amount: string, side: string) =>
      s.db
        .prepare("INSERT INTO trade(chain,id,time,wallet,token,side,amount,quote,fee) VALUES('c','x',1,'w','t',?,?,'0','0')")
        .run(side, amount);
    expect(() => ins("abc", "buy")).toThrow(/constraint/i);
    expect(() => ins("-5", "buy")).toThrow(/constraint/i);
    expect(() => ins("1.5", "buy")).toThrow(/constraint/i);
    expect(() => ins("", "buy")).toThrow(/constraint/i);
    expect(() => ins("5", "hold")).toThrow(/constraint/i);
    expect(() => ins("5", "buy")).not.toThrow();
  });

  it("round-trips amounts far beyond 2^64 exactly", () => {
    const s = mem();
    const big = 10n ** 30n + 7n;
    s.insertTrade("c", trade("t1", { amount: big, quote: big + 1n, fee: big + 2n }));
    s.insertSnapshot("c", snap("A", 5, [["w", big + 3n]]));
    const t = s.tradesForToken("c", "A")[0]!;
    expect([t.amount, t.quote, t.fee]).toEqual([big, big + 1n, big + 2n]);
    expect(s.holderSnapshot("c", "A", 5)!.holdings[0]!.amount).toBe(big + 3n);
  });
});

describe("Store writes", () => {
  it("upsertToken reports inserted, unchanged, updated and keeps the latest", () => {
    const s = mem();
    expect(s.upsertToken("c", tok("A", { mintAuthorityActive: true }))).toBe("inserted");
    expect(s.upsertToken("c", tok("A", { mintAuthorityActive: true }))).toBe("unchanged");
    expect(s.upsertToken("c", tok("A", { mintAuthorityActive: false }))).toBe("updated");
    expect(s.getToken("c", "A")!.mintAuthorityActive).toBe(false);
    expect(s.counts("c").tokens).toBe(1);
  });

  it("keeps null, false and true distinct, and the excluded list in order", () => {
    const s = mem();
    s.upsertToken("c", tok("N", { mintAuthorityActive: null, freezeAuthorityActive: false, excluded: ["z", "a"] }));
    s.upsertToken("c", tok("T", { mintAuthorityActive: true, freezeAuthorityActive: null, symbol: null }));
    const n = s.getToken("c", "N")!;
    expect(n.mintAuthorityActive).toBeNull();
    expect(n.freezeAuthorityActive).toBe(false);
    expect(n.excluded).toEqual(["z", "a"]);
    const t = s.getToken("c", "T")!;
    expect(t.mintAuthorityActive).toBe(true);
    expect(t.freezeAuthorityActive).toBeNull();
    expect(t.symbol).toBeNull();
    expect(s.getToken("c", "missing")).toBeNull();
  });

  it("insertTrade reports inserted, duplicate and conflict, and never overwrites", () => {
    const s = mem();
    expect(s.insertTrade("c", trade("t1"))).toBe("inserted");
    expect(s.insertTrade("c", trade("t1"))).toBe("duplicate");
    expect(s.insertTrade("c", trade("t1", { amount: 999n }))).toBe("conflict");
    expect(s.tradesForToken("c", "A")).toHaveLength(1);
    expect(s.tradesForToken("c", "A")[0]!.amount).toBe(100n);
  });

  it("a conflict is detected on any field, not just the amount", () => {
    const s = mem();
    s.insertTrade("c", trade("t1"));
    for (const over of [{ time: 2001 }, { wallet: "W2" }, { token: "B" }, { side: "sell" as const }, { quote: 11n }, { fee: 1n }]) {
      expect(s.insertTrade("c", trade("t1", over))).toBe("conflict");
    }
  });

  it("the same trade id on two chains is two trades", () => {
    const s = mem();
    expect(s.insertTrade("solana", trade("t1"))).toBe("inserted");
    expect(s.insertTrade("base", trade("t1", { amount: 5n }))).toBe("inserted");
    expect(s.counts("solana").trades).toBe(1);
    expect(s.counts("base").trades).toBe(1);
    expect(s.counts().trades).toBe(2);
  });

  it("insertSnapshot reports inserted, duplicate (order-insensitive) and conflict", () => {
    const s = mem();
    expect(s.insertSnapshot("c", snap("A", 10, [["w1", 5n], ["w2", 6n]]))).toBe("inserted");
    expect(s.insertSnapshot("c", snap("A", 10, [["w2", 6n], ["w1", 5n]]))).toBe("duplicate");
    expect(s.insertSnapshot("c", snap("A", 10, [["w1", 5n], ["w2", 7n]]))).toBe("conflict");
    expect(s.insertSnapshot("c", snap("A", 11, [["w1", 5n]]))).toBe("inserted");
    expect(s.counts("c").snapshots).toBe(2);
  });

  it("transaction commits on success and rolls back, rethrowing, on error", () => {
    const s = mem();
    s.transaction(() => {
      s.insertTrade("c", trade("t1"));
    });
    expect(s.counts().trades).toBe(1);
    expect(() =>
      s.transaction(() => {
        s.insertTrade("c", trade("t2"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.counts().trades).toBe(1);
    // and the connection is still usable afterwards
    s.insertTrade("c", trade("t3"));
    expect(s.counts().trades).toBe(2);
  });

  it("a nested transaction joins the outer one and rolls back with it", () => {
    const s = mem();
    expect(() =>
      s.transaction(() => {
        s.insertTrade("c", trade("t1"));
        s.transaction(() => {
          s.insertTrade("c", trade("t2"));
        });
        expect(s.counts().trades).toBe(2);
        throw new Error("outer fails");
      }),
    ).toThrow("outer fails");
    expect(s.counts().trades).toBe(0);
    s.transaction(() => {
      s.transaction(() => {
        s.insertTrade("c", trade("t3"));
      });
    });
    expect(s.counts().trades).toBe(1);
  });

  it("records rejects with their raw payload and filters them by chain", () => {
    const s = mem();
    s.recordReject({ chain: "a", kind: "trade", ref: "t1", reason: "amount-not-positive", raw: "{}", at: 5 });
    s.recordReject({ chain: "b", kind: "token", ref: "X", reason: "bad", raw: "{\"x\":1}", at: 6 });
    expect(s.rejects("a")).toEqual([{ chain: "a", kind: "trade", ref: "t1", reason: "amount-not-positive", raw: "{}", at: 5 }]);
    expect(s.rejects()).toHaveLength(2);
    expect(s.counts("b").rejects).toBe(1);
  });
});

describe("Store reads", () => {
  function seeded(): Store {
    const s = mem();
    s.insertTrade("c", trade("b", { time: 200, wallet: "w1", token: "A", side: "buy", amount: 10n, quote: 100n, fee: 1n }));
    s.insertTrade("c", trade("a", { time: 200, wallet: "w2", token: "A", side: "buy", amount: 20n, quote: 220n }));
    s.insertTrade("c", trade("z", { time: 300, wallet: "w1", token: "A", side: "sell", amount: 5n, quote: 70n }));
    s.insertTrade("c", trade("m", { time: 400, wallet: "w1", token: "B", side: "buy", amount: 7n, quote: 7n }));
    s.insertTrade("other", trade("q", { time: 250, wallet: "w1", token: "A", amount: 1n, quote: 1n }));
    return s;
  }

  it("tradesForWallet returns core Trades oldest first, ties by id, for that wallet and chain only", () => {
    const t = seeded().tradesForWallet("c", "w1");
    expect(t.map((x) => x.id)).toEqual(["b", "z", "m"]);
    expect(t[0]).toEqual({ id: "b", time: 200, token: "A", side: "buy", amount: 10n, quote: 100n, fee: 1n });
    expect("wallet" in t[0]!).toBe(false);
  });

  it("tradesForWallet asOf is inclusive and hides later trades", () => {
    const s = seeded();
    expect(s.tradesForWallet("c", "w1", 300).map((x) => x.id)).toEqual(["b", "z"]);
    expect(s.tradesForWallet("c", "w1", 299).map((x) => x.id)).toEqual(["b"]);
    expect(s.tradesForWallet("c", "w1", 199)).toEqual([]);
  });

  it("tradesForToken returns trades with their wallet, filtered by token and asOf", () => {
    const s = seeded();
    expect(s.tradesForToken("c", "A").map((x) => [x.id, x.wallet])).toEqual([["a", "w2"], ["b", "w1"], ["z", "w1"]]);
    expect(s.tradesForToken("c", "A", 250).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("walletsWithTrades is distinct and sorted, and honours `to`", () => {
    const s = seeded();
    expect(s.walletsWithTrades("c")).toEqual(["w1", "w2"]);
    expect(s.walletsWithTrades("c", 150)).toEqual([]);
    expect(s.walletsWithTrades("c", 200)).toEqual(["w1", "w2"]);
    s.insertTrade("c", trade("late", { time: 900, wallet: "w0" }));
    expect(s.walletsWithTrades("c", 500)).toEqual(["w1", "w2"]);
    expect(s.walletsWithTrades("c")).toEqual(["w0", "w1", "w2"]);
  });

  it("lastMark is the latest trade at or before asOf (ties: larger id), or null", () => {
    const s = seeded();
    expect(s.lastMark("c", "A")).toEqual({ amount: 5n, quote: 70n });
    expect(s.lastMark("c", "A", 299)).toEqual({ amount: 10n, quote: 100n }); // "b" beats "a" at t=200
    expect(s.lastMark("c", "A", 199)).toBeNull();
    expect(s.lastMark("c", "NOPE")).toBeNull();
    expect(s.lastMark("other", "B")).toBeNull();
  });

  it("ties on time are ordered by id, whatever order they were inserted in", () => {
    const s = mem();
    for (const id of ["m3", "m1", "m2"]) {
      s.insertTrade("c", trade(id, { time: 500, wallet: "w", token: "T", amount: BigInt(id.slice(1)) }));
    }
    expect(s.tradesForWallet("c", "w").map((x) => x.id)).toEqual(["m1", "m2", "m3"]);
    expect(s.tradesForToken("c", "T").map((x) => x.id)).toEqual(["m1", "m2", "m3"]);
    expect(s.lastMark("c", "T")).toEqual({ amount: 3n, quote: 10n });
    expect(s.lastMark("c", "T", 500)).toEqual({ amount: 3n, quote: 10n });
  });

  it("holderSnapshot returns the newest snapshot at or before asOf", () => {
    const s = mem();
    s.insertSnapshot("c", snap("A", 10, [["w", 1n]]));
    s.insertSnapshot("c", snap("A", 20, [["w", 2n]]));
    s.insertSnapshot("c", snap("B", 15, [["w", 9n]]));
    expect(s.holderSnapshot("c", "A", 9)).toBeNull();
    expect(s.holderSnapshot("c", "A", 19)!.holdings).toEqual([{ address: "w", amount: 1n }]);
    expect(s.holderSnapshot("c", "A", 20)!.time).toBe(20);
    expect(s.holderSnapshot("c", "A", 1e12)!.time).toBe(20);
    expect(s.holderSnapshot("other", "A", 1e12)).toBeNull();
  });

  it("listTokens is sorted by creation time then address and honours asOf", () => {
    const s = mem();
    s.upsertToken("c", tok("B", { createdAt: 50 }));
    s.upsertToken("c", tok("A", { createdAt: 50 }));
    s.upsertToken("c", tok("C", { createdAt: 10 }));
    expect(s.listTokens("c").map((t) => t.token)).toEqual(["C", "A", "B"]);
    expect(s.listTokens("c", 49).map((t) => t.token)).toEqual(["C"]);
    expect(s.listTokens("c", 50).map((t) => t.token)).toEqual(["C", "A", "B"]);
    expect(s.listTokens("other")).toEqual([]);
  });
});
