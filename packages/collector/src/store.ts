import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { StoredReport } from "./export";
import type { StoredToken } from "./load";
import type { Launch } from "./parse";
import type { TaskKind, TaskPlan } from "./plan";

export const SCHEMA_VERSION = 1;
export class SchemaError extends Error {}

export type TaskStatus = "pending" | "done" | "missed";

export interface DueTask {
  id: number;
  mint: string;
  pool: string;
  kind: TaskKind;
  dueAt: number;
  deadlineAt: number;
  attempts: number;
}

export interface TaskRow {
  id: number;
  kind: TaskKind;
  status: TaskStatus;
  dueAt: number;
  deadlineAt: number;
  attempts: number;
  nextTryAt: number;
  lastError: string | null;
  doneAt: number | null;
}

export interface Payload {
  /** Which reading of the task this is: "report", "candles-minute", "token-pools", "candles-hour:<pool>". */
  step: string;
  url: string;
  fetchedAt: number;
  /** The HTTP status that came back. */
  status: number;
  /** The body had the shape the source documents (or the source said there is nothing: 404). Only valid steps count as saved. */
  valid: boolean;
  /** The reply exactly as received. */
  body: string;
}

export interface Stats {
  launches: number;
  followed: number;
  tasks: Record<string, Record<string, number>>;
  payloads: number;
  /** Stored (compressed) size of every payload. */
  payloadBytes: number;
}

/** A read-only deadline census. Only pending tasks count; this is not a prediction of outcomes. */
export interface QueueBucket {
  pending: number;
  runnable: number;
  retryWaiting: number;
  overdue: number;
  expiringSoon: number;
  nextDueAt: number | null;
  nextDeadlineAt: number | null;
}

export interface QueueHealth {
  checkedAt: number;
  /** The lookahead for expiringSoon (15 minutes). */
  windowMs: number;
  kinds: Record<TaskKind, QueueBucket>;
}

const QUEUE_WINDOW_MS = 15 * 60_000;

const SCHEMA = `
CREATE TABLE launch (
  mint TEXT PRIMARY KEY,
  pool TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  followed INTEGER NOT NULL CHECK (followed IN (0, 1))
) WITHOUT ROWID;
CREATE TABLE task (
  id INTEGER PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES launch (mint),
  kind TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'missed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done_at INTEGER,
  UNIQUE (mint, kind)
);
CREATE INDEX task_due ON task (status, due_at);
CREATE TABLE payload (
  task_id INTEGER NOT NULL REFERENCES task (id),
  step TEXT NOT NULL,
  url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  status INTEGER NOT NULL,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  body BLOB NOT NULL,
  PRIMARY KEY (task_id, step)
) WITHOUT ROWID;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`;

