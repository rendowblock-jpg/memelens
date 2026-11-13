import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planTasks } from "../src/plan";
import { CollectorStore } from "../src/store";

const launch = (mint: string, over: Record<string, unknown> = {}) => ({ mint, pool: `pool-${mint}`, name: `${mint} / SOL`, createdAt: 1_000_000, seenAt: 1_030_000, followed: true, ...over });
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("launches", () => {
  it("stores a launch once: the second time says it was already there and changes nothing", () => {
    const s = new CollectorStore(":memory:");
    expect(s.hasLaunch("A")).toBe(false);
    expect(s.addLaunch(launch("A"))).toBe(true);
    expect(s.addLaunch(launch("A", { pool: "other", followed: false }))).toBe(false);
    expect(s.hasLaunch("A")).toBe(true);
    expect(s.stats().launches).toBe(1);
    expect(s.stats().followed).toBe(1);
  });

  it("counts launches that are followed separately from the ones only seen", () => {
    const s = new CollectorStore(":memory:");
    s.addLaunch(launch("A"));
    s.addLaunch(launch("B", { followed: false }));
    expect(s.stats()).toMatchObject({ launches: 2, followed: 1 });
  });
});

describe("a launch and its tasks together", () => {
  it("stores the tasks with a new launch in one step, and a launch that was already there gets none", () => {
    const s = new CollectorStore(":memory:");
    expect(s.addLaunch(launch("A"), planTasks(1_000_000))).toBe(true);
    expect(s.tasksOf("A")).toHaveLength(3);
    expect(s.addLaunch(launch("A"), planTasks(2_000_000))).toBe(false);
    expect(s.tasksOf("A").map((t) => t.dueAt)).toEqual(planTasks(1_000_000).map((p) => p.dueAt));
  });

  it("stores nothing of the launch when its tasks cannot be written", () => {
    const s = new CollectorStore(":memory:");
    const bad = [{ kind: "snapshot", dueAt: Number.NaN, deadlineAt: 1 }] as const;
    expect(() => s.addLaunch(launch("A"), bad as never)).toThrow();
    expect(s.hasLaunch("A")).toBe(false);
  });
});

describe("tasks", () => {
  const setup = () => {
    const s = new CollectorStore(":memory:");
    s.addLaunch(launch("A"));
    s.addTasks("A", planTasks(1_000_000));
    return s;
  };

  it("creates the planned tasks once; adding them again changes nothing", () => {
    const s = setup();
    s.addTasks("A", planTasks(1_000_000));
    expect(s.tasksOf("A").map((t) => t.kind)).toEqual(["snapshot", "path72", "path30d"]);
    expect(s.tasksOf("A").every((t) => t.status === "pending" && t.attempts === 0)).toBe(true);
  });

  it("offers only pending tasks that are due, oldest due first, up to the limit, with the mint and the pool", () => {
    const s = setup();
    s.addLaunch(launch("B", { createdAt: 500_000 }));
    s.addTasks("B", planTasks(500_000));
    const snapA = 1_000_000 + 3_600_000;
    const snapB = 500_000 + 3_600_000;
    expect(s.dueTasks(snapB - 1, 10)).toEqual([]);
    expect(s.dueTasks(snapB, 10).map((t) => [t.mint, t.kind])).toEqual([["B", "snapshot"]]);
    const both = s.dueTasks(snapA, 10);
    expect(both.map((t) => t.mint)).toEqual(["B", "A"]);
    expect(both[0]).toMatchObject({ pool: "pool-B", dueAt: snapB, deadlineAt: 500_000 + 75 * 60_000, attempts: 0 });
    expect(s.dueTasks(snapA, 1)).toHaveLength(1);
  });

  it("does not offer a task again once it is finished", () => {
    const s = setup();
    const t = s.dueTasks(1_000_000 + 3_600_000, 5)[0]!;
    s.finishTask(t.id, 1_000_000 + 3_700_000);
    expect(s.dueTasks(1_000_000 + 3_600_000, 5)).toEqual([]);
    expect(s.tasksOf("A")[0]).toMatchObject({ status: "done", doneAt: 1_000_000 + 3_700_000 });
  });

  it("holds a failed task back until its retry time and counts the attempt", () => {
    const s = setup();
    const due = 1_000_000 + 3_600_000;
    const t = s.dueTasks(due, 5)[0]!;
    s.failAttempt(t.id, { now: due, retryAt: due + 60_000, error: "report: HTTP 503" });
    expect(s.dueTasks(due + 59_999, 5)).toEqual([]);
    const again = s.dueTasks(due + 60_000, 5)[0]!;
    expect(again.attempts).toBe(1);
    expect(s.tasksOf("A")[0]).toMatchObject({ lastError: "report: HTTP 503", nextTryAt: due + 60_000 });
  });

  it("marks pending tasks past their deadline as missed, keeps the last error, and leaves done tasks alone", () => {
    const s = setup();
    const due = 1_000_000 + 3_600_000;
    const t = s.dueTasks(due, 5)[0]!;
    s.failAttempt(t.id, { now: due, retryAt: due + 1, error: "boom" });
    expect(s.sweepMissed(1_000_000 + 75 * 60_000)).toBe(0); // the deadline itself is still allowed
    expect(s.sweepMissed(1_000_000 + 75 * 60_000 + 1)).toBe(1);
    expect(s.tasksOf("A")[0]).toMatchObject({ status: "missed", lastError: "boom" });
    expect(s.tasksOf("A")[1]?.status).toBe("pending");
    const done = s.dueTasks(1_000_000 + 72 * 3_600_000, 5)[0]!;
    s.finishTask(done.id, 1);
    expect(s.sweepMissed(1_000_000 + 79 * 3_600_000)).toBe(0);
    expect(s.tasksOf("A")[1]?.status).toBe("done");
  });
});

