/** A reply that is not the shape the source documents. The caller records it and moves on; nothing is guessed. */
export class ParseError extends Error {}

export interface Launch {
  /** Token (mint) address, without GeckoTerminal's "solana_" prefix. */
  mint: string;
  /** The bonding-curve pool's address. */
  pool: string;
  name: string;
  /** Unix ms, GeckoTerminal's `pool_created_at`. */
  createdAt: number;
}

export interface PoolInfo {
  pool: string;
  dex: string;
  /** Liquidity in USD, or null when not given. */
  reserveUsd: number | null;
  volume24hUsd: number | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

function dataList(json: unknown, what: string): unknown[] {
  const data = obj(json)?.["data"];
  if (!Array.isArray(data)) throw new ParseError(`${what}: the reply has no "data" list`);
  return data;
}

const dexOf = (pool: Json): string | null => str(obj(obj(obj(pool["relationships"])?.["dex"])?.["data"])?.["id"]);

/**
 * The pump.fun launches in a GeckoTerminal `new_pools` page. Pools of other venues are ignored (not counted). A pump.fun
 * pool whose address, token or time cannot be read is counted in `skipped`, not repaired.
 */
export function parseNewPools(json: unknown): { launches: Launch[]; skipped: number } {
  const launches: Launch[] = [];
  let skipped = 0;
  for (const raw of dataList(json, "new_pools")) {
    const pool = obj(raw);
    if (pool === null || dexOf(pool) !== "pump-fun") continue;
    const attributes = obj(pool["attributes"]);
    const baseId = str(obj(obj(obj(pool["relationships"])?.["base_token"])?.["data"])?.["id"]);
    const address = str(attributes?.["address"]);
    const created = str(attributes?.["pool_created_at"]);
    const createdAt = created === null ? Number.NaN : Date.parse(created);
    if (address === null || baseId === null || !baseId.startsWith("solana_") || baseId.length <= 7 || !Number.isFinite(createdAt)) {
      skipped++;
      continue;
    }
    launches.push({ mint: baseId.slice(7), pool: address, name: str(attributes?.["name"]) ?? "", createdAt });
  }
  return { launches, skipped };
}

/** A token's pools from GeckoTerminal, the one with the most liquidity first (unknown liquidity last). */
export function parseTokenPools(json: unknown): PoolInfo[] {
  const out: PoolInfo[] = [];
  for (const raw of dataList(json, "token pools")) {
    const attributes = obj(obj(raw)?.["attributes"]);
    const pool = str(attributes?.["address"]);
    const dex = dexOf(obj(raw) ?? {});
    if (pool === null || dex === null) continue;
    out.push({ pool, dex, reserveUsd: num(attributes?.["reserve_in_usd"]), volume24hUsd: num(obj(attributes?.["volume_usd"])?.["h24"]) });
  }
  return out.sort((a, b) => (b.reserveUsd ?? -1) - (a.reserveUsd ?? -1));
}

/** A RugCheck report that has what the scoring needs: the token and its holder list. Stored whole, never rewritten. */
export function isReport(json: unknown): boolean {
  const o = obj(json);
  return o !== null && str(o["mint"]) !== null && Array.isArray(o["topHolders"]);
}

/** A GeckoTerminal candle reply: a list of [time, open, high, low, close, volume] rows (possibly empty). */
export function isCandles(json: unknown): boolean {
  const list = obj(obj(obj(json)?.["data"])?.["attributes"])?.["ohlcv_list"];
  return Array.isArray(list) && list.every((row) => Array.isArray(row) && row.length === 6 && row.every((x) => typeof x === "number" && Number.isFinite(x)));
}
