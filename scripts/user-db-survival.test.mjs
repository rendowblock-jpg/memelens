import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordUserDatabase, verifyUserDatabase, defaultUserDatabase } from "./user-db-survival.mjs";

const fixture = JSON.parse(readFileSync(new URL("../packages/data/fixtures/sample.json", import.meta.url), "utf8"));
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "memelens-db-survival-"));
  dirs.push(root);
  const appData = join(root, "roaming");
  const dbFile = defaultUserDatabase(appData);
  const manifestPath = join(root, "snapshot.json");
  mkdirSync(join(appData, "MemeLens"), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE token (chain TEXT NOT NULL, address TEXT NOT NULL, symbol TEXT);
    CREATE TABLE trade (chain TEXT NOT NULL, id TEXT NOT NULL);
    CREATE TABLE holder_snapshot (chain TEXT NOT NULL, token TEXT NOT NULL, time INTEGER NOT NULL);
  `);
  for (const t of fixture.tokens) db.prepare("INSERT INTO token VALUES (?,?,?)").run(fixture.chain, t.token, t.symbol);
  for (const t of fixture.trades) db.prepare("INSERT INTO trade VALUES (?,?)").run(fixture.chain, t.id);
  for (const s of fixture.snapshots) db.prepare("INSERT INTO holder_snapshot VALUES (?,?,?)").run(fixture.chain, s.token, s.time);
  db.close();
  return { appData, dbFile, manifestPath };
}

describe("Windows user database survives MSI uninstall", () => {
  it("uses the product's roaming AppData path, never the installation directory", () => {
    expect(defaultUserDatabase("C:\\Users\\test\\AppData\\Roaming")).toMatch(/MemeLens[\\/]memelens[.]sqlite$/);
  });

  it("records and independently reopens a populated first-run database", () => {
    const { appData, manifestPath, dbFile } = setup();
    const manifest = recordUserDatabase(appData, manifestPath);
    expect(manifest.database).toBe(dbFile);
    expect(manifest.sample).toEqual({
      chain: fixture.chain, tokens: fixture.tokens.length, trades: fixture.trades.length, snapshots: fixture.snapshots.length,
    });
    expect(manifest.files[""]).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyUserDatabase(appData, manifestPath).sample).toEqual(manifest.sample);
  });

  it("rejects a missing first-run database without writing a manifest", () => {
    const { appData, dbFile, manifestPath } = setup();
    rmSync(dbFile);
    expect(() => recordUserDatabase(appData, manifestPath)).toThrow(/database|missing/i);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("refuses to replace an earlier baseline", () => {
    const { appData, manifestPath } = setup();
    recordUserDatabase(appData, manifestPath);
    expect(() => recordUserDatabase(appData, manifestPath)).toThrow();
  });

  it("rejects an empty or wrong sample rather than accepting any database file", () => {
    const { appData, dbFile, manifestPath } = setup();
    const db = new DatabaseSync(dbFile);
    db.exec("DELETE FROM token WHERE address = 'TOK1'");
    db.close();
    expect(() => recordUserDatabase(appData, manifestPath)).toThrow(/sample|token/i);
  });

  it("detects a lost database after uninstall", () => {
    const { appData, dbFile, manifestPath } = setup();
    recordUserDatabase(appData, manifestPath);
    rmSync(dbFile);
    expect(() => verifyUserDatabase(appData, manifestPath)).toThrow(/database|missing/i);
  });

  it("detects a byte change even when sample counts stay the same", () => {
    const { appData, dbFile, manifestPath } = setup();
    recordUserDatabase(appData, manifestPath);
    const db = new DatabaseSync(dbFile);
    db.exec("UPDATE token SET symbol = 'TAMPER' WHERE address = 'TOK1'");
    db.close();
    expect(() => verifyUserDatabase(appData, manifestPath)).toThrow(/changed|hash|sha/i);
  });

  it("detects disappearance of a WAL file that held uncheckpointed data", () => {
    const { appData, dbFile, manifestPath } = setup();
    // Keep a writer open so the WAL is a real SQLite journal, not a fake side file.
    const writer = new DatabaseSync(dbFile);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("UPDATE token SET symbol = 'SYN1' WHERE address = 'TOK1'");
    const data = recordUserDatabase(appData, manifestPath);
    expect(data.files["-wal"]).toBeDefined();
    writer.close(); // SQLite can remove a WAL when the last connection closes; the result is detectable.
    expect(() => verifyUserDatabase(appData, manifestPath)).toThrow(/WAL|changed|missing/i);
  });

  it("refuses to verify the baseline against a different user profile", () => {
    const { appData, manifestPath } = setup();
    recordUserDatabase(appData, manifestPath);
    expect(() => verifyUserDatabase(appData + "-another", manifestPath)).toThrow(/profile|path|directory/i);
  });
});
