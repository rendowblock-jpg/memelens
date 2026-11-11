# MemeLens (working title) - design v0

A local-first desktop app for memecoin on-chain analytics. Everything runs on the
user's machine: data in a local SQLite file, analysis in a local process, an agent
chat that calls local tools. No account, no cloud backend of our own.

## What it does (v1 scope)

1. **Live token feed** - new and trending tokens, with the metrics below.
2. **Risk engine** - per-token score from explainable signals (see below).
3. **Holder concentration** - top-N share, HHI, Gini, with LP/burn/program addresses excluded.
4. **Wallet tracking** - watchlist of addresses, activity stream.
5. **Per-address PnL** - realised/unrealised, FIFO cost basis, per token and total.
6. **Smart-money tagging** - wallets ranked by realised PnL and hit rate over a window.
7. **Agent chat** - a local agent with tools: query the DB, run an analysis, run a backtest.
8. **Backtests** - replay recorded data through a strategy; report with costs and no look-ahead.

## Non-goals

- No trade execution, no wallet signing, no custody of keys. Read-only analytics.
- No claim of financial advice. "Predictions" are heuristic scores. A score only
  gets shown as predictive once a backtest shows it beats a naive baseline out of
  sample; the UI shows the sample size and the calibration next to every score.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron | one language everywhere, bundled Node for agent tools, builds on Windows |
| UI | React + Vite + TypeScript | |
| Core | `packages/core`, pure TypeScript, no I/O | deterministic, unit-testable anywhere |
| Storage | SQLite (better-sqlite3), main process | local-first, single file, easy backup |
| Chain | `ChainAdapter` interface; Solana first; `ReplayAdapter` for tests/backtests | chain-agnostic core, offline tests |
| Agent | OpenAI-compatible chat API (cloud or local, e.g. Ollama) with tool calling | user chooses the model |
| Secrets | Electron `safeStorage` (OS keychain) for API keys | never in the repo or the DB |

## Architecture

```
renderer (React)  <--IPC-->  main process  --> ChainAdapter (RPC / data API / replay)
                                  |                 |
                                  |             ingest -> SQLite
                                  +--> core (pure functions: concentration, pnl, risk, backtest)
                                  +--> agent loop --> tools (sql_query, analyze_token, run_backtest)
```

- `core` never touches network, disk or clock; time is always passed in. That is
  what makes backtests reproducible and look-ahead bugs testable.
- The agent's tools are the same functions the UI uses. The agent can only read
  the DB and run core functions; no shell, no file writes outside the app's data dir.
- Backtests run in a worker thread with a time and memory limit.

## Risk engine signals (first set, all explainable)

holder concentration (top-10 share, HHI), creator holdings and dump history, LP
size vs. market cap, mint/freeze authority still set, wallet clustering (same
funding source), age and volume anomalies (wash-trading patterns). The score is a
weighted sum; each signal is shown with its value and its weight.

## Testing approach

Test first for every core function. Pure functions get table tests plus property
tests where it fits. Backtests get explicit look-ahead tests (a strategy that peeks
at the future must be rejected or produce no edge). Adapters are tested against
recorded fixtures, not the live network.

## Milestones

- M0 repo, design, core skeleton, first function (concentration) - done
- M1a core: per-address PnL, FIFO, exact bigint, `asOf` cut-off - done
- M1b core: risk score (explainable weighted signals, unknown != safe, hard flags) - done
- M1c core: smart-money ranking (windowed realised PnL, hit rate with Wilson lower bound, nothing dropped silently) - done
- M2 storage + ReplayAdapter + ingest, CLI to run analyses on fixtures
- M3 Electron shell: feed, token page, wallet page
- M4 Solana adapter (needs a user-supplied RPC/data API key)
- M5 agent chat + tools
- M6 backtest engine + report UI

## Open questions (defaults chosen, change any of them)

- Chain: Solana first (default). EVM later via another adapter.
- Data provider: not chosen. Needs an RPC or indexer key from the user.
- LLM: any OpenAI-compatible endpoint; default is whatever the user configures.


## Status (end of M2)

Done and tested: core analytics (concentration, FIFO PnL, risk score, smart-money ranking), SQLite store,
ingest, analysis glue, strict CLI with text and JSON output.

Run it: `npm run memelens -- ingest packages/data/fixtures/sample.json --db demo.sqlite`, then
`npm run memelens -- smart --db demo.sqlite`. Exit codes: 0 done, 1 could not be done, 2 command written wrongly,
3 ingested but items were rejected.

Known gaps (not hidden):
- Everything is verified on synthetic data only. Nothing has touched real chain data yet.
- Risk weights and thresholds are first guesses, not calibrated.
- Only 6 of 10 risk signals have a data source (creator history, liquidity, clustering, wash trading do not).
- Two mutation survivors are known and accepted: dropping `, id` from the ascending `ORDER BY time, id` in
  `Store.tradesForWallet` and `Store.tradesForToken`. They are equivalent under this schema: with or without the
  trade indexes SQLite scans the `(chain, id)` primary key and its sort keeps that order (checked with
  `EXPLAIN QUERY PLAN`). The clause stays because it makes the order deterministic whatever the planner does.
  The third (`lastMark`, descending) is killed by a test that drops the index.
- Mutation runs cover core, replay, store, ingest, analyze, args, and the CLI options and render layer. They do
  not cover CLI error-message branches, the ingest and status text, or `bin.ts`.
- Not run on Windows. No Electron shell, Solana adapter, agent chat or backtest yet (M3-M6).

## M3 groundwork (measured on the host, nothing built yet)

Probe: a throwaway project in /tmp (not in this repo) with `electron@45.3.0`, run under `xvfb-run -a npx electron --no-sandbox main.js`.
- Electron 45.3.0 starts headless, opens a hidden BrowserWindow and loads a page (Chrome 156.0.8078.96).
- Its embedded Node is 24.22.2 (the host runs Node 22.23.3, which the test suite uses). `node:sqlite` works inside Electron
  (SQLite 3.53.4), so the store needs no native build in either runtime.
- `npm i electron` does NOT download the binary here (no postinstall in v45). Run `node node_modules/electron/install.js` once.
- `--no-sandbox` was needed on this root-owned headless host. That is a host quirk, not a setting to ship.
- Not yet checked: packaging, the Windows build, and running the store from the Electron main process with the TypeScript
  sources (the probe used plain JS).

Plan for M3: main process owns the Store and calls the analysis functions; the renderer (React) only calls a small
typed IPC API and gets plain JSON with bigint as decimal strings (same rule as the CLI's `--json`).
