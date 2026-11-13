import type { HttpResult } from "./http";
import { isCandles, isReport, parseNewPools, parseTokenPools, ParseError } from "./parse";
import { HOUR, MINUTE, planTasks, type TaskKind } from "./plan";
import { isFollowed } from "./sampling";
import type { CollectorStore, DueTask } from "./store";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const GT_HEADERS = { accept: "application/json;version=20230302" };

/** A launch first seen more than this long after its pool was created is recorded but not followed (the +60 min reading could not be on time). */
export const FOLLOW_LATE_MS = 30 * MINUTE;
/** How long discovery runs from the first poll. */
export const DEFAULT_WINDOW_MS = 72 * HOUR;
/** Hourly candles are read for the launch pool and the best other pools, this many in all. */
export const MAX_POOLS = 3;

/** How long to wait before trying a task again: a minute after the first failure, doubling, never more than 30 minutes. */
export function retryDelayMs(failuresSoFar: number): number {
  return Math.min(30 * MINUTE, MINUTE * 2 ** Math.min(failuresSoFar, 20));
}

export interface CollectorDeps {
  store: CollectorStore;
  client: { get(url: string, headers?: Record<string, string>): Promise<HttpResult> };
  now: () => number;
  /** The share of launches followed, 0..1. Default 0.1. */
  rate?: number;
  windowMs?: number;
  log?: (line: string) => void;
}

export interface DiscoverResult {
  polled: boolean;
  windowClosed: boolean;
  /** pump.fun launches read from the page or pages. */
  seen: number;
  /** Of those, not stored before. */
  added: number;
  followed: number;
  /** pump.fun pools whose fields could not be read. */
  skipped: number;
  error?: string;
}

export type WorkResult = { status: "idle" } | { status: "done" | "retry"; kind: TaskKind; mint: string; error?: string };

const reportUrl = (mint: string): string => `https://api.rugcheck.xyz/v1/tokens/${mint}/report`;
const minuteUrl = (pool: string): string => `${GT}/pools/${pool}/ohlcv/minute?aggregate=1&limit=100&currency=usd`;
const hourUrl = (pool: string): string => `${GT}/pools/${pool}/ohlcv/hour?aggregate=1&limit=1000&currency=usd`;
const tokenPoolsUrl = (mint: string): string => `${GT}/tokens/${mint}/pools?page=1`;

const parsesAs = (check: (json: unknown) => boolean) => (text: string): boolean => {
  try {
    return check(JSON.parse(text));
  } catch {
    return false;
  }
};
const isReportText = parsesAs(isReport);
const isCandlesText = parsesAs(isCandles);
const isTokenPoolsText = parsesAs((json) => {
  try {
    parseTokenPools(json);
    return true;
  } catch {
    return false;
  }
});

/**
 * Finds pump.fun launches as they appear, follows the sampled ones, and reads each followed token at the times the
 * protocol fixes. It makes no judgement about any token: it keeps what the sources said, exactly as received.
 */
export class Collector {
  private readonly store: CollectorStore;
  private readonly client: CollectorDeps["client"];
  private readonly now: () => number;
  private readonly rate: number;
  private readonly windowMs: number;
  private readonly log: (line: string) => void;

  constructor(deps: CollectorDeps) {
    this.store = deps.store;
    this.client = deps.client;
    this.now = deps.now;
    this.rate = deps.rate ?? 0.1;
    this.windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
    this.log = deps.log ?? (() => undefined);
    isFollowed("check", this.rate); // refuses a rate outside 0..1 now, not at the first launch
  }

  /** One look at GeckoTerminal's newest pools. Never throws: a bad poll is reported in `error` and the next poll goes on. */
  async discover(): Promise<DiscoverResult> {
    const now = this.now();
    const startedText = this.store.getMeta("discovery_started_at");
    const started = startedText === null ? now : Number(startedText);
    if (startedText === null) this.store.setMeta("discovery_started_at", String(now));
    const result: DiscoverResult = { polled: false, windowClosed: false, seen: 0, added: 0, followed: 0, skipped: 0 };
    if (now > started + this.windowMs) return { ...result, windowClosed: true };
    result.polled = true;

    const first = await this.page(1);
    if ("error" in first) return { ...result, error: first.error };
    const known = first.launches.filter((l) => this.store.hasLaunch(l.mint)).length;
    this.take(first, now, result);
    // A page of 20 pools covers about a minute and a half; when none of its launches was known the poll may have missed some.
    if (first.launches.length > 0 && known === 0) {
      const second = await this.page(2);
      if (!("error" in second)) this.take(second, now, result);
    }
    if (result.added > 0) this.log(`discover: ${result.added} new, ${result.followed} followed (${result.seen} seen${result.skipped > 0 ? `, ${result.skipped} unreadable` : ""})`);
    return result;
  }

