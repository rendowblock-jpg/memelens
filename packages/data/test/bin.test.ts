import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// These run the real entry point in a child process, to check what run() cannot: that bin.ts is wired up,
// that the exit code reaches the shell, and that the experimental-SQLite warning does not leak into output.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../fixtures/sample.json", import.meta.url));

const TSX = import.meta.resolve("tsx"); // absolute, so the child can run from any directory

function memelens(...argv: string[]): { code: number | null; out: string; err: string } {
  return memelensIn(ROOT, ...argv);
}

function memelensIn(cwd: string, ...argv: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", "--import", TSX, BIN, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memelens-bin-"));
  db = join(dir, "t.sqlite");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("memelens (real process)", () => {
  it("ingests the sample, then answers a question about it, with clean output and exit 0", () => {
    const a = memelens("ingest", SAMPLE, "--db", db);
    expect(a.code).toBe(0);
    expect(a.err).toBe("");
    const b = memelens("pnl", "alice", "--db", db, "--json");
    expect(b.code).toBe(0);
    expect(b.err).toBe("");
    expect(JSON.parse(b.out).report.totals.realised).toBe("5000000");
  });

  it("uses ./memelens.sqlite when --db is not given, the same file for every command", () => {
    expect(memelensIn(dir, "ingest", SAMPLE).code).toBe(0);
    expect(existsSync(join(dir, "memelens.sqlite"))).toBe(true);
    const status = memelensIn(dir, "status", "--json");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out).db).toBe("memelens.sqlite");
    expect(JSON.parse(status.out).chains[0].counts.trades).toBe(25);
    for (const argv of [["pnl", "alice"], ["risk", "TOK5"], ["concentration", "TOK5"], ["smart"]]) {
      const r = memelensIn(dir, ...argv, "--json");
      expect(r.code, argv.join(" ")).toBe(0);
    }
  });

  it("exits 2 with usage on stderr when given nothing", () => {
    const r = memelens();
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^usage:/);
  });

  it("exits 1 for a missing database and creates nothing", () => {
    const r = memelens("status", "--db", db);
    expect(r.code).toBe(1);
    expect(r.err).toContain("database not found");
    expect(existsSync(db)).toBe(false);
  });

  it("exits 0 and prints help on stdout", () => {
    const r = memelens("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage:");
    expect(r.err).toBe("");
  });
});
