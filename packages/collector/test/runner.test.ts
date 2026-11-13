import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE } from "../src/plan";
import { Collector, retryDelayMs } from "../src/runner";
import { isFollowed } from "../src/sampling";
import { CollectorStore } from "../src/store";

const fixtureText = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const T0 = Date.parse("2026-11-13T09:00:00Z");

type Reply = { status: number; body: string };
const ok = (body: string): Reply => ({ status: 200, body });

/** A network that answers from a script and remembers every address it was asked for. */
class Web {
  calls: string[] = [];
  headers: Array<Record<string, string> | undefined> = [];
  private routes: Array<{ test: (u: string) => boolean; replies: Reply[]; used: number }> = [];
  on(match: string | RegExp, ...replies: Reply[]): this {
    this.routes.push({ test: typeof match === "string" ? (u) => u === match : (u) => match.test(u), replies, used: 0 });
    return this;
  }
  async get(url: string, headers?: Record<string, string>) {
    this.calls.push(url);
    this.headers.push(headers);
    const route = this.routes.find((r) => r.test(url));
    if (route === undefined) return { status: 0, text: `unexpected request: ${url}`, attempts: 1 };
    const reply = route.replies[Math.min(route.used++, route.replies.length - 1)]!;
    return { status: reply.status, text: reply.body, attempts: 1 };
  }
  callsTo(part: string): string[] {
    return this.calls.filter((c) => c.includes(part));
  }
}

const pool = (mint: string, address: string, createdAt: number, dex = "pump-fun") => ({
  attributes: { address, name: `${mint} / SOL`, pool_created_at: new Date(createdAt).toISOString().replace(".000Z", "Z") },
  relationships: { base_token: { data: { id: `solana_${mint}` } }, dex: { data: { id: dex } } },
});
const page = (...pools: unknown[]): string => JSON.stringify({ data: pools });

let clockNow = T0;
const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(web: Web, over: { rate?: number; windowMs?: number; store?: CollectorStore } = {}) {
  const store = over.store ?? new CollectorStore(":memory:");
  const lines: string[] = [];
  const collector = new Collector({ store, client: web, now: () => clockNow, rate: over.rate ?? 1, ...(over.windowMs === undefined ? {} : { windowMs: over.windowMs }), log: (l) => lines.push(l) });
  return { store, collector, lines };
}