  /** Runs the one task that became due first, if any. */
  async workOne(): Promise<WorkResult> {
    const now = this.now();
    const missed = this.store.sweepMissed(now);
    if (missed > 0) this.log(`${missed} task(s) given up: past their deadline`);
    const task = this.store.dueTasks(now, 1)[0];
    if (task === undefined) return { status: "idle" };
    const errors = await this.run(task);
    if (errors.length === 0) {
      this.store.finishTask(task.id, this.now());
      this.log(`done ${task.kind} ${task.mint}`);
      return { status: "done", kind: task.kind, mint: task.mint };
    }
    const error = errors.join("; ");
    this.store.failAttempt(task.id, { now, retryAt: now + retryDelayMs(task.attempts), error });
    this.log(`retry ${task.kind} ${task.mint}: ${error}`);
    return { status: "retry", kind: task.kind, mint: task.mint, error };
  }

  private async page(n: number): Promise<{ launches: ReturnType<typeof parseNewPools>["launches"]; skipped: number } | { error: string }> {
    const r = await this.client.get(`${GT}/new_pools?page=${n}`, GT_HEADERS);
    if (r.status !== 200) return { error: `new_pools page ${n}: ${r.status === 0 ? `no answer (${r.text.slice(0, 120)})` : `HTTP ${r.status}`}` };
    let json: unknown;
    try {
      json = JSON.parse(r.text);
    } catch {
      return { error: `new_pools page ${n}: the reply is not JSON` };
    }
    try {
      return parseNewPools(json);
    } catch (error) {
      return { error: error instanceof ParseError ? `new_pools page ${n}: ${error.message}` : String(error) };
    }
  }

  private take(page: { launches: ReturnType<typeof parseNewPools>["launches"]; skipped: number }, now: number, result: DiscoverResult): void {
    result.skipped += page.skipped;
    for (const launch of page.launches) {
      result.seen++;
      const followed = now - launch.createdAt <= FOLLOW_LATE_MS && isFollowed(launch.mint, this.rate);
      const added = this.store.addLaunch({ ...launch, seenAt: now, followed }, followed ? planTasks(launch.createdAt) : []);
      if (added) {
        result.added++;
        if (followed) result.followed++;
      }
    }
  }

  /** Reads every step the task needs that is not saved yet. Returns what went wrong; an empty list means the task is complete. */
  private async run(task: DueTask): Promise<string[]> {
    const saved = this.store.savedSteps(task.id);
    const errors: string[] = [];

    /** The body of one step: read from the network unless a valid copy is already saved. Null when there is nothing usable. */
    const step = async (name: string, url: string, headers: Record<string, string>, valid: (text: string) => boolean): Promise<string | null> => {
      if (saved.has(name)) return this.store.payloads(task.id).find((p) => p.step === name)?.body ?? null;
      const r = await this.client.get(url, headers);
      if (r.status === 404) {
        this.store.savePayload(task.id, { step: name, url, fetchedAt: this.now(), status: 404, valid: true, body: r.text });
        return null;
      }
      if (r.status !== 200) {
        errors.push(`${name}: ${r.status === 0 ? `no answer (${r.text.slice(0, 120)})` : `HTTP ${r.status}`}`);
        return null;
      }
      const ok = valid(r.text);
      this.store.savePayload(task.id, { step: name, url, fetchedAt: this.now(), status: 200, valid: ok, body: r.text });
      if (!ok) {
        errors.push(`${name}: unexpected reply`);
        return null;
      }
      return r.text;
    };

    await step("report", reportUrl(task.mint), {}, isReportText);
    if (task.kind === "snapshot") {
      await step("candles-minute", minuteUrl(task.pool), GT_HEADERS, isCandlesText);
      return errors;
    }
    const poolsText = await step("token-pools", tokenPoolsUrl(task.mint), GT_HEADERS, isTokenPoolsText);
    const others = poolsText === null ? [] : parseTokenPools(JSON.parse(poolsText)).map((p) => p.pool).filter((p) => p !== task.pool);
    for (const pool of [task.pool, ...others].slice(0, MAX_POOLS)) await step(`candles-hour:${pool}`, hourUrl(pool), GT_HEADERS, isCandlesText);
    return errors;
  }
}