/** Everything the collector knows, in one SQLite file that survives a restart. Times are unix ms. */
export class CollectorStore {
  private readonly db: DatabaseSync;

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, options.readOnly === true ? { readOnly: true } : {});
    const version = (): number => Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (options.readOnly === true) {
      // Do not initialize the schema or change database rows. SQLite may create WAL support files while reading.
      // An empty file is not a collection: a mistyped path must fail rather than look like an empty run.
      if (version() !== SCHEMA_VERSION) {
        const found = version();
        this.db.close();
        throw new SchemaError(`${path} is not a collector state file of schema version ${SCHEMA_VERSION} (found version ${found})`);
      }
      return;
    }
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    const found = version();
    if (found === 0) {
      this.db.exec(SCHEMA);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (found !== SCHEMA_VERSION) {
      this.db.close();
      throw new SchemaError(`the state file has schema version ${found}, this collector reads version ${SCHEMA_VERSION}`);
    }
  }

  /** Opens an existing state file for reading only, so an export can run while the collector is writing to it. */
  static openReadOnly(path: string): CollectorStore {
    return new CollectorStore(path, { readOnly: true });
  }

  close(): void {
    this.db.close();
  }

  hasLaunch(mint: string): boolean {
    return this.db.prepare("SELECT 1 FROM launch WHERE mint = ?").get(mint) !== undefined;
  }

  /**
   * Stores a launch and, in the same step, the tasks planned for it. False when the launch was already stored: then
   * nothing at all is changed, the tasks included. Written together so a crash cannot leave a followed token without
   * its tasks, which nothing would ever notice.
   */
  addLaunch(l: Launch & { seenAt: number; followed: boolean }, plans: readonly TaskPlan[] = []): boolean {
    return this.transaction(() => {
      const r = this.db.prepare("INSERT INTO launch (mint, pool, name, created_at, seen_at, followed) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (mint) DO NOTHING").run(l.mint, l.pool, l.name, l.createdAt, l.seenAt, l.followed ? 1 : 0);
      if (Number(r.changes) !== 1) return false;
      const insert = this.db.prepare("INSERT INTO task (mint, kind, due_at, deadline_at) VALUES (?, ?, ?, ?)");
      for (const p of plans) insert.run(l.mint, p.kind, p.dueAt, p.deadlineAt);
      return true;
    });
  }

  addTasks(mint: string, plans: readonly TaskPlan[]): void {
    // Only a repeat of (mint, kind) is ignored: OR IGNORE would also swallow a missing value, and a bad plan must fail loudly.
    const insert = this.db.prepare("INSERT INTO task (mint, kind, due_at, deadline_at) VALUES (?, ?, ?, ?) ON CONFLICT (mint, kind) DO NOTHING");
    this.transaction(() => {
      for (const p of plans) insert.run(mint, p.kind, p.dueAt, p.deadlineAt);
    });
  }

  /** Pending tasks that may run now, the one that became due first first. */
  dueTasks(now: number, limit: number): DueTask[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.mint, l.pool, t.kind, t.due_at AS dueAt, t.deadline_at AS deadlineAt, t.attempts
         FROM task t JOIN launch l ON l.mint = t.mint
         WHERE t.status = 'pending' AND t.due_at <= ? AND t.next_try_at <= ?
         ORDER BY t.due_at, t.id LIMIT ?`,
      )
      .all(now, now, limit) as unknown as DueTask[];
    return rows.map((r) => ({ ...r }));
  }

  /** Gives up the pending tasks whose deadline has passed. Returns how many. */
  sweepMissed(now: number): number {
    return Number(this.db.prepare("UPDATE task SET status = 'missed' WHERE status = 'pending' AND deadline_at < ?").run(now).changes);
  }

  finishTask(id: number, now: number): void {
    this.db.prepare("UPDATE task SET status = 'done', done_at = ? WHERE id = ?").run(now, id);
  }

  failAttempt(id: number, f: { now: number; retryAt: number; error: string }): void {
    this.db.prepare("UPDATE task SET attempts = attempts + 1, next_try_at = ?, last_error = ? WHERE id = ?").run(f.retryAt, f.error, id);
  }

  tasksOf(mint: string): TaskRow[] {
    return this.db
      .prepare(
        `SELECT id, kind, status, due_at AS dueAt, deadline_at AS deadlineAt, attempts, next_try_at AS nextTryAt, last_error AS lastError, done_at AS doneAt
         FROM task WHERE mint = ? ORDER BY due_at, id`,
      )
      .all(mint) as unknown as TaskRow[];
  }

  savePayload(taskId: number, p: Payload): void {
    this.db
      .prepare("INSERT OR REPLACE INTO payload (task_id, step, url, fetched_at, status, valid, body) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(taskId, p.step, p.url, p.fetchedAt, p.status, p.valid ? 1 : 0, gzipSync(Buffer.from(p.body, "utf8")));
  }

  payloads(taskId: number): Payload[] {
    const rows = this.db.prepare("SELECT step, url, fetched_at AS fetchedAt, status, valid, body FROM payload WHERE task_id = ? ORDER BY step").all(taskId) as unknown as Array<Omit<Payload, "valid" | "body"> & { valid: number; body: Uint8Array }>;
    return rows.map((r) => ({ step: r.step, url: r.url, fetchedAt: Number(r.fetchedAt), status: Number(r.status), valid: r.valid === 1, body: gunzipSync(r.body).toString("utf8") }));
  }

  /** The steps of a task that already have a valid reply, so a retry reads only what is missing. */
  savedSteps(taskId: number): Set<string> {
    const rows = this.db.prepare("SELECT step FROM payload WHERE task_id = ? AND valid = 1").all(taskId) as unknown as Array<{ step: string }>;
    return new Set(rows.map((r) => r.step));
  }

  /**
   * The first-hour report of every finished snapshot task that has a valid one (a 404 counts: it says the source has nothing),
   * oldest pool first. A later task's report is never returned: the scoring time is the first hour.
   */
  doneSnapshots(): StoredReport[] {
    const rows = this.db
      .prepare(
        `SELECT l.mint AS mint, l.created_at AS createdAt, p.fetched_at AS asOf, p.status AS status, p.body AS body
         FROM task t JOIN launch l ON l.mint = t.mint JOIN payload p ON p.task_id = t.id AND p.step = 'report'
         WHERE t.kind = 'snapshot' AND t.status = 'done' AND p.valid = 1
         ORDER BY l.created_at, l.mint`,
      )
      .all() as unknown as Array<{ mint: string; createdAt: number; asOf: number; status: number; body: Uint8Array }>;
    return rows.map((r) => ({ mint: r.mint, createdAt: Number(r.createdAt), asOf: Number(r.asOf), status: Number(r.status), body: gunzipSync(r.body).toString("utf8") }));
  }

  /**
   * Every followed launch, oldest pool first, with its three readings and the replies stored in them, one launch at a time
   * (so a state file with thousands of tokens is never held in memory whole). A reading that was never planned is null.
   */
  *storedTokens(): Generator<StoredToken> {
    const launches = this.db.prepare("SELECT mint, created_at AS createdAt FROM launch WHERE followed = 1 ORDER BY created_at, mint").all() as unknown as Array<{ mint: string; createdAt: number }>;
    for (const l of launches) {
      const tasks = this.tasksOf(l.mint);
      const reading = (kind: TaskKind): StoredToken["snapshot"] => {
        const t = tasks.find((x) => x.kind === kind);
        return t === undefined ? null : { status: t.status, payloads: this.payloads(t.id) };
      };
      yield { mint: l.mint, createdAt: Number(l.createdAt), snapshot: reading("snapshot"), path72: reading("path72"), path30d: reading("path30d") };
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row === undefined ? null : row.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  stats(): Stats {
    const one = (sql: string): number => Number((this.db.prepare(sql).get() as { n: number }).n);
    const tasks: Record<string, Record<string, number>> = {};
    for (const r of this.db.prepare("SELECT kind, status, COUNT(*) AS n FROM task GROUP BY kind, status ORDER BY kind").all() as unknown as Array<{ kind: string; status: string; n: number }>) {
      (tasks[r.kind] ??= {})[r.status] = Number(r.n);
    }
    return {
      launches: one("SELECT COUNT(*) AS n FROM launch"),
      followed: one("SELECT COUNT(*) AS n FROM launch WHERE followed = 1"),
      tasks,
      payloads: one("SELECT COUNT(*) AS n FROM payload"),
      payloadBytes: one("SELECT COALESCE(SUM(LENGTH(body)), 0) AS n FROM payload"),
    };
  }

  /** Report deadlines without sweeping missed tasks, updating retries, or changing any label/calibration rule. */
  queueHealth(now: number): QueueHealth {
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - QUEUE_WINDOW_MS) {
      throw new RangeError("queue clock must be a non-negative safe unix timestamp in milliseconds");
    }
    const empty = (): QueueBucket => ({
      pending: 0, runnable: 0, retryWaiting: 0, overdue: 0, expiringSoon: 0,
      nextDueAt: null, nextDeadlineAt: null,
    });
    const kinds: QueueHealth["kinds"] = { snapshot: empty(), path72: empty(), path30d: empty() };
    const rows = this.db.prepare(`
      SELECT kind, COUNT(*) AS pending,
        SUM(CASE WHEN due_at <= ? AND next_try_at <= ? AND deadline_at >= ? THEN 1 ELSE 0 END) AS runnable,
        SUM(CASE WHEN due_at <= ? AND next_try_at > ? AND deadline_at >= ? THEN 1 ELSE 0 END) AS retryWaiting,
        SUM(CASE WHEN deadline_at < ? THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN deadline_at >= ? AND deadline_at <= ? THEN 1 ELSE 0 END) AS expiringSoon,
        MIN(CASE WHEN due_at > ? THEN due_at END) AS nextDueAt,
        MIN(CASE WHEN deadline_at >= ? THEN deadline_at END) AS nextDeadlineAt
      FROM task WHERE status = 'pending' GROUP BY kind
    `).all(now, now, now, now, now, now, now, now, now + QUEUE_WINDOW_MS, now, now) as unknown as
      Array<{ kind: string; pending: number; runnable: number; retryWaiting: number; overdue: number;
        expiringSoon: number; nextDueAt: number | null; nextDeadlineAt: number | null }>;
    for (const row of rows) {
      if (row.kind !== "snapshot" && row.kind !== "path72" && row.kind !== "path30d") {
        throw new SchemaError(`unknown task kind in collection: ${row.kind}`);
      }
      kinds[row.kind] = {
        pending: Number(row.pending), runnable: Number(row.runnable), retryWaiting: Number(row.retryWaiting),
        overdue: Number(row.overdue), expiringSoon: Number(row.expiringSoon),
        nextDueAt: row.nextDueAt === null ? null : Number(row.nextDueAt),
        nextDeadlineAt: row.nextDeadlineAt === null ? null : Number(row.nextDeadlineAt),
      };
    }
    return { checkedAt: now, windowMs: QUEUE_WINDOW_MS, kinds };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
