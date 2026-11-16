import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorStore } from "../packages/collector/src/store";
import { auditWaves } from "./collector-wave-audit.mjs";

const AT = 1_000_000;
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file() {
  const dir = mkdtempSync(join(tmpdir(), "memelens-wave-audit-"));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}

function task(s, mint, kind, dueAt, deadlineAt) {
  s.addLaunch({ mint, pool: mint + "pool", name: mint, createdAt: 100, seenAt: 200, followed: true },
    [{ kind, dueAt, deadlineAt }]);
  return s.tasksOf(mint)[0];
}

function payload(s, id, step, status, at, valid = true, body = "{}") {
  if (step.startsWith("candles-hour:") && status === 200 && body === "{}") {
    body = JSON.stringify({ data: { attributes: { ohlcv_list: [] } } });
  }
  s.savePayload(id, { step, url: "https://example.test/" + step, fetchedAt: at, status, valid, body });
}

describe("prospective outcome wave audit", () => {
  it("is a read-only census of both empty waves with an explicit clock", () => {
    const path = file();
    const s = new CollectorStore(path);
    s.close();
    const x = auditWaves(path, AT);
    expect(x.checkedAt).toBe(AT);
    expect(x.scope).toMatch(/not token risk labels/);
    for (const kind of ["path72", "path30d"]) {
      expect(Object.values(x.waves[kind])).toEqual(Array(19).fill(0));
    }
  });

  it("separates due success, missed, waiting, future and API evidence without changing the state", () => {
    const path = file();
    const s = new CollectorStore(path);
    const a = task(s, "A", "path72", 950_000, 1_200_000);
    expect(s.finishTask(a.id, 1_010_000)).toBe(true);
    payload(s, a.id, "report", 200, 1_010_000);
    payload(s, a.id, "token-pools", 404, 1_010_000);
    payload(s, a.id, "candles-hour:pool", 200, 1_010_000);
    const miss = task(s, "MISS", "path72", 900_000, 920_000);
    expect(s.sweepMissed(AT)).toBe(1);
    expect(s.tasksOf("MISS")[0].status).toBe("missed");
    const retry = task(s, "RETRY", "path72", 990_000, 1_040_000);
    s.failAttempt(retry.id, { now: 999_000, retryAt: 1_001_000, error: "HTTP 429" });
    task(s, "EXPIRED", "path72", 960_000, 999_999);
    task(s, "FUTURE", "path72", 1_001_000, 1_300_000);
    const qualityGap = task(s, "GAP", "path72", 900_000, 1_100_000);
    s.finishTask(qualityGap.id, 999_999);
    payload(s, qualityGap.id, "report", 503, 1_100_001, false);
    const p30 = task(s, "THIRTY", "path30d", 980_000, 1_400_000);
    s.finishTask(p30.id, AT);
    payload(s, p30.id, "report", 404, AT);
    payload(s, p30.id, "token-pools", 200, AT);
    task(s, "FUTURE30", "path30d", 10_000_000, 20_000_000);
    const before = s.stats();
    const audit = auditWaves(path, AT);
    expect(audit.waves.path72).toEqual({
      scheduled: 6, due: 5, completed: 2, missed: 1, pendingDue: 2, pendingFuture: 1,
      retryWaiting: 1, overduePending: 1, retriedDue: 1,
      completedOutsideWindow: 0, completedWithLatePayload: 1,
      report200: 1, report404: 0, pools200: 0, pools404: 1, hourlyValid: 1,
      hourlyEligibleTasks: 0, hourlyIneligibleTasks: 2, eligibleHourlyCandleRows: 0,
    });
    expect(audit.waves.path30d).toEqual({
      scheduled: 2, due: 1, completed: 1, missed: 0, pendingDue: 0, pendingFuture: 1,
      retryWaiting: 0, overduePending: 0, retriedDue: 0,
      completedOutsideWindow: 0, completedWithLatePayload: 0,
      report200: 0, report404: 1, pools200: 1, pools404: 0, hourlyValid: 0,
      hourlyEligibleTasks: 0, hourlyIneligibleTasks: 1, eligibleHourlyCandleRows: 0,
    });
    expect(s.stats()).toEqual(before);
    expect(s.tasksOf("RETRY")[0].status).toBe("pending");
    expect(s.tasksOf("EXPIRED")[0].status).toBe("pending");
    s.close();
  });

  it("counts only fully elapsed hourly price candles after scoring, not merely successful HTTP responses", () => {
    const path = file();
    const s = new CollectorStore(path);
    const H = 3_600_000;
    const scoredAt = 10 * H + 30_000;
    const dueAt = 14 * H;
    for (const mint of ["ELIGIBLE", "BEFORE_ONLY"]) {
      const t = task(s, mint, "path72", dueAt, dueAt + 6 * H);
      s.addTasks(mint, [{ kind: "snapshot", dueAt: 9 * H, deadlineAt: 11 * H }]);
      const first = s.tasksOf(mint).find((x) => x.kind === "snapshot");
      expect(s.finishTask(first.id, scoredAt)).toBe(true);
      payload(s, first.id, "report", 200, scoredAt);
      expect(s.finishTask(t.id, dueAt + 3000)).toBe(true);
      const stamps = mint === "ELIGIBLE" ? [10, 11, 13, 14] : [9, 10];
      const body = JSON.stringify({ data: { attributes: { ohlcv_list: stamps.map((h) => [h * 3600, 1, 2, 0.5, 1, 5]) } } });
      payload(s, t.id, "candles-hour:pool", 200, dueAt + 3000, true, body);
    }
    const x = auditWaves(path, dueAt + 5000).waves.path72;
    expect(x).toMatchObject({ completed: 2, hourlyValid: 2, hourlyEligibleTasks: 1,
      hourlyIneligibleTasks: 1, eligibleHourlyCandleRows: 2 });
    expect(s.stats().tasks.path72.done).toBe(2);
    s.close();
  });

  it("refuses to present corrupted stored hourly evidence as a successful quality audit", () => {
    const path = file();
    const s = new CollectorStore(path);
    const t = task(s, "BROKEN", "path72", AT - 100, AT + 100);
    s.addTasks("BROKEN", [{ kind: "snapshot", dueAt: AT - 200, deadlineAt: AT - 100 }]);
    const snapshot = s.tasksOf("BROKEN").find((x) => x.kind === "snapshot");
    expect(s.finishTask(snapshot.id, AT - 150)).toBe(true);
    payload(s, snapshot.id, "report", 200, AT - 150);
    expect(s.finishTask(t.id, AT)).toBe(true);
    payload(s, t.id, "candles-hour:pool", 200, AT, true, '{"data":null}');
    const before = s.stats();
    expect(() => auditWaves(path, AT)).toThrow(/unreadable valid hourly-candle reply/);
    expect(s.stats()).toEqual(before);
    s.close();
  });

  it("checks exact due/deadline boundaries, and detects completed tasks with inconsistent times", () => {
    const path = file();
    const s = new CollectorStore(path);
    const a = task(s, "A", "path72", AT, AT);
    s.finishTask(a.id, AT);
    const future = task(s, "FUTURE", "path72", AT + 1, AT + 2);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE task SET done_at = ? WHERE id = ?").run(AT + 1, a.id);
    db.close();
    const x = auditWaves(path, AT);
    expect(x.waves.path72).toMatchObject({ due: 1, completed: 1, pendingFuture: 1, completedOutsideWindow: 1, overduePending: 0 });
    expect(future.dueAt).toBe(AT + 1);
    s.close();
  });

  it("refuses missing files, unsupported schemas, and invalid timestamps without creating state", () => {
    const missing = file();
    expect(() => auditWaves(missing, AT)).toThrow();
    expect(existsSync(missing)).toBe(false);
    const path = file();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 98");
    db.close();
    expect(() => auditWaves(path, AT)).toThrow(/schema version/);
    for (const at of [NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => auditWaves(path, at)).toThrow(RangeError);
    }
    const check = new DatabaseSync(path, {readOnly:true});
    expect(check.prepare("PRAGMA user_version").get().user_version).toBe(98);
    check.close();
  });

  it("prints structured JSON from a real child process and refuses missing state", () => {
    const path = file();
    const s = new CollectorStore(path);
    task(s, "A", "path72", 1, 2);
    s.close();
    const cli = fileURLToPath(new URL("./collector-wave-audit.mjs", import.meta.url));
    const call = (...args) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {
      encoding:"utf8", timeout:10_000,
    });
    const good = call("--state", path);
    expect(good.status).toBe(0);
    expect(JSON.parse(good.stdout).waves.path72).toMatchObject({ scheduled:1, due:1, overduePending:1 });
    expect(good.stderr).toBe("");
    const missing = file();
    const bad = call("--state", missing);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/wave audit:/);
    expect(existsSync(missing)).toBe(false);
    const usage = call("--bogus", path);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/usage:/);
  });
});