describe("discovery", () => {
  it("stores the pump.fun launches of a real page, follows all of them at rate 1, and plans three tasks for each", async () => {
    clockNow = Date.parse("2026-11-13T09:30:00Z");
    const web = new Web().on(`${GT}/new_pools?page=1`, ok(fixtureText("gt-new-pools.json"))).on(`${GT}/new_pools?page=2`, ok(page()));
    const { store, collector } = make(web);
    const r = await collector.discover();
    expect(r).toMatchObject({ polled: true, seen: 11, added: 11, followed: 11, skipped: 0, windowClosed: false });
    expect(store.stats().launches).toBe(11);
    expect(store.tasksOf("2xqTL8FKS7GR1s6VLbSXNbkyRQjAhsz114afbMGvpump").map((t) => t.kind)).toEqual(["snapshot", "path72", "path30d"]);
    expect((await collector.discover()).added).toBe(0); // the same page again adds nothing
    expect(store.stats().launches).toBe(11);
  });

  it("asks for the version GeckoTerminal documents", async () => {
    clockNow = T0 + 2 * MINUTE;
    const web = new Web().on(/new_pools/, ok(page()));
    await make(web).collector.discover();
    expect(web.headers[0]).toEqual({ accept: "application/json;version=20230302" });
  });

  it("at a rate below 1 follows exactly the launches the sampling rule picks, and plans nothing for the others", async () => {
    clockNow = Date.parse("2026-11-13T09:30:00Z");
    const web = new Web().on(`${GT}/new_pools?page=1`, ok(fixtureText("gt-new-pools.json"))).on(/page=2/, ok(page()));
    const store = new CollectorStore(":memory:");
    const collector = new Collector({ store, client: web, now: () => clockNow, rate: 0.2 });
    const r = await collector.discover();
    const mints = JSON.parse(fixtureText("gt-new-pools.json")).data.filter((p: { relationships: { dex: { data: { id: string } } } }) => p.relationships.dex.data.id === "pump-fun").map((p: { relationships: { base_token: { data: { id: string } } } }) => p.relationships.base_token.data.id.slice(7)) as string[];
    const expected = mints.filter((m) => isFollowed(m, 0.2));
    expect(r.followed).toBe(expected.length);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(11);
    for (const m of mints) expect(store.tasksOf(m).length).toBe(expected.includes(m) ? 3 : 0);
    expect(store.stats().launches).toBe(11); // all are recorded as seen, so the coverage can be reported
    expect(store.stats().followed).toBe(expected.length);
  });

  it("follows a tenth by default", async () => {
    clockNow = T0 + 2 * MINUTE;
    const between = "So11111111111111111111111111111111111111112"; // fraction 0.18: followed at 0.2, not at 0.1
    const web = new Web().on(/page=1/, ok(page(pool("m46", "P46", T0), pool(between, "PB", T0), pool("m0", "P0", T0)))).on(/page=2/, ok(page()));
    const store = new CollectorStore(":memory:");
    const collector = new Collector({ store, client: web, now: () => clockNow });
    expect(await collector.discover()).toMatchObject({ added: 3, followed: 1 });
    expect(store.tasksOf("m46")).toHaveLength(3);
    expect(store.tasksOf(between)).toHaveLength(0);
    expect(store.tasksOf("m0")).toHaveLength(0);
  });

  it("refuses a rate outside 0..1 when it is built, not at the first launch", () => {
    for (const rate of [-0.1, 1.5, Number.NaN]) expect(() => new Collector({ store: new CollectorStore(":memory:"), client: new Web(), now: () => 0, rate })).toThrow(RangeError);
  });

  it("records when discovery began, once", async () => {
    clockNow = T0 + 2 * MINUTE;
    const web = new Web().on(/new_pools/, ok(page()));
    const { store, collector } = make(web);
    await collector.discover();
    expect(store.getMeta("discovery_started_at")).toBe(String(T0 + 2 * MINUTE));
    clockNow += 10 * MINUTE;
    await collector.discover();
    expect(store.getMeta("discovery_started_at")).toBe(String(T0 + 2 * MINUTE));
  });

  it("stops looking when the window is over, without a single request", async () => {
    clockNow = T0 + 2 * MINUTE;
    const web = new Web().on(/new_pools/, ok(page()));
    const { collector } = make(web, { windowMs: 72 * HOUR });
    await collector.discover(); // this poll starts the window
    clockNow = T0 + 2 * MINUTE + 72 * HOUR;
    expect((await collector.discover()).windowClosed).toBe(false); // its last instant still counts
    const calls = web.calls.length;
    clockNow += 1;
    expect(await collector.discover()).toMatchObject({ polled: false, windowClosed: true });
    expect(web.calls.length).toBe(calls);
  });

  it("does not follow a launch first seen more than 30 minutes after its pool was created, but records that it was seen", async () => {
    const web = new Web().on(/page=1/, ok(page(pool("OLD", "P-OLD", T0), pool("EDGE", "P-EDGE", T0 + 1), pool("NEW", "P-NEW", T0 + 20 * MINUTE)))).on(/page=2/, ok(page()));
    clockNow = T0 + 30 * MINUTE + 1;
    const { store, collector } = make(web);
    const r = await collector.discover();
    expect(r).toMatchObject({ added: 3, followed: 2 }); // OLD is 30 min + 1 ms old, EDGE exactly 30 min
    expect(store.tasksOf("OLD")).toHaveLength(0);
    expect(store.tasksOf("EDGE")).toHaveLength(3);
    expect(store.tasksOf("NEW")).toHaveLength(3);
    expect(store.hasLaunch("OLD")).toBe(true);
  });

  it("reads page 2 as well when every launch on page 1 is new, and only page 1 when one is already known", async () => {
    clockNow = T0 + 2 * MINUTE;
    const web = new Web().on(/page=1/, ok(page(pool("A", "PA", T0), pool("B", "PB", T0)))).on(/page=2/, ok(page(pool("C", "PC", T0 - MINUTE))));
    const { store, collector } = make(web);
    const first = await collector.discover();
    expect(web.callsTo("page=2")).toHaveLength(1);
    expect(first.added).toBe(3);
    await collector.discover();
    expect(web.callsTo("page=2")).toHaveLength(1); // page 1 had known launches this time
    expect(store.stats().launches).toBe(3);
  });

  it("keeps what page 1 gave when page 2 fails", async () => {
    clockNow = T0 + 2 * MINUTE;
    const web = new Web().on(/page=1/, ok(page(pool("A", "PA", T0)))).on(/page=2/, { status: 500, body: "" });
    const r = await make(web).collector.discover();
    expect(r.added).toBe(1);
    expect(r.error).toBeUndefined();
  });

  it("reports a failed poll (HTTP 429 after the client's own retries) and stores nothing, then works on the next poll", async () => {
    clockNow = T0 + 2 * MINUTE;
    const web = new Web().on(/page=1/, { status: 429, body: "slow" }, ok(page(pool("A", "PA", T0)))).on(/page=2/, ok(page()));
    const { store, collector } = make(web);
    const bad = await collector.discover();
    expect(bad.error).toMatch(/429/);
    expect(store.stats().launches).toBe(0);
    expect((await collector.discover()).added).toBe(1);
  });

  it("reports a reply of the wrong shape instead of throwing", async () => {
    clockNow = T0 + 2 * MINUTE;
    const web = new Web().on(/page=1/, ok('{"errors":[{"status":"500"}]}'));
    const r = await make(web).collector.discover();
    expect(r.error).toMatch(/new_pools/);
  });

  it("reports a reply that is not JSON", async () => {
    clockNow = T0 + 2 * MINUTE;
    const web = new Web().on(/page=1/, ok("<html>maintenance</html>"));
    expect((await make(web).collector.discover()).error).toMatch(/JSON/i);
  });

  it("counts pump.fun pools it could not read", async () => {
    clockNow = T0 + 2 * MINUTE;
    const broken = pool("X", "PX", T0);
    (broken.attributes as { pool_created_at: string }).pool_created_at = "garbage";
    const web = new Web().on(/page=1/, ok(page(broken, pool("A", "PA", T0)))).on(/page=2/, ok(page()));
    expect(await make(web).collector.discover()).toMatchObject({ added: 1, skipped: 1 });
  });
});

