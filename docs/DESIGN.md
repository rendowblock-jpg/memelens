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

- M0 repo, design, core skeleton, first function (concentration) - **this commit**
- M1 core: PnL (FIFO), risk score, smart-money ranking
- M2 storage + ReplayAdapter + ingest, CLI to run analyses on fixtures
- M3 Electron shell: feed, token page, wallet page
- M4 Solana adapter (needs a user-supplied RPC/data API key)
- M5 agent chat + tools
- M6 backtest engine + report UI

## Open questions (defaults chosen, change any of them)

- Chain: Solana first (default). EVM later via another adapter.
- Data provider: not chosen. Needs an RPC or indexer key from the user.
- LLM: any OpenAI-compatible endpoint; default is whatever the user configures.
