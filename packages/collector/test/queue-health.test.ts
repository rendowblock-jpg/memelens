import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli";
import { CollectorStore } from "../src/store";

const NOW = 10_000_000;
const SOON = 15 * 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function blank() {
  const store = new CollectorStore(":memory:");
  return store;
}
function task(store: CollectorStore, mint: string, kind: "snapshot" | "path72" | "path30d", dueAt: number, deadlineAt: number) {
  store.addLaunch({ mint, pool: `pool-${mint}`, name: mint, createdAt: 0, seenAt: 0, followed: true }, [{kind,dueAt,deadlineAt}]);
  return store.tasksOf(mint)[0]!;
}

describe("collector queue-health (only counts; never changes deadlines)", () => {
  it("reports zero for each kind when no tasks exist", () => {
    const store = blank();
    const result = store.queueHealth(NOW);
    expect(result).toEqual({ checkedAt: NOW, windowMs: SOON, kinds: {
      snapshot: {pending:0,runnable:0,retryWaiting:0,overdue:0,expiringSoon:0,nextDueAt:null,nextDeadlineAt:null},
      path72: {pending:0,runnable:0,retryWaiting:0,overdue:0,expiringSoon:0,nextDueAt:null,nextDeadlineAt:null},
      path30d: {pending:0,runnable:0,retryWaiting:0,overdue:0,expiringSoon:0,nextDueAt:null,nextDeadlineAt:null},
    } });
    store.close();
  });

  it("separates runnable, retrying, expired, and future tasks without modifying them", () => {
    const store = blank();
    task(store, "ready", "snapshot", NOW-1000, NOW+120_000);
    const retry = task(store, "retry", "snapshot", NOW-2000, NOW+600_000);
    store.failAttempt(retry.id, { now: NOW-1000, retryAt:NOW+1000, error:"429" });
    task(store, "expired", "snapshot", NOW-3000, NOW-1);
    task(store, "future", "snapshot", NOW+1000, NOW+SOON+1);
    task(store, "tomorrow", "path72", NOW+86_400_000, NOW+90_000_000);
    const done = task(store, "done", "snapshot", NOW-100, NOW+100);
    store.finishTask(done.id, NOW);
    const before = store.stats();
    const q = store.queueHealth(NOW);
    expect(q.kinds.snapshot).toEqual({
      pending:4, runnable:1, retryWaiting:1, overdue:1, expiringSoon:2,
      nextDueAt: NOW+1000, nextDeadlineAt: NOW+120_000,
    });
    expect(q.kinds.path72).toMatchObject({ pending:1, runnable:0, overdue:0, nextDueAt: NOW+86_400_000 });
    expect(q.kinds.path30d.pending).toBe(0);
    expect(store.stats()).toEqual(before);
    expect(store.tasksOf("expired")[0]?.status).toBe("pending"); // health does not sweep or label outcomes
    store.close();
  });

  it("treats deadlines at NOW and NOW+15 minutes as not overdue and expiring soon", () => {
    const store = blank();
    task(store, "at", "path30d", NOW, NOW);
    task(store, "near", "path30d", NOW+1, NOW+SOON);
    task(store, "after", "path30d", NOW+2, NOW+SOON+1);
    const q = store.queueHealth(NOW).kinds.path30d;
    expect(q.overdue).toBe(0);
    expect(q.runnable).toBe(1);
    expect(q.expiringSoon).toBe(2);
    expect(q.nextDueAt).toBe(NOW+1);
    expect(q.nextDeadlineAt).toBe(NOW);
    store.close();
  });

  it("rejects invalid clocks instead of silently misreporting risk", () => {
    const store = blank();
    for(const time of [NaN,-1,Infinity, 1.2, Number.MAX_SAFE_INTEGER+1]) expect(() => store.queueHealth(time)).toThrow(RangeError);
    store.close();
  });
});

describe("queue CLI", () => {
  const execute = (path: string) => spawnSync(process.execPath,["--disable-warning=ExperimentalWarning","--import","tsx",fileURLToPath(new URL("../src/bin.ts",import.meta.url)),"queue","--state",path], {encoding:"utf8",timeout:10000});
  it("accepts only an existing state path", () => {
    expect(parseCliArgs(["queue","--state","x.sqlite"])).toEqual({ command:"queue",state:"x.sqlite" });
    expect(() => parseCliArgs(["queue","--state","x.sqlite","--rate","1"])).toThrow(/unknown option/);
  });

  it("prints machine-readable queue data from an existing database", () => {
    const dir=mkdtempSync(join(tmpdir(),"memelens-queue-"));dirs.push(dir);const file=join(dir,"state.sqlite");
    const store=new CollectorStore(file);
    task(store,"abc","path72",Date.now()+60_000,Date.now()+2*60_000);
    store.close();
    const run=execute(file);
    expect(run.status).toBe(0);
    const result=JSON.parse(run.stdout);
    expect(result.checkedAt).toEqual(expect.any(Number));
    expect(result.windowMs).toBe(SOON);
    expect(result.kinds.path72).toMatchObject({pending:1,runnable:0,overdue:0});
    expect(result.kinds.snapshot.pending).toBe(0);
  });

  it("does not create a state file on a mistyped path", () => {
    const dir=mkdtempSync(join(tmpdir(),"memelens-queue-"));dirs.push(dir);const file=join(dir,"not-here.sqlite");
    const run=execute(file);
    expect(run.status).not.toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});
