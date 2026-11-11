import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Mark, Trade } from "@memelens/core";
import type { HolderSnapshot, TokenInfo, TradeEvent } from "./types";

export const SCHEMA_VERSION = 1;

export class SchemaError extends Error {}

export type WriteResult = "inserted" | "duplicate" | "conflict";

export interface RejectRecord {
  chain: string;
  kind: "trade" | "token" | "snapshot";
  /** Id of the rejected item (trade id, token address, "token@time"). */
  ref: string;
  reason: string;
  /** JSON of the rejected item, so nothing is lost. */
  raw: string;
  /** Unix ms when it was rejected. */
  at: number;
}

export interface Counts {
  tokens: number;
  trades: number;
  snapshots: number;
  rejects: number;
}

// Amounts are stored as decimal TEXT, never INTEGER: SQLite integers stop at 2^63 and a token supply
// can exceed that. Consequence: SQL cannot add or compare amounts; all arithmetic happens in
// @memelens/core on bigint. The CHECKs make the database refuse anything that is not plain digits.
const DIGITS_CHECK = (col: string) => `${col} <> '' AND ${col} NOT GLOB '*[^0-9]*'`;

const SCHEMA = `
CREATE TABLE token (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  decimals INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  creator TEXT,
  mint_authority_active INTEGER CHECK (mint_authority_active IN (0, 1)),
  freeze_authority_active INTEGER CHECK (freeze_authority_active IN (0, 1)),
  excluded TEXT NOT NULL,
  PRIMARY KEY (chain, address)
) WITHOUT ROWID;

CREATE TABLE trade (
  chain TEXT NOT NULL,
  id TEXT NOT NULL,
  time INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  token TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  amount TEXT NOT NULL CHECK (${DIGITS_CHECK("amount")}),
  quote TEXT NOT NULL CHECK (${DIGITS_CHECK("quote")}),
  fee TEXT NOT NULL CHECK (${DIGITS_CHECK("fee")}),
  PRIMARY KEY (chain, id)
) WITHOUT ROWID;
CREATE INDEX trade_wallet_time ON trade (chain, wallet, time, id);
CREATE INDEX trade_token_time ON trade (chain, token, time, id);

CREATE TABLE holder_snapshot (
  chain TEXT NOT NULL,
  token TEXT NOT NULL,
  time INTEGER NOT NULL,
  holdings TEXT NOT NULL,
  PRIMARY KEY (chain, token, time)
) WITHOUT ROWID;

CREATE TABLE ingest_reject (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

type Row = Record<string, string | number | null>;

const MAX_TIME = Number.MAX_SAFE_INTEGER;

function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function encodeHoldings(s: HolderSnapshot): string {
  const sorted = [...s.holdings].sort((a, b) => codeUnitOrder(a.address, b.address));
  return JSON.stringify(sorted.map((h) => [h.address, h.amount.toString()]));
}

function decodeHoldings(json: string): HolderSnapshot["holdings"] {
  return (JSON.parse(json) as Array<[string, string]>).map(([address, amount]) => ({ address, amount: BigInt(amount) }));
}

function boolToDb(v: boolean | null): number | null {
  return v === null ? null : v ? 1 : 0;
}

function dbToBool(v: string | number | null): boolean | null {
  return v === null ? null : v === 1;
}

function rowToToken(r: Row): TokenInfo {
  return {
    token: r["address"] as string,
    symbol: r["symbol"] as string | null,
    decimals: r["decimals"] as number,
    createdAt: r["created_at"] as number,
    creator: r["creator"] as string | null,
    mintAuthorityActive: dbToBool(r["mint_authority_active"] ?? null),
    freezeAuthorityActive: dbToBool(r["freeze_authority_active"] ?? null),
    excluded: JSON.parse(r["excluded"] as string) as string[],
  };
}

export class Store {
  /** The raw connection. For tests and for this package's own modules; app code goes through the methods. */
  readonly db: DatabaseSync;
  private depth = 0;
  private readonly cache = new Map<string, StatementSync>();

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): Store {
    const db = new DatabaseSync(path);
    const store = new Store(db);
    try {
      if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
      const version = store.schemaVersion();
      if (version > SCHEMA_VERSION) {
        throw new SchemaError(
          `database schema version ${version} is newer than this app understands (${SCHEMA_VERSION}); update the app`,
        );
      }
      if (version === 0) {
        store.transaction(() => {
          db.exec(SCHEMA);
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        });
      }
    } catch (e) {
      db.close();
      throw e;
    }
    return store;
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }

  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as Row;
    return row["user_version"] as number;
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  /** Runs `fn` atomically. A nested call joins the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* the original error is the one that matters */
      }
      throw e;
    } finally {
      this.depth--;
    }
  }

  // ------------------------------------------------------------------ writes

  upsertToken(chain: string, t: TokenInfo): "inserted" | "updated" | "unchanged" {
    const existing = this.getToken(chain, t.token);
    const values = [
      t.symbol,
      t.decimals,
      t.createdAt,
      t.creator,
      boolToDb(t.mintAuthorityActive),
      boolToDb(t.freezeAuthorityActive),
      JSON.stringify(t.excluded),
    ] as const;
    if (existing === null) {
      this.stmt(
        "INSERT INTO token(symbol,decimals,created_at,creator,mint_authority_active,freeze_authority_active,excluded,chain,address) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(...values, chain, t.token);
      return "inserted";
    }
    if (JSON.stringify(existing) === JSON.stringify(t)) return "unchanged";
    this.stmt(
      "UPDATE token SET symbol=?,decimals=?,created_at=?,creator=?,mint_authority_active=?,freeze_authority_active=?,excluded=? WHERE chain=? AND address=?",
    ).run(...values, chain, t.token);
    return "updated";
  }

  insertTrade(chain: string, t: TradeEvent): WriteResult {
    const info = this.stmt(
      "INSERT OR IGNORE INTO trade(chain,id,time,wallet,token,side,amount,quote,fee) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(chain, t.id, t.time, t.wallet, t.token, t.side, t.amount.toString(), t.quote.toString(), t.fee.toString());
    if (info.changes === 1) return "inserted";
    const row = this.stmt("SELECT id,time,wallet,token,side,amount,quote,fee FROM trade WHERE chain=? AND id=?").get(chain, t.id) as Row;
    const same =
      row["time"] === t.time &&
      row["wallet"] === t.wallet &&
      row["token"] === t.token &&
      row["side"] === t.side &&
      row["amount"] === t.amount.toString() &&
      row["quote"] === t.quote.toString() &&
      row["fee"] === t.fee.toString();
    return same ? "duplicate" : "conflict";
  }

  insertSnapshot(chain: string, s: HolderSnapshot): WriteResult {
    const encoded = encodeHoldings(s);
    const info = this.stmt("INSERT OR IGNORE INTO holder_snapshot(chain,token,time,holdings) VALUES(?,?,?,?)").run(
      chain,
      s.token,
      s.time,
      encoded,
    );
    if (info.changes === 1) return "inserted";
    const row = this.stmt("SELECT holdings FROM holder_snapshot WHERE chain=? AND token=? AND time=?").get(chain, s.token, s.time) as Row;
    return row["holdings"] === encoded ? "duplicate" : "conflict";
  }

  recordReject(r: RejectRecord): void {
    this.stmt("INSERT INTO ingest_reject(chain,kind,ref,reason,raw,at) VALUES(?,?,?,?,?,?)").run(
      r.chain,
      r.kind,
      r.ref,
      r.reason,
      r.raw,
      r.at,
    );
  }

  // ------------------------------------------------------------------- reads

  rejects(chain?: string): RejectRecord[] {
    const rows = (
      chain === undefined
        ? this.stmt("SELECT chain,kind,ref,reason,raw,at FROM ingest_reject ORDER BY seq").all()
        : this.stmt("SELECT chain,kind,ref,reason,raw,at FROM ingest_reject WHERE chain=? ORDER BY seq").all(chain)
    ) as Row[];
    return rows.map((r) => ({
      chain: r["chain"] as string,
      kind: r["kind"] as RejectRecord["kind"],
      ref: r["ref"] as string,
      reason: r["reason"] as string,
      raw: r["raw"] as string,
      at: r["at"] as number,
    }));
  }

  counts(chain?: string): Counts {
    const one = (table: string): number => {
      const row = (
        chain === undefined
          ? this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
          : this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE chain=?`).get(chain)
      ) as Row;
      return row["n"] as number;
    };
    return { tokens: one("token"), trades: one("trade"), snapshots: one("holder_snapshot"), rejects: one("ingest_reject") };
  }

  getToken(chain: string, token: string): TokenInfo | null {
    const row = this.stmt("SELECT * FROM token WHERE chain=? AND address=?").get(chain, token) as Row | undefined;
    return row ? rowToToken(row) : null;
  }

  listTokens(chain: string, asOf: number = MAX_TIME): TokenInfo[] {
    const rows = this.stmt("SELECT * FROM token WHERE chain=? AND created_at<=? ORDER BY created_at, address").all(chain, asOf) as Row[];
    return rows.map(rowToToken);
  }

  tradesForWallet(chain: string, wallet: string, asOf: number = MAX_TIME): Trade[] {
    const rows = this.stmt(
      "SELECT id,time,token,side,amount,quote,fee FROM trade WHERE chain=? AND wallet=? AND time<=? ORDER BY time, id",
    ).all(chain, wallet, asOf) as Row[];
    return rows.map((r) => ({
      id: r["id"] as string,
      time: r["time"] as number,
      token: r["token"] as string,
      side: r["side"] as Trade["side"],
      amount: BigInt(r["amount"] as string),
      quote: BigInt(r["quote"] as string),
      fee: BigInt(r["fee"] as string),
    }));
  }

  tradesForToken(chain: string, token: string, asOf: number = MAX_TIME): TradeEvent[] {
    const rows = this.stmt(
      "SELECT id,time,wallet,token,side,amount,quote,fee FROM trade WHERE chain=? AND token=? AND time<=? ORDER BY time, id",
    ).all(chain, token, asOf) as Row[];
    return rows.map((r) => ({
      id: r["id"] as string,
      time: r["time"] as number,
      wallet: r["wallet"] as string,
      token: r["token"] as string,
      side: r["side"] as TradeEvent["side"],
      amount: BigInt(r["amount"] as string),
      quote: BigInt(r["quote"] as string),
      fee: BigInt(r["fee"] as string),
    }));
  }

  walletsWithTrades(chain: string, to: number = MAX_TIME): string[] {
    const rows = this.stmt("SELECT DISTINCT wallet FROM trade WHERE chain=? AND time<=? ORDER BY wallet").all(chain, to) as Row[];
    return rows.map((r) => r["wallet"] as string);
  }

  /** The price of the most recent trade at or before `asOf`. A weak mark for thin markets; callers should say so. */
  lastMark(chain: string, token: string, asOf: number = MAX_TIME): Mark | null {
    const row = this.stmt("SELECT amount,quote FROM trade WHERE chain=? AND token=? AND time<=? ORDER BY time DESC, id DESC LIMIT 1").get(
      chain,
      token,
      asOf,
    ) as Row | undefined;
    return row ? { amount: BigInt(row["amount"] as string), quote: BigInt(row["quote"] as string) } : null;
  }

  holderSnapshot(chain: string, token: string, asOf: number): HolderSnapshot | null {
    const row = this.stmt("SELECT time,holdings FROM holder_snapshot WHERE chain=? AND token=? AND time<=? ORDER BY time DESC LIMIT 1").get(
      chain,
      token,
      asOf,
    ) as Row | undefined;
    return row ? { token, time: row["time"] as number, holdings: decodeHoldings(row["holdings"] as string) } : null;
  }
}