// One launch, followed, created at T0.
function oneLaunch(web: Web) {
  web.on(/page=1/, ok(page(pool("MINT1", "POOL1", T0)))).on(/page=2/, ok(page()));
  const made = make(web);
  clockNow = T0 + 2 * MINUTE;
  return made;
}
const REPORT = `https://api.rugcheck.xyz/v1/tokens/MINT1/report`;
const MINUTES = `${GT}/pools/POOL1/ohlcv/minute?aggregate=1&limit=100&currency=usd`;

describe("the first-hour snapshot", () => {
  it("waits until +60 minutes and makes no request before that", async () => {
    const web = new Web();
    const { collector } = oneLaunch(web);
    await collector.discover();
    web.calls.length = 0;
    clockNow = T0 + 60 * MINUTE - 1;
    expect(await collector.workOne()).toEqual({ status: "idle" });
    expect(web.calls).toEqual([]);
  });

  it("reads the RugCheck report and the first-hour minute candles, saves both exactly as received, and finishes", async () => {
    const web = new Web().on(REPORT, ok(fixtureText("rugcheck-report-established.json"))).on(MINUTES, ok(fixtureText("gt-ohlcv-minute.json")));
    const { store, collector } = oneLaunch(web);
    await collector.discover();
    clockNow = T0 + 61 * MINUTE;
    const r = await collector.workOne();
    expect(r).toMatchObject({ status: "done", kind: "snapshot", mint: "MINT1" });
    const task = store.tasksOf("MINT1")[0]!;
    expect(task).toMatchObject({ status: "done", doneAt: T0 + 61 * MINUTE });
    const saved = store.payloads(task.id);
    expect(saved.map((p) => p.step)).toEqual(["candles-minute", "report"]);
    expect(saved.find((p) => p.step === "report")).toMatchObject({ url: REPORT, status: 200, valid: true, fetchedAt: T0 + 61 * MINUTE, body: fixtureText("rugcheck-report-established.json") });
    expect(saved.find((p) => p.step === "candles-minute")).toMatchObject({ url: MINUTES, valid: true });
    expect(web.headers[web.calls.indexOf(MINUTES)]).toEqual({ accept: "application/json;version=20230302" });
  });

  it("saves a 404 from RugCheck as 'nothing there' and still finishes the task", async () => {
    const web = new Web().on(REPORT, { status: 404, body: '{"error":"not found"}' }).on(MINUTES, ok(fixtureText("gt-ohlcv-minute.json")));
    const { store, collector } = oneLaunch(web);
    await collector.discover();
    clockNow = T0 + 61 * MINUTE;
    expect((await collector.workOne()).status).toBe("done");
    expect(store.payloads(store.tasksOf("MINT1")[0]!.id).find((p) => p.step === "report")).toMatchObject({ status: 404, valid: true });
  });

  it("does not finish when a source fails, counts the attempt, and retries after a minute", async () => {
    const web = new Web().on(REPORT, { status: 503, body: "down" }).on(MINUTES, ok(fixtureText("gt-ohlcv-minute.json")));
    const { store, collector } = oneLaunch(web);
    await collector.discover();
    clockNow = T0 + 61 * MINUTE;
    const r = await collector.workOne();
    expect(r).toMatchObject({ status: "retry", kind: "snapshot" });
    expect(store.tasksOf("MINT1")[0]).toMatchObject({ status: "pending", attempts: 1, nextTryAt: T0 + 62 * MINUTE, lastError: "report: HTTP 503" });
    clockNow = T0 + 62 * MINUTE - 1;
    expect((await collector.workOne()).status).toBe("idle");
  });

  it("doubles the wait with each failure and never waits more than 30 minutes", async () => {
    const web = new Web().on(REPORT, { status: 503, body: "" }).on(MINUTES, ok(fixtureText("gt-ohlcv-minute.json")));
    const { store, collector } = oneLaunch(web);
    await collector.discover();
    const waits: number[] = [];
    clockNow = T0 + 60 * MINUTE;
    for (let i = 0; i < 3; i++) {
      await collector.workOne();
      const t = store.tasksOf("MINT1")[0]!;
      waits.push(t.nextTryAt - clockNow);
      clockNow = t.nextTryAt;
    }
    expect(waits).toEqual([60_000, 120_000, 240_000]);
  });

  it("on a retry reads only the step that is still missing", async () => {
    const web = new Web().on(REPORT, ok(fixtureText("rugcheck-report-established.json"))).on(MINUTES, { status: 502, body: "" }, ok(fixtureText("gt-ohlcv-minute.json")));
    const { store, collector } = oneLaunch(web);
    await collector.discover();
    clockNow = T0 + 60 * MINUTE;
    expect((await collector.workOne()).status).toBe("retry");
    clockNow = T0 + 62 * MINUTE;
    expect((await collector.workOne()).status).toBe("done");
    expect(web.callsTo("rugcheck")).toHaveLength(1);
    expect(web.callsTo("ohlcv/minute")).toHaveLength(2);
    expect(store.payloads(store.tasksOf("MINT1")[0]!.id).map((p) => p.step)).toEqual(["candles-minute", "report"]);
  });

  it("keeps a 200 reply of the wrong shape as evidence, marks it invalid, and tries again", async () => {
    const web = new Web().on(REPORT, ok("<html>captcha</html>"), ok(fixtureText("rugcheck-report-established.json"))).on(MINUTES, ok(fixtureText("gt-ohlcv-minute.json")));
    const { store, collector } = oneLaunch(web);
    await collector.discover();
    clockNow = T0 + 60 * MINUTE;
    expect((await collector.workOne()).status).toBe("retry");
    const id = store.tasksOf("MINT1")[0]!.id;
    expect(store.payloads(id).find((p) => p.step === "report")).toMatchObject({ valid: false, body: "<html>captcha</html>" });
    expect(store.tasksOf("MINT1")[0]?.lastError).toBe("report: unexpected reply");
    clockNow = T0 + 62 * MINUTE;
    expect((await collector.workOne()).status).toBe("done");
    expect(store.payloads(id).find((p) => p.step === "report")?.valid).toBe(true);
  });

  it("gives up on a task past its deadline and never reads it late", async () => {
    const web = new Web();
    const { store, collector } = oneLaunch(web);
    await collector.discover();
    web.calls.length = 0;
    clockNow = T0 + 75 * MINUTE + 1;
    expect(await collector.workOne()).toEqual({ status: "idle" });
    expect(store.tasksOf("MINT1")[0]?.status).toBe("missed");
    expect(web.calls).toEqual([]);
  });

  it("runs one task per call, the one that became due first", async () => {
    const web = new Web().on(/page=1/, ok(page(pool("LATE", "P2", T0 + 10 * MINUTE), pool("EARLY", "P1", T0)))).on(/page=2/, ok(page())).on(/rugcheck/, ok(fixtureText("rugcheck-report-established.json"))).on(/ohlcv/, ok(fixtureText("gt-ohlcv-minute.json")));
    clockNow = T0 + 12 * MINUTE;
    const { collector } = make(web);
    await collector.discover();
    clockNow = T0 + 71 * MINUTE;
    expect(await collector.workOne()).toMatchObject({ mint: "EARLY" });
    expect(await collector.workOne()).toMatchObject({ mint: "LATE" });
    expect((await collector.workOne()).status).toBe("idle");
  });
});