describe("payloads", () => {
  it("keeps what was fetched, exactly, including non-ASCII text, and compresses it", () => {
    const s = new CollectorStore(":memory:");
    s.addLaunch(launch("A"));
    s.addTasks("A", planTasks(1_000_000));
    const id = s.tasksOf("A")[0]!.id;
    const body = JSON.stringify({ name: "Ünïcode 猫 🐱", rows: Array.from({ length: 500 }, (_, i) => i) });
    s.savePayload(id, { step: "report", url: "https://x/report", fetchedAt: 42, status: 200, valid: true, body });
    expect(s.payloads(id)).toEqual([{ step: "report", url: "https://x/report", fetchedAt: 42, status: 200, valid: true, body }]);
    expect(s.stats().payloadBytes).toBeLessThan(body.length);
  });

  it("replaces a step that is saved again, and lists only the valid steps as saved", () => {
    const s = new CollectorStore(":memory:");
    s.addLaunch(launch("A"));
    s.addTasks("A", planTasks(1_000_000));
    const id = s.tasksOf("A")[0]!.id;
    s.savePayload(id, { step: "report", url: "u", fetchedAt: 1, status: 200, valid: false, body: "<html>" });
    expect(s.savedSteps(id).size).toBe(0);
    s.savePayload(id, { step: "report", url: "u", fetchedAt: 2, status: 200, valid: true, body: "{}" });
    s.savePayload(id, { step: "candles-minute", url: "u2", fetchedAt: 2, status: 404, valid: true, body: "{}" });
    expect([...s.savedSteps(id)].sort()).toEqual(["candles-minute", "report"]);
    expect(s.payloads(id)).toHaveLength(2);
    expect(s.payloads(id).find((p) => p.step === "report")?.fetchedAt).toBe(2);
  });
});

describe("meta and persistence", () => {
  it("keeps small named values", () => {
    const s = new CollectorStore(":memory:");
    expect(s.getMeta("k")).toBeNull();
    s.setMeta("k", "v1");
    s.setMeta("k", "v2");
    expect(s.getMeta("k")).toBe("v2");
  });

  it("resumes from a file: everything written before the process stopped is there after it starts again", () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    const a = new CollectorStore(path);
    a.addLaunch(launch("A"));
    a.addTasks("A", planTasks(1_000_000));
    a.setMeta("discovery_started_at", "123");
    a.savePayload(a.tasksOf("A")[0]!.id, { step: "report", url: "u", fetchedAt: 1, status: 200, valid: true, body: "{}" });
    a.close();
    const b = new CollectorStore(path);
    expect(b.hasLaunch("A")).toBe(true);
    expect(b.getMeta("discovery_started_at")).toBe("123");
    expect(b.tasksOf("A")).toHaveLength(3);
    expect(b.savedSteps(b.tasksOf("A")[0]!.id).has("report")).toBe(true);
    b.close();
  });

  it("refuses a state file written by a different schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    new CollectorStore(path).close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new CollectorStore(path)).toThrow(/schema/i);
  });
});

