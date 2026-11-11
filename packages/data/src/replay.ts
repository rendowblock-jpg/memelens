import type { Side } from "@memelens/core";
import type { ChainAdapter, HolderSnapshot, TokenInfo, TradeEvent, TradeRange } from "./types";

export class FixtureError extends Error {}

export interface ReplayData {
  chain: string;
  tokens: TokenInfo[];
  trades: TradeEvent[];
  snapshots: HolderSnapshot[];
}

// ---------------------------------------------------------------------------------------------
// Fixture parsing. Fixtures are authored by us, so a malformed one fails loudly with its path.
// Amounts are decimal strings in JSON (JSON numbers lose precision above 2^53).
// ---------------------------------------------------------------------------------------------

const DIGITS = /^[0-9]+$/;

function fail(path: string, what: string): never {
  throw new FixtureError(`${path}: ${what}`);
}

function asObject(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "must be an object");
  return v as Record<string, unknown>;
}

function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "must be an array");
  return v;
}

function asString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) fail(path, "must be a non-empty string");
  return v;
}

function asNullableString(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  return asString(v, path);
}

function asTime(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(path, "must be a non-negative integer (unix ms)");
  return v;
}

function asNullableBool(v: unknown, path: string): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "boolean") fail(path, "must be true, false or null");
  return v;
}

function asBig(v: unknown, path: string, positive: boolean): bigint {
  if (typeof v !== "string" || !DIGITS.test(v)) fail(path, 'must be a decimal string of digits, e.g. "1000"');
  const n = BigInt(v);
  if (positive && n <= 0n) fail(path, "must be greater than 0");
  return n;
}

const SIDES: readonly Side[] = ["buy", "sell"];

export function parseFixture(json: unknown): ReplayData {
  const root = asObject(json, "fixture");
  if (root["format"] !== "memelens-fixture") fail("format", 'must be "memelens-fixture"');
  if (root["version"] !== 1) fail("version", "only version 1 is supported");
  const chain = asString(root["chain"], "chain");

  const tokens: TokenInfo[] = asArray(root["tokens"], "tokens").map((raw, i) => {
    const p = `tokens[${i}]`;
    const o = asObject(raw, p);
    const decimals = o["decimals"];
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      fail(`${p}.decimals`, "must be an integer from 0 to 36");
    }
    return {
      token: asString(o["token"], `${p}.token`),
      symbol: asNullableString(o["symbol"], `${p}.symbol`),
      decimals,
      createdAt: asTime(o["createdAt"], `${p}.createdAt`),
      creator: asNullableString(o["creator"], `${p}.creator`),
      mintAuthorityActive: asNullableBool(o["mintAuthorityActive"], `${p}.mintAuthorityActive`),
      freezeAuthorityActive: asNullableBool(o["freezeAuthorityActive"], `${p}.freezeAuthorityActive`),
      excluded: asArray(o["excluded"] ?? [], `${p}.excluded`).map((a, j) => asString(a, `${p}.excluded[${j}]`)),
    };
  });

  const seen = new Set<string>();
  const trades: TradeEvent[] = asArray(root["trades"], "trades").map((raw, i) => {
    const p = `trades[${i}]`;
    const o = asObject(raw, p);
    const id = asString(o["id"], `${p}.id`);
    if (seen.has(id)) fail(`${p}.id`, `duplicate trade id "${id}"`);
    seen.add(id);
    const side = o["side"];
    if (typeof side !== "string" || !SIDES.includes(side as Side)) fail(`${p}.side`, 'must be "buy" or "sell"');
    return {
      id,
      time: asTime(o["time"], `${p}.time`),
      wallet: asString(o["wallet"], `${p}.wallet`),
      token: asString(o["token"], `${p}.token`),
      side: side as Side,
      amount: asBig(o["amount"], `${p}.amount`, true),
      quote: asBig(o["quote"], `${p}.quote`, false),
      fee: o["fee"] === undefined ? 0n : asBig(o["fee"], `${p}.fee`, false),
    };
  });

  const snapshots: HolderSnapshot[] = asArray(root["snapshots"] ?? [], "snapshots").map((raw, i) => {
    const p = `snapshots[${i}]`;
    const o = asObject(raw, p);
    return {
      token: asString(o["token"], `${p}.token`),
      time: asTime(o["time"], `${p}.time`),
      holdings: asArray(o["holdings"], `${p}.holdings`).map((h, j) => {
        const hp = `${p}.holdings[${j}]`;
        const ho = asObject(h, hp);
        return { address: asString(ho["address"], `${hp}.address`), amount: asBig(ho["amount"], `${hp}.amount`, false) };
      }),
    };
  });

  return { chain, tokens, trades, snapshots };
}

// ---------------------------------------------------------------------------------------------
// ReplayAdapter: serves recorded data. `clock` is the replay's "now": nothing after it is visible,
// no matter what range or asOf the caller asks for. That is the look-ahead guard for backtests.
//
// Known limit: token metadata (authority flags, creator) is a single recorded state, not a history.
// A backtest must not rely on flags that could have changed after `clock`.
// ---------------------------------------------------------------------------------------------

function byTimeThenId(a: { time: number; id: string }, b: { time: number; id: string }): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class ReplayAdapter implements ChainAdapter {
  readonly chain: string;
  readonly clock: number;
  private readonly data: ReplayData;

  constructor(data: ReplayData, clock: number = Infinity) {
    this.data = structuredClone(data);
    this.chain = data.chain;
    this.clock = clock;
  }

  /** A view of the same data that can only see up to `clock`. The original is unchanged. */
  withClock(clock: number): ReplayAdapter {
    return new ReplayAdapter(this.data, clock);
  }

  async listTokens(): Promise<TokenInfo[]> {
    return structuredClone(this.data.tokens.filter((t) => t.createdAt <= this.clock));
  }

  async listTrades(range: TradeRange = {}): Promise<TradeEvent[]> {
    const from = range.from ?? -Infinity;
    const to = Math.min(range.to ?? Infinity, this.clock);
    const out = this.data.trades.filter(
      (t) =>
        t.time >= from &&
        t.time <= to &&
        (range.token === undefined || t.token === range.token) &&
        (range.wallet === undefined || t.wallet === range.wallet),
    );
    out.sort(byTimeThenId);
    return structuredClone(out);
  }

  async holderSnapshot(token: string, asOf: number): Promise<HolderSnapshot | null> {
    const limit = Math.min(asOf, this.clock);
    let best: HolderSnapshot | null = null;
    for (const s of this.data.snapshots) {
      if (s.token === token && s.time <= limit && (best === null || s.time > best.time)) best = s;
    }
    return best === null ? null : structuredClone(best);
  }

  async listSnapshots(token?: string): Promise<HolderSnapshot[]> {
    const out = this.data.snapshots.filter((s) => s.time <= this.clock && (token === undefined || s.token === token));
    out.sort((a, b) => a.time - b.time);
    return structuredClone(out);
  }
}