describe("the 72-hour and 30-day paths", () => {
  const POOLS = `${GT}/tokens/MINT1/pools?page=1`;
  const hour = (p: string) => `${GT}/pools/${p}/ohlcv/hour?aggregate=1&limit=1000&currency=usd`;
  const tokenPools = (...rows: Array<[string, string, string | null]>): string =>
    JSON.stringify({ data: rows.map(([address, dex, reserve]) => ({ attributes: { address, reserve_in_usd: reserve, volume_usd: { h24: "10" } }, relationships: { dex: { data: { id: dex } } } })) });

  async function atPath72(web: Web) {
    const made = oneLaunch(web);
    await made.collector.discover();
    // the snapshot is missed, so only the path task is in play
    clockNow = T0 + 79 * MINUTE;
    await made.collector.workOne();
    clockNow = T0 + 72 * HOUR;
    return made;
  }

  it("reads the report, the token's pools, and the hourly candles of the launch pool and the best other pools: three pools at most", async () => {
    const web = new Web()
      .on(REPORT, ok(fixtureText("rugcheck-report-established.json")))
      .on(POOLS, ok(tokenPools(["POOL9", "pumpswap", "900"], ["POOL1", "pump-fun", "5"], ["POOL7", "pumpswap", "50"], ["POOL8", "raydium", "10"])))
      .on(/ohlcv\/hour/, ok(fixtureText("gt-ohlcv-hour.json")));
    const { store, collector } = await atPath72(web);
    expect(await collector.workOne()).toMatchObject({ status: "done", kind: "path72" });
    expect(web.calls.filter((c) => c.includes("ohlcv/hour"))).toEqual([hour("POOL1"), hour("POOL9"), hour("POOL7")]);
    const task = store.tasksOf("MINT1").find((t) => t.kind === "path72")!;
    expect(task.status).toBe("done");
    expect(store.payloads(task.id).map((p) => p.step)).toEqual(["candles-hour:POOL1", "candles-hour:POOL7", "candles-hour:POOL9", "report", "token-pools"]);
  });

  it("reads only the launch pool's candles when the token's pools are not known (404)", async () => {
    const web = new Web().on(REPORT, ok(fixtureText("rugcheck-report-established.json"))).on(POOLS, { status: 404, body: "{}" }).on(/ohlcv\/hour/, ok(fixtureText("gt-ohlcv-hour.json")));
    const { collector } = await atPath72(web);
    expect((await collector.workOne()).status).toBe("done");
    expect(web.calls.filter((c) => c.includes("ohlcv/hour"))).toEqual([hour("POOL1")]);
  });

  it("does not read a pool's candles twice on a retry", async () => {
    const web = new Web()
      .on(REPORT, ok(fixtureText("rugcheck-report-established.json")))
      .on(POOLS, ok(tokenPools(["POOL1", "pump-fun", "5"], ["POOL7", "pumpswap", "50"])))
      .on(hour("POOL1"), ok(fixtureText("gt-ohlcv-hour.json")))
      .on(hour("POOL7"), { status: 500, body: "" }, ok(fixtureText("gt-ohlcv-hour.json")));
    const { collector } = await atPath72(web);
    expect((await collector.workOne()).status).toBe("retry");
    clockNow += 60_000;
    expect((await collector.workOne()).status).toBe("done");
    expect(web.callsTo(hour("POOL1"))).toHaveLength(1);
    expect(web.callsTo(hour("POOL7"))).toHaveLength(2);
    expect(web.callsTo("rugcheck")).toHaveLength(1);
  });

  it("does the same at +30 days", async () => {
    const web = new Web().on(REPORT, ok(fixtureText("rugcheck-report-established.json"))).on(POOLS, ok(tokenPools(["POOL1", "pump-fun", "5"]))).on(/ohlcv\/hour/, ok(fixtureText("gt-ohlcv-hour.json")));
    const { store, collector } = await atPath72(web);
    await collector.workOne(); // path72
    clockNow = T0 + 30 * DAY;
    expect(await collector.workOne()).toMatchObject({ status: "done", kind: "path30d" });
    expect(store.tasksOf("MINT1").map((t) => t.status)).toEqual(["missed", "done", "done"]);
  });
});

