# MemeLens (working title) - design v1

Direction change recorded 12 Nov 2026 (`date -u`). Everything in "Hard constraints" below comes from the
product framing and is not a preference. If a later change seems to need one of them loosened, stop and ask.

## Product framing

A local-first analytics tool for people who trade memecoins. Analysis and backtests run on the user's own
machine, with the user's own model. We never touch the user's keys and never sign anything for them.
No account, no cloud backend of our own.

**The trust line: the agent cannot touch the user's machine.** It must stay literally true, not roughly true.
Every design choice below that looks restrictive exists to keep that sentence honest.

## What it does (v1 scope)

1. **Live token feed** - new and trending tokens, with the metrics below.
2. **Risk engine** - per-token score from explainable signals.
3. **Holder concentration** - top-N share, HHI, Gini, with LP/burn/program addresses excluded.
4. **Wallet tracking** - watchlist of addresses, activity stream.
5. **Per-address PnL** - realised/unrealised, FIFO cost basis, per token and total.
6. **Smart-money tagging** - wallets ranked by realised PnL and hit rate over a window.
7. **Agent chat** - a local agent that can read the database and call analysis functions.
8. **Backtests** - replay recorded data through a declarative strategy; report with costs and no look-ahead.
   Run by the sidecar (below), not in JavaScript.

## Non-goals

- No trade execution, no wallet signing, no custody of keys. Read-only analytics.
- No claim of financial advice. "Predictions" are heuristic scores. A score is shown as predictive only once a
  backtest shows it beats a naive baseline out of sample; the UI shows the sample size next to every score.

## Hard constraints

| # | Constraint | Why |
|---|---|---|
| C1 | **Electron stays.** | Too deep to migrate to Tauri, and it works. Not reopened. |
| C2 | **The agent is read-only.** Database reads and core-function calls only. No shell, no file writes. If that feels limiting, do not widen the agent: add a process (C4). | It is the trust line. |
| C3 | **The renderer CSP stays no-network** (`default-src 'none'`, `connect-src 'none'`). All network access lives in the main process. | See "The network rule". |
| C4 | **A second process will exist alongside the app** (the sidecar). The architecture must accommodate it. | See "The sidecar". |
| C5 | **Windows first.** Nothing counts as done until it runs on Windows and the owner has seen it (evidence level L3). | Users are on Windows. |
| C6 | **Repo split.** The app repo is public (SignPath Foundation needs open source), so nothing secret can ever be in it. The sidecar source is in a separate private repo and is never vendored into the public tree. | Signing, and keeping the engine's source private. |
| C7 | **Calibration before M4.** The risk weights are marked provisional until measured on real rugged and non-rugged tokens. | Honest scores. |

## Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron (C1) | one language everywhere; already built and tested |
| UI | React + Vite + TypeScript | |
| Core | `packages/core`, pure TypeScript, no I/O | deterministic, unit-testable anywhere |
| Storage | SQLite through Node's built-in `node:sqlite` (not better-sqlite3), exact amounts as text | no native build; supply can exceed SQLite's 2^63 |
| Chain | `ChainAdapter` interface; Solana first; `ReplayAdapter` for tests and backtests | chain-agnostic core, offline tests |
| Agent | OpenAI-compatible chat API (cloud or local, e.g. Ollama), called from the main process | the user picks the model |
| Backtest | Go binary, separate process (C4) | CPU-heavy; must not run in JS or block the UI |
| Secrets | Electron `safeStorage` (OS keychain) for API keys, main process only | never in the repo, the DB or the renderer |

## Architecture

**A second process will exist alongside the app, and every architectural choice has to accommodate it.**
In practice that means:
1. Nothing assumes the main process is the only one reading the database file.
2. Every boundary format is language-neutral and versioned. Bigint crosses as a decimal string (the `toWire` rule).
3. Logic that two languages must agree on has shared test vectors (see "Conformance"); the TypeScript core is the reference.
4. The app works with no sidecar installed. Only the backtest feature says "engine not installed".
5. The sidecar protocol is versioned independently of the app version.

