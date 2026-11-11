#!/usr/bin/env bash
# Builds the desktop app, loads the sample fixture into a fresh database and starts the real app (Electron under a
# virtual display) to check it from the inside. Exit code 0 = every check passed.
# usage: scripts/smoke-desktop.sh [APP_DIR]     (APP_DIR defaults to apps/desktop; the mutation runner passes a copy)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:-$root/apps/desktop}"
work="${SMOKE_DIR:-$HOME/.cache/memelens-smoke}"
mkdir -p "$work"
db="$work/smoke.sqlite"
rm -f "$db" "$db-wal" "$db-shm"

(cd "$app" && node build.mjs >/dev/null)
(cd "$root" && npm run -s memelens -- ingest packages/data/fixtures/sample.json --db "$db" >/dev/null)
# The expected row count is read from the fixture itself, not from the app under test.
rows="$(node -e 'console.log(require(process.argv[1]).tokens.length)' "$root/packages/data/fixtures/sample.json")"

# --no-sandbox is only for this headless root-owned host; the app's own settings (sandbox: true) are what ships.
electron="${SMOKE_ELECTRON:-$root/node_modules/electron/dist/electron}"
set +e
out="$(MEMELENS_DB="$db" MEMELENS_EXPECT_ROWS="$rows" timeout 60 xvfb-run -a "$electron" --no-sandbox "$app/dist/smoke.cjs" 2>&1)"
code=$?
set -e
printf '%s\n' "$out" | grep -E "^(PASS|FAIL|SMOKE)" || true
# Success needs both a zero exit code and the app's own "SMOKE OK" line: a crash that prints nothing must not pass.
if [ "$code" -eq 0 ] && ! printf '%s\n' "$out" | grep -q "^SMOKE OK"; then
  echo "smoke: exit code 0 but no 'SMOKE OK' line; treating as failure" >&2
  code=4
fi
exit "$code"