describe("a restart", () => {
  it("carries on from the state file: the launch is not added twice and its pending task is run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-run-"));
    cleanup.push(dir);
    const file = join(dir, "state.sqlite");
    const web1 = new Web().on(/page=1/, ok(page(pool("MINT1", "POOL1", T0)))).on(/page=2/, ok(page()));
    clockNow = T0 + 2 * MINUTE;
    const first = make(web1, { store: new CollectorStore(file) });
    expect((await first.collector.discover()).added).toBe(1);
    first.store.close();

    const web2 = new Web().on(/page=1/, ok(page(pool("MINT1", "POOL1", T0)))).on(REPORT, ok(fixtureText("rugcheck-report-established.json"))).on(MINUTES, ok(fixtureText("gt-ohlcv-minute.json")));
    const second = make(web2, { store: new CollectorStore(file) });
    expect((await second.collector.discover()).added).toBe(0);
    clockNow = T0 + 61 * MINUTE;
    expect(await second.collector.workOne()).toMatchObject({ status: "done", mint: "MINT1" });
    second.store.close();
  });
});

describe("the retry delay", () => {
  it("is a minute after the first failure and doubles, up to 30 minutes", () => {
    expect([0, 1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000]);
    expect(retryDelayMs(6)).toBe(1_800_000);
    expect(retryDelayMs(500)).toBe(1_800_000);
  });
});
