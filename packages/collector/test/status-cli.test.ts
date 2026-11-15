import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { planTasks } from "../src/plan";
import { CollectorStore } from "../src/store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "memelens-status-readonly-"));
  dirs.push(dir);
  return dir;
}

function status(file: string) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "status", "--state", file], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
}

function hash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("status CLI: report existing collection without touching it", () => {
  it("refuses a mistyped state path without creating a phantom database", () => {
    const dir = directory();
    const path = join(dir, "not-the-real-state.sqlite");
    const run = status(path);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/unable to open|database|state/i);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("reads the real collection without changing its database bytes", () => {
    const dir = directory();
    const file = join(dir, "state.sqlite");
    const writer = new CollectorStore(file);
    writer.addLaunch({ mint: "A", pool: "pool-A", name: "A", createdAt: 1_000_000, seenAt: 1_030_000, followed: true }, planTasks(1_000_000));
    writer.setMeta("discovery_started_at", "1000000");
    writer.close();
    const before = hash(file);
    const run = status(file);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("launches seen 1, followed 1");
    expect(run.stdout).toContain("snapshot: pending 1");
    expect(run.stdout).toContain("discovery started: 1970-01-01T00:16:40.000Z");
    // SQLite may create temporary -wal/-shm support files even for a read-only WAL reader.
    // They are not a new collection and must not be mistaken for writes to the data.
    expect(hash(file)).toBe(before);
  });

  it("does not switch a previously configured rollback-journal database into WAL mode", () => {
    const dir = directory();
    const file = join(dir, "rollback.sqlite");
    const writer = new CollectorStore(file);
    writer.close();
    const config = new DatabaseSync(file);
    const journal = config.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("delete");
    config.close();
    const before = hash(file);
    const run = status(file);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("launches seen 0, followed 0");
    expect(hash(file)).toBe(before);
    const verify = new DatabaseSync(file, { readOnly: true });
    expect((verify.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    verify.close();
  });

  it("refuses another schema, leaving its database bytes unchanged", () => {
    const dir = directory();
    const file = join(dir, "wrong.sqlite");
    const writer = new CollectorStore(file);
    writer.close();
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 99");
    db.close();
    const before = hash(file);
    const run = status(file);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/schema version/);
    expect(hash(file)).toBe(before);
  });
});
