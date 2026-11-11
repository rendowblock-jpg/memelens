import type { RejectRecord, Store } from "./store";
import type { ChainAdapter, HolderSnapshot, TokenInfo, TradeEvent } from "./types";

export interface IngestOptions {
  /** Unix ms stamped on rejects. Default: the current time. */
  now?: number;
}

export interface IngestReport {
  chain: string;
  tokens: { received: number; inserted: number; updated: number; unchanged: number; rejected: number };
  trades: { received: number; inserted: number; duplicates: number; rejected: number };
  snapshots: { received: number; inserted: number; duplicates: number; rejected: number };
  /** Count of rejected items per reason code, across tokens, trades and snapshots. */
  rejectReasons: Record<string, number>;
}

// ---------------------------------------------------------------------------------------------
// Validation. Anything that fails is rejected with a reason code and kept in the reject table.
// Nothing is repaired and nothing is dropped silently.
// ---------------------------------------------------------------------------------------------

function isTime(n: unknown): boolean {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function isNonEmpty(s: unknown): boolean {
  return typeof s === "string" && s.length > 0;
}

export function validateTrade(t: TradeEvent): string | null {
  if (!isNonEmpty(t.id)) return "id-empty";
  if (!isNonEmpty(t.wallet)) return "wallet-empty";
  if (!isNonEmpty(t.token)) return "token-empty";
  if (!isTime(t.time)) return "time-invalid";
  if (t.side !== "buy" && t.side !== "sell") return "side-invalid";
  if (typeof t.amount !== "bigint" || t.amount <= 0n) return "amount-not-positive";
  if (typeof t.quote !== "bigint" || t.quote < 0n) return "quote-negative";
  if (typeof t.fee !== "bigint" || t.fee < 0n) return "fee-negative";
  return null;
}

export function validateToken(t: TokenInfo): string | null {
  if (!isNonEmpty(t.token)) return "token-empty";
  if (typeof t.decimals !== "number" || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) {
    return "decimals-invalid";
  }
  if (!isTime(t.createdAt)) return "created-at-invalid";
  return null;
}

export function validateSnapshot(s: HolderSnapshot): string | null {
  if (!isNonEmpty(s.token)) return "token-empty";
  if (!isTime(s.time)) return "time-invalid";
  const seen = new Set<string>();
  for (const h of s.holdings) {
    if (!isNonEmpty(h.address)) return "holding-address-empty";
    if (typeof h.amount !== "bigint" || h.amount < 0n) return "holding-amount-invalid";
    if (seen.has(h.address)) return "holding-address-duplicate";
    seen.add(h.address);
  }
  return null;
}

function toJson(item: unknown): string {
  return JSON.stringify(item, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

// ---------------------------------------------------------------------------------------------
// Ingest: read everything from the adapter first (so a network failure writes nothing), then
// write it all in one transaction (so a database failure also leaves nothing half-written).
// Safe to repeat: identical rows count as duplicates; same id with different content is a conflict
// and is rejected, never overwritten.
// ---------------------------------------------------------------------------------------------

export async function ingest(store: Store, adapter: ChainAdapter, options: IngestOptions = {}): Promise<IngestReport> {
  const chain = adapter.chain;
  const now = options.now ?? Date.now();

  const tokens = await adapter.listTokens();
  const trades = await adapter.listTrades();
  const snapshots = await adapter.listSnapshots();

  const report: IngestReport = {
    chain,
    tokens: { received: tokens.length, inserted: 0, updated: 0, unchanged: 0, rejected: 0 },
    trades: { received: trades.length, inserted: 0, duplicates: 0, rejected: 0 },
    snapshots: { received: snapshots.length, inserted: 0, duplicates: 0, rejected: 0 },
    rejectReasons: {},
  };

  const reject = (kind: RejectRecord["kind"], ref: string, reason: string, item: unknown): void => {
    store.recordReject({ chain, kind, ref, reason, raw: toJson(item), at: now });
    report.rejectReasons[reason] = (report.rejectReasons[reason] ?? 0) + 1;
  };

  store.transaction(() => {
    for (const t of tokens) {
      const bad = validateToken(t);
      if (bad !== null) {
        report.tokens.rejected++;
        reject("token", t.token, bad, t);
        continue;
      }
      report.tokens[store.upsertToken(chain, t)]++;
    }

    for (const t of trades) {
      const bad = validateTrade(t);
      if (bad !== null) {
        report.trades.rejected++;
        reject("trade", t.id, bad, t);
        continue;
      }
      const result = store.insertTrade(chain, t);
      if (result === "inserted") report.trades.inserted++;
      else if (result === "duplicate") report.trades.duplicates++;
      else {
        report.trades.rejected++;
        reject("trade", t.id, "id-conflict", t);
      }
    }

    for (const s of snapshots) {
      const ref = `${s.token}@${s.time}`;
      const bad = validateSnapshot(s);
      if (bad !== null) {
        report.snapshots.rejected++;
        reject("snapshot", ref, bad, s);
        continue;
      }
      const result = store.insertSnapshot(chain, s);
      if (result === "inserted") report.snapshots.inserted++;
      else if (result === "duplicate") report.snapshots.duplicates++;
      else {
        report.snapshots.rejected++;
        reject("snapshot", ref, "id-conflict", s);
      }
    }
  });

  return report;
}
