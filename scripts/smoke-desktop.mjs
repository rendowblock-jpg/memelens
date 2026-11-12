// Cross-platform version of smoke-desktop.sh: builds the app, loads the sample fixture into a fresh database and
// starts the real Electron app against it. On Windows the sandbox is ON (no --no-sandbox) and the run checks that.
// On Linux it uses xvfb-run and --no-sandbox, which this host needs. Exit code 0 = every check passed.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps", "desktop");
const work = process.env.SMOKE_DIR ?? join(homedir(), ".cache", "memelens-smoke");
mkdirSync(work, { recursive: true });
const db = join(work, "smoke.sqlite");
for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(db + suffix, { force: true });
// An empty engine folder of our own, so the run does not depend on (or touch) an engine installed on this machine.
const sidecarDir = join(work, "sidecar");
rmSync(sidecarDir, { recursive: true, force: true });
mkdirSync(sidecarDir, { recursive: true });

execFileSync(process.execPath, [join(app, "build.mjs")], { cwd: app, stdio: "ignore" });
execFileSync(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "--import", "tsx", "packages/data/src/bin.ts", "ingest", "packages/data/fixtures/sample.json", "--db", db],
  { cwd: root, stdio: "ignore" },
);
// The expected row count comes from the fixture itself, not from the app under test.
const rows = JSON.parse(readFileSync(join(root, "packages", "data", "fixtures", "sample.json"), "utf8")).tokens.length;

const exe = process.env.SMOKE_ELECTRON ?? join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const entry = join(app, "dist", "smoke.cjs");
const linux = process.platform === "linux";
const [cmd, argv] = linux ? ["xvfb-run", ["-a", exe, "--no-sandbox", entry]] : [exe, [entry]];
const result = spawnSync(cmd, argv, {
  encoding: "utf8",
  timeout: 90_000,
  env: { ...process.env, MEMELENS_DB: db, MEMELENS_SIDECAR_DIR: sidecarDir, MEMELENS_EXPECT_ROWS: String(rows), MEMELENS_EXPECT_SANDBOX: linux ? "0" : "1" },
});
const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const lines = out.split(/\r?\n/).filter((l) => /^(PASS|FAIL|SMOKE)/.test(l));
console.log(lines.join("\n"));
let code = result.status ?? 5;
// Success needs the zero exit code and the app's own "SMOKE OK" line: a crash that prints nothing must not pass.
if (code === 0 && !lines.some((l) => l.startsWith("SMOKE OK"))) {
  console.error("smoke: exit code 0 but no 'SMOKE OK' line; treating as failure");
  code = 4;
}
if (code !== 0 && lines.length === 0) console.error(out.slice(-2000));
process.exit(code);
