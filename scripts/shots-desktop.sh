#!/usr/bin/env bash
# Starts the real app on the sample data under a virtual display and saves a picture of each screen listed in
# scripts/shots-steps.json. For looking at the design, not a test. usage: scripts/shots-desktop.sh [OUT_DIR]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$HOME/.cache/memelens-shots}"
work="${SMOKE_DIR:-$HOME/.cache/memelens-smoke}"
mkdir -p "$work" "$out"
rm -f "$out"/*.png
db="$work/shots.sqlite"
rm -f "$db" "$db-wal" "$db-shm"
(cd "$root/apps/desktop" && node build.mjs >/dev/null)
(cd "$root" && npm run -s memelens -- ingest packages/data/fixtures/sample.json --db "$db" >/dev/null)
electron="${SMOKE_ELECTRON:-$root/node_modules/electron/dist/electron}"
# --no-sandbox is only for this headless root-owned host.
MEMELENS_DB="$db" SHOTS_DIR="$out" SHOTS_STEPS="$(cat "$root/scripts/shots-steps.json")" \
  timeout 100 xvfb-run -a -s "-screen 0 1600x1000x24" "$electron" --no-sandbox "$root/apps/desktop/dist/shots.cjs" 2>&1 | grep -E "^(SHOT|SHOTS|\[app\])" || true
ls -1 "$out"