```
renderer (React, no network, no Node)
    | IPC: 5 typed channels, sender checked
    v
main process  (owns ALL network access, the writer connection, API keys)
    |-- ChainAdapter (RPC / data API / replay) --> ingest --> SQLite file
    |-- core (pure functions: concentration, pnl, risk)
    |-- agent loop --> tools: sql_query (read-only), analyze_*, run_backtest(spec)
    '-- sidecar manager --stdio, JSON-RPC--> [ memelens-sidecar (Go, own process) ]
                                                    '--> SQLite file, read-only
```

- `core` never touches network, disk or clock; time is always passed in. That makes backtests reproducible and
  look-ahead bugs testable.
- The agent's tools are the same functions the UI uses. Nothing the agent can call writes anything.

## The network rule (why the CSP has no network)

The renderer shows text that attackers control: token names, symbols and metadata from the chain, and text a
model wrote after reading them. If the renderer could make requests, one rendering bug or one successful prompt
injection could send the user's watchlist, wallet addresses or endpoint settings to a stranger. With
`connect-src 'none'` (and `default-src 'none'`, no frames, no forms) a bug in the renderer has nowhere to send anything.

So all network access (chain data, the model API, sidecar downloads) lives in the main process, behind typed
adapters, with a fixed list of allowed hosts. **If a fetch in the UI is blocked, do not loosen the CSP. Add an IPC
channel and do the request in main.** Loosening it removes the property the whole privacy claim rests on.

## The agent's trust line

"Read-only" has to hold against a hostile prompt, not just a polite model. Requirements for M5 (not built yet):

- The agent gets its own read-only database connection, separate from the writer.
- `sql_query` accepts exactly one `SELECT`/`WITH` statement. It refuses `ATTACH`, `VACUUM` (including `VACUUM INTO`,
  which writes a new file), `PRAGMA`, `load_extension`, and any second statement. Check whether `node:sqlite`
  offers an authorizer callback; if it does not, a parse-level allowlist plus the tests below is the control.
- Row-count and time limits on every query.
- `run_backtest` takes a declarative spec (data, validated by main and again by the sidecar). Never code, never a path.
- A red-team test suite lists every refusal above with a hostile input and must fail if any is accepted.
- On-chain strings are untrusted input to the model. The agent has no write tool, so an injection can mislead
  an answer but cannot act. Chat output is rendered as text, never as HTML.

## The sidecar

First job: the backtest engine. It is CPU-heavy, must not run in JavaScript, and must not block the UI.
Backtests will change faster than the app ships, so the sidecar is installed and updated independently.

**Not in Electron's process tree.** My reading, please correct it if you meant something else: it is its own
executable with its own runtime, location and lifetime. It is not bundled in the asar, not an Electron
`utilityProcess`, and does not run on Electron's embedded Node. It is still a child of main through its stdio pipes,
because stdio JSON-RPC needs a parent. If you meant a detached background service, say so; the protocol stays the same.

**Where it lives.** A fixed per-user folder, independent of the app's name, version and install path:
`%LOCALAPPDATA%\MemeLens\sidecar\` on Windows (`~/Library/Application Support/MemeLens/sidecar` on macOS,
`~/.local/share/memelens/sidecar` on Linux). The folder name is a stable product id, because the display name is
a working title. It is not `app.getPath('userData')` (that is the roaming profile) and not under Program Files.

```
sidecar/
  versions/<semver>/memelens-sidecar[.exe]  +  manifest.json
  current.json        {"version": "..."}   replaced atomically (write temp, rename)
  previous.json       one step of rollback
