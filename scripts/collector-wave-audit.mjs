#!/usr/bin/env node
// Standalone, read-only monitoring of the prospective +72h and +30d collection.
// This reports coverage and source evidence. It never computes or updates risk labels.
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = ["path72", "path30d"];
const empty = () => ({
  scheduled: 0, due: 0, completed: 0, missed: 0, pendingDue: 0, pendingFuture: 0,
  retryWaiting: 0, overduePending: 0, retriedDue: 0,
  completedOutsideWindow: 0, completedWithLatePayload: 0,
  report200: 0, report404: 0, pools200: 0, pools404: 0, hourlyValid: 0,
  hourlyEligibleTasks: 0, hourlyIneligibleTasks: 0, eligibleHourlyCandleRows: 0,
});

/**
 * Run a consistent SQLite snapshot audit against an EXISTING state file.
 * "due" means due_at <= checkedAt; pending future readings are not failures.
 * "completed" means the task status is done, not that the token survived.
 */
export function auditWaves(state, checkedAt = Date.now()) {
  if (typeof state !== "string" || !state || state === ":memory:") throw new TypeError("an existing --state FILE is required");
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) throw new RangeError("checkedAt must be a non-negative integer unix timestamp");
  const db = new DatabaseSync(state, { readOnly: true });
  try {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 1) throw new Error(`not a MemeLens collector state database (schema version ${version})`);
    // Both queries see the same state even while the live collector is writing.
    db.exec("BEGIN");
    try {
      const waves = { path72: empty(), path30d: empty() };
      const tasks = db.prepare(`SELECT kind, status, due_at AS dueAt, deadline_at AS deadlineAt,
        attempts, next_try_at AS nextTryAt, done_at AS doneAt
        FROM task WHERE kind IN ('path72', 'path30d')`).all();
      for (const t of tasks) {
        const w = waves[t.kind];
        if (!w) throw new Error(`unrecognized wave ${t.kind}`);
        w.scheduled++;
        if (t.dueAt > checkedAt) {
          w.pendingFuture++;
          continue;
        }
        w.due++;
        if (t.attempts > 0) w.retriedDue++;
        if (t.status === "done") {
          w.completed++;
          if (t.doneAt === null || t.doneAt < t.dueAt || t.doneAt > t.deadlineAt) w.completedOutsideWindow++;
        } else if (t.status === "missed") {
          w.missed++;
        } else if (t.status === "pending") {
          w.pendingDue++;
          if (t.deadlineAt < checkedAt) w.overduePending++;
          else if (t.nextTryAt > checkedAt) w.retryWaiting++;
        } else {
          throw new Error(`unrecognized task status ${t.status}`);
        }
      }
      const quality = db.prepare(`
        SELECT t.kind,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM payload p WHERE p.task_id = t.id AND p.step = 'report' AND p.valid = 1 AND p.status = 200
          ) THEN 1 ELSE 0 END) report200,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM payload p WHERE p.task_id = t.id AND p.step = 'report' AND p.valid = 1 AND p.status = 404
          ) THEN 1 ELSE 0 END) report404,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM payload p WHERE p.task_id = t.id AND p.step = 'token-pools' AND p.valid = 1 AND p.status = 200
          ) THEN 1 ELSE 0 END) pools200,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM payload p WHERE p.task_id = t.id AND p.step = 'token-pools' AND p.valid = 1 AND p.status = 404
          ) THEN 1 ELSE 0 END) pools404,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM payload p WHERE p.task_id = t.id AND p.step LIKE 'candles-hour:%' AND p.valid = 1
          ) THEN 1 ELSE 0 END) hourlyValid,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM payload p WHERE p.task_id = t.id AND p.fetched_at > t.deadline_at
          ) THEN 1 ELSE 0 END) completedWithLatePayload
        FROM task t
        WHERE t.kind IN ('path72', 'path30d') AND t.status = 'done' AND t.due_at <= ?
        GROUP BY t.kind`).all(checkedAt);
      for (const q of quality) {
        const w = waves[q.kind];
        if (!w) throw new Error(`unrecognized wave ${q.kind}`);
        for (const field of ["report200", "report404", "pools200", "pools404", "hourlyValid", "completedWithLatePayload"]) {
          w[field] = Number(q[field] ?? 0);
        }
      }

      // An HTTP 200 hourly response may contain only old, pre-scoring candles. The frozen
      // labelling protocol counts a candle only when its hour starts at/after the first-hour
      // score timestamp and its full hour ends no later than the outcome's target due time.
      // This inspects original persisted replies; no labels, prices or risk weights are computed.
      const eligibleTasks = new Set();
      const candles = db.prepare(`
        SELECT t.id, t.kind, t.due_at AS dueAt, firstReport.fetched_at AS scoredAt, p.body
        FROM task t
        JOIN payload p ON p.task_id=t.id AND p.step LIKE 'candles-hour:%' AND p.valid=1 AND p.status=200
        LEFT JOIN task s ON s.mint=t.mint AND s.kind='snapshot' AND s.status='done'
        LEFT JOIN payload firstReport ON firstReport.task_id=s.id AND firstReport.step='report' AND firstReport.valid=1
        WHERE t.kind IN ('path72', 'path30d') AND t.status='done' AND t.due_at <= ?
      `).all(checkedAt);
      for (const c of candles) {
        if (c.scoredAt === null) continue; // missing anchor cannot establish post-scoring coverage
        const payload = JSON.parse(gunzipSync(c.body).toString("utf8"));
        const rows = payload?.data?.attributes?.ohlcv_list;
        if (!Array.isArray(rows)) throw new Error(`unreadable valid hourly-candle reply in task ${c.id}`);
        for (const row of rows) {
          if (!Array.isArray(row) || row.length !== 6 || !Number.isFinite(row[0])) {
            throw new Error(`invalid saved hourly candle in task ${c.id}`);
          }
          const start = row[0] * 1000;
          if (start >= c.scoredAt && start + 3_600_000 <= c.dueAt) {
            waves[c.kind].eligibleHourlyCandleRows++;
            eligibleTasks.add(`${c.kind}:${c.id}`);
          }
        }
      }
      for (const kind of KINDS) {
        const w = waves[kind];
        w.hourlyEligibleTasks = [...eligibleTasks].filter((key) => key.startsWith(`${kind}:`)).length;
        w.hourlyIneligibleTasks = w.completed - w.hourlyEligibleTasks;
      }
      db.exec("COMMIT");
      return { checkedAt, scope: "measurement coverage and source responses only; not token risk labels", waves };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (process.argv.length !== 4 || process.argv[2] !== "--state" || !process.argv[3]) {
    console.error("usage: node scripts/collector-wave-audit.mjs --state FILE");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(auditWaves(process.argv[3]), null, 2));
    } catch (error) {
      console.error(`wave audit: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
