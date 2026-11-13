# MemeLens (working title)

A local-first analytics tool for people who trade memecoins. Analysis and backtests run on your own machine. There is
no account and no cloud backend of ours. **It is read-only: it never holds your keys, never signs, never trades.**

> **Status: pre-release.** There is no published release and no installer you can download from here. The app runs on a
> bundled, made-up sample dataset; it has no real-data adapter yet. A risk score here is a heuristic, and its weights have
> **not** been calibrated against outcomes yet (see [Calibration](#calibration)). Nothing in this repository is financial
> advice.

## What is in it

| Part | What it is | State |
|---|---|---|
| Token feed, risk score, holder concentration | Per-token metrics with an explainable score; the level is always shown in words, never colour alone | built, on sample data |
| Wallet detail, per-address PnL, smart-money ranking | FIFO cost basis, realised and unrealised, ranked over a window | built, on sample data |
| Backtest | Replays recorded trades through a declarative strategy and reports costs, with no look-ahead. Runs in a separate Go engine (the sidecar), not in JavaScript | built; the engine's source is in a private repository, its signed binaries are published separately |
| Calibration collector (`packages/collector`) | Watches new pump.fun launches, stores RugCheck reports, and later checks what happened to each token, to measure whether the score predicts anything | running since 13 Nov 2026; first result not before mid-December 2026 |
| Agent chat | A read-only local agent | not built |
| Real-data adapter for the feed | Solana first | not built |

## The trust line

The agent cannot touch your machine: database reads and analysis functions only, no shell, no file writes. The window
that shows the UI has a content-security policy with no network at all; only the main process may reach the network, to
one allow-listed host, for signed engine updates. The engine is checked against a signed manifest (name, size, SHA-256)
before every launch. What is **not** enforced by the operating system yet: "the engine has no network". The reasons for
every restriction are in [`docs/DESIGN.md`](docs/DESIGN.md).

## Build and test

Node 22 (a recent 22.x: the store uses `node:sqlite`).

```
npm ci
npm test                 # vitest, the whole workspace
npm run typecheck:all    # tsc for every project
```

Try the command-line tool on the sample data:

```
npm run memelens -- ingest packages/data/fixtures/sample.json --db demo.sqlite
npm run memelens -- smart --db demo.sqlite
```

Run the desktop app from source: `npm run build -w apps/desktop`, then `npm start -w apps/desktop`.

The 120-combination UI audit (10 states, 3 window sizes, 4 accessibility modes, in a real Chromium) is
`scripts/audit-states.mjs`; on a machine with no display run it under `xvfb-run -a`. Windows is built, installed, run
and uninstalled in CI on every push (`.github/workflows/windows.yml`).

## Calibration

The score's weights and thresholds are provisional. The way they will be set is written down **before** any outcome
exists, in [`docs/DESIGN.md`](docs/DESIGN.md): how tokens are sampled (a hash of the mint, fixed in advance), how a token
is labelled "rugged" or "did not rug", how groups are picked, and what will be reported (all tokens, and tokens with an
exact or estimated holder snapshot, side by side, with Wilson intervals). No weight, threshold, label rule or group size
changes after results are seen. The results table in that document says `NOT MEASURED` until one run of
`packages/collector`'s `analyze` command, after every reading has been taken or given up on, fills it.

## Layout

```
apps/desktop        Electron app: main process, preload, renderer (React)
packages/core       pure logic: risk signals, concentration, PnL, smart-money ranking
packages/data       SQLite store, ingest, command-line tool
packages/service    the typed channels between the window and the main process
packages/sidecar    client for the Go engine: protocol, signed-update path, install layout
packages/collector  calibration pipeline: collector, exporter, labeller, analysis
docs/DESIGN.md      design, constraints, measurements, status (read this first)
docs/SIDECAR-PROTOCOL.md   the app-to-engine protocol
docs/ui-readings    what the UI looked like, how it was checked, what was fixed
scripts             audit, probes, smoke tests, mutation lists
```

## How this is checked

Behaviour changes start as a failing test. New logic is mutation-checked: a script breaks the code in small ways and the
tests must notice each one; the lists are in `scripts/mutations/` and the survivors that are really equivalent code are
named in `docs/DESIGN.md`. Numbers in the documents are measured on the day they are dated, not carried forward.

## Licence

None has been chosen yet, so by default nobody may reuse this code. A licence will be added before any release.