```

**Surviving reinstall and version change.** The MSI installs only the app. Install, upgrade and uninstall never
touch `%LOCALAPPDATA%\MemeLens`. Windows tests, in order: install the MSI, install a sidecar, reinstall or upgrade
the MSI, check the same sidecar version still answers `hello`; then replace the sidecar with a newer one without
touching the app; then uninstall the MSI and check the sidecar and database are still there.

**Protocol.** JSON-RPC 2.0, one JSON message per line (UTF-8) on stdin/stdout. stderr is log lines only. The
protocol document and the test vectors live in the public repo; the implementation lives in the private one.
- `hello` -> `{protocol, engineVersion, capabilities}`. Compatibility is decided on the protocol major number
  and additive capabilities. An engine outside the range the app supports is refused with a plain message.
- `backtest.run(spec)` with `backtest.progress` notifications, `backtest.cancel`, `shutdown`.
- The engine exits when stdin closes, so a crashed app cannot leave it running.
- Main enforces a time limit per request and kills the process on a hang. The engine also sets its own memory limit.
- Bigint values are decimal strings. A result carries `engineVersion`, a hash of the spec, and the data as-of time.

**Data access.** The sidecar opens the database file itself, read-only, using a path main hands it; the path never
comes from the agent. Streaming millions of trades through JSON would block main while it serialises. The store
currently sets no `journal_mode` (SQLite's default rollback journal), so a reader can hit "busy" while main ingests.
Decide in the sidecar slice: switch to WAL or hand the sidecar a snapshot. Test it with a concurrent ingest.

**Determinism and conformance.** Same spec plus same data gives byte-identical output (seeded, no wall clock). The
TypeScript core is the reference. Test vectors (inputs and exact expected outputs for FIFO PnL and the no-look-ahead
cut) live in the public repo. The private repo's CI fetches them and the engine must reproduce them exactly.

**Updating it.** Main (the only process with network access) checks a manifest, downloads to a `.partial` file,
checks sha256 and an ed25519 signature against a public key pinned in the app, runs a `hello` self-test, then
switches `current.json`. The previous version is kept. Default: tell the user a new engine exists and ask before
installing. The install folder is writable by the user, so main re-checks the hash before every launch.

**What the sidecar cannot do** (to be enforced and tested, none of it built yet): no network, no writes to the
database, no code supplied by the agent or the user. Whether Windows can enforce "no network" for an unprivileged
per-user process (firewall rule, AppContainer) is not decided; until a test shows it, "no network" is a promise
about the code, not a measured fact.

**Where the binary is downloaded from.** Not from the private repo: release assets of a private repo need a token,
and users have none. Default: a public releases-only repo that holds binaries and manifests but no source. The app's
public CI can then fetch the engine for its Windows integration test with no secret at all. Do not compile the
private source inside the public repo's CI: public Actions logs are world-readable, and a compile error prints source.

## Windows first

There is no Windows machine on the build host. Packaging runs on a GitHub Actions `windows-latest` runner (free for
public repos) and produces the MSI. The packaging tool (electron-builder's MSI target or Electron Forge's WiX maker)
is chosen by trying it on the runner, not by reading about it.

**Done means** (C5): the runner produced the MSI; it installed on a real Windows machine; the app starts; the window
shows the feed built from the sample fixture; the security smoke checks pass there; the owner has seen it. Anything
less is reported as "built" or "probed", not "done". Installing on the owner's PC needs his word that turn.

Things only a Windows run can settle (none measured yet):
- `resolveAppFile` was tested with POSIX paths. Add Windows cases: `..\`, drive letters, UNC paths, alternate data
  streams (`name::$DATA`), reserved names (`CON`, `NUL`), trailing dots and spaces, 8.3 short names.
- `sandbox: true` has never run in a real Chromium sandbox; the host smoke test uses `--no-sandbox`.
- `node:sqlite` inside Electron 45 (Node 24) on Windows.
- Start-up time and memory on the owner's PC (a Celeron N3060 with about 1.8 GB free RAM). No budget exists yet.

## Repos, licence and signing

- **Public app repo** (not created yet when this was written; see Status for the result): everything in this tree, the protocol document, the test
  vectors, CI, and the *public* key that verifies sidecar releases. Nothing secret, ever. Before the first push the
  tracked tree and the full history are scanned.
- **Private sidecar repo** (not created yet): the Go source and the engine's private signing key (as a CI secret).
- **Licence: not chosen.** It must be OSI-approved with no commercial dual licensing. Needed before the first release.
  Recommendation: Apache-2.0.
- **SignPath Foundation** (https://signpath.org/terms.html) lists these conditions: an OSI-approved licence for
  all components; no proprietary non-open-source component in the project; binaries built from source in a
  verifiable way; already released; manual approval of every release.
  **Conflict to resolve:** a closed sidecar that the app downloads and launches may count as a proprietary component of
  the project. The layout above keeps it out of the MSI, which is the only layout compatible with any option, but
  whether SignPath accepts it is their decision. Ask in the application. Fallbacks: open-source the engine (also the
  strongest answer to "why should I trust a binary that runs on my machine"), or sign the app another way.

## Risk engine signals and calibration

The score is a weighted sum; each signal is shown with its value, weight and contribution. A missing signal is never
treated as safe: the score covers what is known, and `coverage` says how much that was.

| Signal | Weight | Data source today |
|---|---|---|
| top-10 holders' share | 15 | yes |
| holder concentration (HHI) | 10 | yes |
| creator's share of supply | 15 | yes |
| creator's earlier dumps | 15 | **no** |
| liquidity vs. market cap | 15 | **no** |
| mint authority still active | 8 | yes (also forces level >= high) |
| freeze authority still active | 4 | yes (also forces level >= high) |
| shared-funder clustering | 8 | **no** |
| wash-trading share of volume | 5 | **no** |
| token age | 5 | yes |

Weights sum to 100. The six signals with a data source carry 57 points, so today the score cannot exceed 57%
coverage, and the default minimum coverage is 50%. Levels: below 25 low, below 50 medium, below 75 high, else
critical. **All weights and thresholds are PROVISIONAL: first guesses, not measured.**

### Calibration protocol (gate before M4 - not run yet)

Score 30 tokens that rugged against 30 that did not, and report the hit rate for each group.
- **Labels fixed before scoring.** The definition of "rugged" is written down and committed before any score is
  looked at. Proposed: liquidity removed or price down 90% or more from peak within 72 hours, with a creator or
  insider sell-off. "Did not rug": same venue and launch window, still trading after 30 days, picked at random,
  not by hand.
- **Same scoring time for both groups,** defined relative to launch (for example launch + 1 hour), never relative to
  the outcome. Data after that time is invisible (the as-of machinery already guarantees this). Scoring "just before
  the rug" would leak the answer.
- **Report per group:** rugged flagged high or above (hit rate), not-rugged left at medium or below (specificity),
  and the count scored "unknown" listed separately, never dropped.
- **Intervals.** With 30 per group the uncertainty is wide: 24/30 = 80% has a 95% Wilson interval of 63-90%, and
  18/30 = 60% has 42-75% (computed 12 Nov). Report the interval next to every rate.
- **No tuning on the same 60.** If weights are changed after seeing these results, the new numbers are in-sample and
  a new, untouched set is needed before the weights stop being provisional.
- **Real data only.** Scoring tokens I generate would measure my own assumptions. The 60 must come from real chain
  history; see Open questions.

| Group | n | Flagged high or above | Rate | Wilson 95% | Unknown |
|---|---|---|---|---|---|
| Rugged | 30 | NOT MEASURED | | | |
| Did not rug | 30 | NOT MEASURED | | | |

## Testing and process

- **Test first** for every behaviour change. See the test fail for the right reason before writing the code.
- **Mutation checks on new core logic only** (pure functions in `core` and `service`, and the engine's own maths).
  None on glue, rendering or IPC wiring. Survivor notes: one or two lines each.
- Existing mutation lists in `scripts/mutations/` stay as regression checks and are not extended for glue.
- Backtests get explicit look-ahead tests: a strategy that peeks at the future must be rejected or show no edge.
- Adapters are tested against recorded fixtures, not the live network.
- Never say "fixed", "done" or "works" without the check run in the same turn and its exit code read.

## Milestones (order set 12 Nov 2026)

1. **M3c** screens: feed, token page, risk panel, wallet page (M3a service and M3b Electron shell are done)
2. **W** Windows packaging: MSI from CI, run on Windows, seen by the owner (L3)
3. **S** sidecar: the slot (manager, protocol, versioned folder, update check) and the Go backtest engine, with conformance vectors
4. **C** calibration gate: 30 rugged vs 30 not, numbers into the weights table above
5. **M4** Solana adapter (needs a user-supplied RPC or data API key)
6. **M5** agent chat and tools (with the red-team suite above)
7. **M6** backtest report UI

Done earlier: M0 design and concentration, M1a PnL, M1b risk, M1c smart money, M2 storage, ReplayAdapter, ingest, CLI,
M3a service layer, M3b Electron main, preload and security, M3c-1 formatting, M3c-2 first presentational components.

## Open questions

- **Licence** (legal): Apache-2.0 recommended. Needed before the first release and before the SignPath application.
- **SignPath vs a closed sidecar:** open-source the engine, or ask SignPath, or sign another way (see above).
- **Calibration data:** needs real labelled history. Either a public dataset of rugged Solana tokens, or an RPC/indexer
  key for a one-off collection script (outside the app; the adapter is M4).
- **"Not in Electron's process tree":** reading above, please confirm.
- **Update policy default** for the engine: ask before installing (chosen), or install silently.
- Chain: Solana first. EVM later, through another adapter.
- LLM: any OpenAI-compatible endpoint; the user configures it.

## Status (12 Nov 2026, repo HEAD b71a4b9 before this change)

Measured this turn: `vitest run` 607 tests in 23 files, exit 0; `tsc --noEmit` exit 0 for `packages/core`,
`packages/data`, `packages/service` and `apps/desktop`.

Run the CLI: `npm run memelens -- ingest packages/data/fixtures/sample.json --db demo.sqlite`, then
`npm run memelens -- smart --db demo.sqlite`. Exit codes: 0 done, 1 could not be done, 2 command written wrongly,
3 ingested but items were rejected.

Known gaps (not hidden):
- Everything is verified on synthetic data. Nothing has touched real chain data.
- Risk weights and thresholds are provisional (see calibration). Only 6 of 10 signals have a data source.
- Not run on Windows. The Electron sandbox has not run for real. No MSI, no sidecar, no Solana adapter, no agent chat.
- `feed` runs several queries per token; the cost with thousands of tokens is unmeasured.
- Two store mutation survivors are accepted: dropping `, id` from the ascending `ORDER BY time, id` in
  `Store.tradesForWallet` and `Store.tradesForToken`. They looked equivalent on this SQLite build (primary-key scan
  keeps the order, seen with `EXPLAIN QUERY PLAN`); the clause stays so the order does not depend on the planner.
- Mutation runs cover core, replay, store, ingest, analyze, args, CLI options and render layer, service, handler,
  security and the formatting functions. Under the new process rule they are not extended to glue or rendering.
  The component mutation check noted as pending in the M3c-2 commit message is cancelled by that rule.
- Unmeasured: the Electron process for this app on a slow PC; WAL versus rollback journal with a second reader.

## History: M3 groundwork (measured on the host; date not recorded)

Probe in a throwaway project, `electron@45.3.0` under `xvfb-run -a npx electron --no-sandbox main.js`:
- Electron 45.3.0 starts headless, opens a hidden BrowserWindow and loads a page (Chrome 156.0.8078.96).
- Its embedded Node is 24.22.2 (the host runs 22.23.3, which the tests use). `node:sqlite` works inside Electron
  (SQLite 3.53.4), so the store needs no native build in either runtime.
- `npm i electron` does not download the binary here; run `node node_modules/electron/install.js` once.
- `--no-sandbox` was needed on this root-owned headless host. That is a host quirk, not a setting to ship.
