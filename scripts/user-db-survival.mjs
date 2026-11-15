// Windows MSI acceptance check, read-only: the sample loaded into Electron's default userData database must
// survive uninstall byte-for-byte. No test hook, private IPC, or installer-owned DB path is introduced.
// Run before uninstall: node scripts/user-db-survival.mjs record --manifest "$env:RUNNER_TEMP\\user-db.json"
// Run after uninstall: node scripts/user-db-survival.mjs verify --manifest "$env:RUNNER_TEMP\\user-db.json"
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE = JSON.parse(readFileSync(new URL("../packages/data/fixtures/sample.json", import.meta.url), "utf8"));
const VERSION = 1;
const suffixes = ["", "-wal"]; // -shm is ephemeral; an SQLite reader may recreate it.

export function defaultUserDatabase(appData) {
  if (typeof appData !== "string" || !appData.trim()) throw new Error("APPDATA is required");
  // The packaged package.json has productName "MemeLens". Electron uses that for app.getPath("userData").
  return resolve(appData, "MemeLens", "memelens.sqlite");
}

function hashFile(path) {
  if (!existsSync(path)) throw new Error(`database file missing: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readSample(dbFile) {
  if (!existsSync(dbFile)) throw new Error(`user database missing: ${dbFile}`);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") throw new Error(`database integrity check failed: ${JSON.stringify(integrity)}`);
    const chains = ["token", "trade", "holder_snapshot"].map((table) =>
      db.prepare(`SELECT DISTINCT chain FROM ${table}`).all().map((r) => r.chain),
    );
    if (chains.some((values) => values.length !== 1 || values[0] !== SAMPLE.chain)) {
      throw new Error("the first-run database must contain only the synthetic sample chain");
    }
    const ids = (table, columns) =>
      db.prepare(`SELECT ${columns} FROM ${table} WHERE chain=? ORDER BY ${columns}`).all(SAMPLE.chain)
        .map((row) => columns.split(",").map((key) => String(row[key])).join("|"));
    const actual = {
      tokens: ids("token", "address"),
      trades: ids("trade", "id"),
      snapshots: ids("holder_snapshot", "token,time"),
    };
    const expected = {
      tokens: SAMPLE.tokens.map((t) => t.token).sort(),
      trades: SAMPLE.trades.map((t) => t.id).sort(),
      snapshots: SAMPLE.snapshots.map((s) => `${s.token}|${s.time}`).sort(),
    };
    for (const part of Object.keys(expected)) {
      if (JSON.stringify(actual[part]) !== JSON.stringify(expected[part])) {
        throw new Error(`the user database does not contain the expected first-run sample ${part}`);
      }
    }
    return { chain: SAMPLE.chain, tokens: actual.tokens.length, trades: actual.trades.length, snapshots: actual.snapshots.length };
  } finally {
    db.close();
  }
}

function fileHashes(dbFile) {
  const files = {};
  for (const suffix of suffixes) {
    if (existsSync(dbFile + suffix)) files[suffix] = hashFile(dbFile + suffix);
  }
  if (!files[""]) throw new Error(`user database missing: ${dbFile}`);
  return files;
}

export function recordUserDatabase(appData, manifestPath) {
  if (existsSync(manifestPath)) throw new Error(`refusing to replace the baseline: ${manifestPath}`);
  const database = defaultUserDatabase(appData);
  const sample = readSample(database);
  const files = fileHashes(database);
  const record = { version: VERSION, appData: resolve(appData), database, sample, files };
  writeFileSync(manifestPath, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  return record;
}

export function verifyUserDatabase(appData, manifestPath) {
  const baseline = JSON.parse(readFileSync(manifestPath, "utf8"));
  const database = defaultUserDatabase(appData);
  if (baseline.version !== VERSION || baseline.appData !== resolve(appData) || baseline.database !== database) {
    throw new Error("the stored baseline belongs to a different user profile or has an invalid version/path");
  }
  // Verify both the original file and a potential live WAL: SQLite may need the WAL to see the latest transactions.
  const now = fileHashes(database);
  if (JSON.stringify(now) !== JSON.stringify(baseline.files)) {
    throw new Error(`the database or WAL bytes changed or went missing across uninstall: ${JSON.stringify(now)}`);
  }
  const sample = readSample(database);
  if (JSON.stringify(sample) !== JSON.stringify(baseline.sample)) {
    throw new Error("the user database content changed across uninstall");
  }
  return { ...baseline, sample };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "win32") throw new Error("the MSI acceptance check only runs on Windows");
    const command = process.argv[2];
    const key = process.argv.indexOf("--manifest");
    if (!["record", "verify"].includes(command) || key < 0 || !process.argv[key + 1]) {
      throw new Error("usage: user-db-survival.mjs record|verify --manifest PATH");
    }
    const result = command === "record"
      ? recordUserDatabase(process.env.APPDATA, process.argv[key + 1])
      : verifyUserDatabase(process.env.APPDATA, process.argv[key + 1]);
    console.log(`user database ${command === "record" ? "baseline saved" : "survived uninstall"}: ${result.database}; ${result.sample.tokens} tokens, ${result.sample.trades} trades, ${result.sample.snapshots} snapshots; sha256 ${result.files[""]}`);
  } catch (error) {
    console.error(`USER DATABASE ${process.argv[2] ?? "check"} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