describe("stats", () => {
  it("counts tasks by kind and status", () => {
    const s = new CollectorStore(":memory:");
    s.addLaunch(launch("A"));
    s.addTasks("A", planTasks(1_000_000));
    s.finishTask(s.tasksOf("A")[0]!.id, 1);
    expect(s.stats().tasks).toEqual({ snapshot: { done: 1 }, path72: { pending: 1 }, path30d: { pending: 1 } });
  });
});

describe("doneSnapshots", () => {
  const setup = () => {
    const s = new CollectorStore(":memory:");
    for (const [i, mint] of ["A", "B", "C", "D", "E"].entries()) {
      s.addLaunch(launch(mint, { createdAt: 1_000_000 + (4 - i) * 1000 }), planTasks(1_000_000 + (4 - i) * 1000));
    }
    const snap = (mint: string) => s.tasksOf(mint).find((t) => t.kind === "snapshot")!;
    const put = (mint: string, step: string, status: number, valid: boolean, body: string, fetchedAt = 7) => s.savePayload(snap(mint).id, { step, url: "u", fetchedAt, status, valid, body });
    put("A", "report", 200, true, "BODY-A", 111);
    s.finishTask(snap("A").id, 1);
    put("B", "report", 404, true, '{"error":"no"}', 222);
    s.finishTask(snap("B").id, 1);
    put("C", "report", 200, false, "<html>");
    s.finishTask(snap("C").id, 1);
    put("D", "report", 200, true, "BODY-D"); // saved, but the task is still pending
    s.finishTask(snap("E").id, 1); // done with no report saved
    put("E", "candles-minute", 200, true, "{}"); // only another step
    // a later task of A with its own report must not be returned
    const p72 = s.tasksOf("A").find((t) => t.kind === "path72")!;
    s.savePayload(p72.id, { step: "report", url: "u", fetchedAt: 999, status: 200, valid: true, body: "BODY-A-72H" });
    s.finishTask(p72.id, 1);
    return s;
  };

  it("returns the first-hour report of every finished snapshot task that has a valid one, oldest pool first, bodies decoded", () => {
    const rows = setup().doneSnapshots();
    expect(rows.map((r) => r.mint)).toEqual(["B", "A"]); // B was created before A in this setup
    expect(rows.find((r) => r.mint === "A")).toEqual({ mint: "A", createdAt: 1_004_000, asOf: 111, status: 200, body: "BODY-A" });
    expect(rows.find((r) => r.mint === "B")).toMatchObject({ status: 404, asOf: 222, body: '{"error":"no"}' });
  });

  it("opens a state file read-only: it can read everything and write nothing, so exporting cannot disturb the collector", () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-ro-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    const w = new CollectorStore(path);
    w.addLaunch(launch("A"), planTasks(1_000_000));
    w.close();
    const r = CollectorStore.openReadOnly(path);
    expect(r.stats().launches).toBe(1);
    expect(r.hasLaunch("A")).toBe(true);
    expect(() => r.addLaunch(launch("B"))).toThrow();
    expect(() => r.setMeta("k", "v")).toThrow();
    r.close();
  });

  it("refuses to open a read-only file of another schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-ro-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    new CollectorStore(path).close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => CollectorStore.openReadOnly(path)).toThrow(/schema/i);
  });

  it("refuses to open a read-only file that is empty (a path typed wrong must not look like an empty collection)", () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-ro-"));
    dirs.push(dir);
    const path = join(dir, "empty.sqlite");
    new DatabaseSync(path).close();
    expect(() => CollectorStore.openReadOnly(path)).toThrow(/schema|not a collector/i);
  });
});
