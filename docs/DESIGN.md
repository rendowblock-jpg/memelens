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
sets `journal_mode = WAL` on every file database (checked 12 Nov 2026 in packages/data/src/store.ts; the earlier text here was wrong), so a read-only reader sees a consistent snapshot while the app ingests. The contract test reads a file while the app's writer connection is open and the file's SHA-256 is unchanged afterwards (Linux, local run only).

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

There is no Windows machine on the build host, so Windows is exercised on a GitHub Actions `windows-latest` runner
(free for public repos). `.github/workflows/windows.yml` has two jobs, both on Windows, with every action pinned to a
commit SHA and no secrets:
- **Tests and smoke:** `npm ci`, `typecheck:all`, the whole unit-test suite, then `scripts/smoke-desktop.mjs`, which
  starts the real Electron app with the sandbox on (no `--no-sandbox`).
- **MSI, install, run, uninstall:** `apps/desktop/pack.mjs` builds the MSI; the job installs it silently with `msiexec`,
  starts the INSTALLED `MemeLens.exe`, and `scripts/check-packaged.mjs` talks to its window over the Chrome DevTools
  protocol, clicks through the screens, checks them and saves a picture of each; then it uninstalls and checks the
  executable is gone. The MSI, the pictures and the install logs are kept as the artifact `memelens-windows` for 14 days.

**Done means** (C5): the runner produced the MSI; it installed on a real Windows machine; the app starts; the window
shows the feed built from the sample fixture; the security smoke checks pass there; the owner has seen it. Anything
less is reported as "built" or "probed", not "done". Installing on the owner's PC needs his word that turn.

### Measured on 12 Nov 2026 (run 43185415658, commit 1d1d768, `windows-latest`, Node 22.23.4)
- **Built:** the MSI (`MemeLens-0.1.0-x64.msi`, 126,558,208 bytes) built with electron-builder 26.18.0 and Electron 45.3.0.
  It is **unsigned**: Windows SmartScreen will warn until the SignPath application is approved.
- **Installed:** `msiexec /i ... /qn` exit code 0, per user, to `%LOCALAPPDATA%\Programs\memelens\MemeLens.exe`
  (no administrator needed). The executable reports itself as MemeLens 0.1.0.0 from "MemeLens contributors".
- **Ran:** the installed app passed 15 of 15 checks: the feed shows all 5 tokens, the synthetic-data notice, the risk gauge
  and a 10-signal bar; no `require`/`process`/`Buffer` in the page; exactly the 5 channels; network fetch, eval and inline
  script blocked; the renderer runs as its own process (`--type=renderer`); **no process of the app has `--no-sandbox`
  in its command line**; clicking Smart money ranks alice first with +0.005 SOL, and her wallet page shows realised
  +0.005 SOL and 10 trades. Pictures of the three screens were saved (1008x655). Measured from their pixels: the dominant colour of the rail is
  #0c0f14, of the page #080a0e and of the notice bar #11151c, exactly the stylesheet's values.
- **Uninstalled:** exit code 0, and `MemeLens.exe` was gone.
- **Tests on Windows:** 681 of 681 pass, including the new Windows file-name tests, and `tsc` is clean. This settles two
  items that were open: `node:sqlite` works inside Electron 45 on Windows, and the sandboxed window starts and works
  without `--no-sandbox` (the smoke test reports the sandbox preference on and the switch absent).
- **What the first Windows run found** (all fixed): a store test deleted a folder while a database in it was still open
  (Linux allows that, Windows answers EBUSY); the app's "finished loading" flag came before the first token's panel, a
  race that only showed on the slower machine; and the "no `--no-sandbox`" step I first wrote ran after the app had
  exited, so it checked nothing. It is now done inside the checker while the app runs.

### The Windows feed picture: delivered to the owner, NOT looked at by the reviewer
The feed screen of the installed app on the runner (1008x655) was reduced to 64 colours (sampled mean colour error 0.7
of 255) and sent to the owner's chat in four pieces; its SHA-256 matched the file on the host. **The reviewer (the agent
that wrote this) could not see it:** the image tool returned only "Image: ... (21294 bytes, image/png)", no pixels. So
nothing in this document describes how that picture looks. What is known about this screen comes from measurement:
- From the Windows picture's pixels: dominant colours of the rail, page and notice bar equal the stylesheet's values.
- From the host build of the same renderer (browser audit tools, 1360x860 and 900x600): the accessibility text of the first
  row reads "critical 93 mintAuthority 57% of signals known"; table rows are 66 px apart (three-line risk cell); no
  overflow, overlap, cut-off text or covered controls.
- From the stylesheet: below 1180 px width the detail panel stacks under the table, so in a 1008 px window the gauge and
  the risk bar are below the first screen. **Not measured on Windows.**
- A compact row is a likely later change: at 66 px per row, hundreds of tokens mean a lot of scrolling.
- Not measured at all: the gauge, the risk bar, the smart-money and wallet screens as drawn (only their text and boxes).
Whether the design is good is for the owner to judge when he installs it.

### Delivery to the owner, and the latest Windows run
- **Draft release `v0.1.0-preview.1`** (id 442707219, target commit `e1c4e4c`) holds `MemeLens-0.1.0-x64.msi` (126,578,688
  bytes, SHA-256 `5F1A6EFB45AA648F52D7EA7E68E4FF5DCDE22D06B6903CA9398F755A3DC08C6C`). GitHub's own digest of the uploaded file
  equals the value the Windows build printed, and the file was hashed again on the host. It is a draft and a pre-release:
  with no credentials the release answers 404 and the public releases list is empty, so only repository admins see it.
  The notes say it is unsigned, synthetic-data only, and untested by anyone on a real PC. Nothing was installed anywhere.
- **Run 43188552598** (commit `b0e23d1`, which adds the mutation-guided tests and `needs: test`): on Windows, 697 of 697
  tests passed and the real-app smoke passed 16 of 16; the package job started only after the test job finished.
- **Host files:** artifacts are kept in `~/.cache/memelens-artifacts`, not `/tmp`: `/tmp` is a 3.9 GB tmpfs shared with
  other work and filled up once during this session.

### Packaging decisions
- **`upgradeCode` is `80E58C9E-4267-4FF5-A0F0-65565D71F798` and must never change.** Windows Installer uses it to know
  that a new version replaces the old one. Generated once on 12 Nov 2026; it is the constant in `apps/desktop/pack.mjs`.
- **Per-user install** (`perMachine: false`), matching the per-user sidecar folder `%LOCALAPPDATA%\MemeLens`.
- **Staged outside the repository.** The first attempt packed `react`, `react-dom` and the `@memelens/*` sources into
  `app.asar` (8.7 MB) because electron-builder walks up from the app folder, finds the workspace and adds its dev
  dependencies. `pack.mjs` now stages into the OS temp folder and fails the build unless `app.asar` holds exactly the 7
  expected entries (310 KB).
- **Electron fuses** (switches inside the executable; the install folder is user-writable): `RunAsNode` off,
  `NODE_OPTIONS` and `--inspect` off, `onlyLoadAppFromAsar` on, embedded asar integrity validation on, cookie
  encryption on. Read back from the Linux build with `electron-fuses read` and checked there (the app still passes 14
  of 14 packaged checks and ignores `ELECTRON_RUN_AS_NODE`). **Seen on Windows (run 43186263409):** the build log shows `executing @electron/fuses` and `updating asar
  integrity executable resource` for `MemeLens.exe`, and the installed app then started and passed 15 of 15 checks, so
  these fuses do not stop it running. Not seen: the fuse values read back from the Windows binary (only the Linux one).
- **Window size** fits the usable screen (`windowSize`, tested): the owner's laptop is probably 1366x768, which leaves
  about 728 rows under the taskbar, and a fixed 860-row window would have hung off the bottom.
- **Host-side tooling:** `/root/projects/tools/ml-ci.sh status|failed|log|fetch` reads the run, its logs and its artifacts
  with the stored token without printing it. It lives outside the repository on purpose.

### Not done, and not claimed
- **The owner has not seen it.** Nothing here is at evidence level L3. The MSI is waiting as a CI artifact; installing it
  on his PC needs his word that turn. None of the three was looked at by the reviewer, who cannot see pixels here (see the next section); they were
  checked by measurement.
- **Start-up time and memory on his PC** (a Celeron N3060 with about 1.8 GB free RAM) are unmeasured and there is no budget yet.
- **"The sandbox is enforced"** is shown by the switch being absent and the preference being on, not by inspecting the
  renderer's token. A stronger check would read the renderer process's integrity level.
- **Upgrade and reinstall** (a second MSI over the first, then the sidecar folder surviving) is not tested: there is only
  one version and no sidecar yet.
- **The package job waits for the test job** (`needs: test`, added 12 Nov), so a red test cannot produce an MSI.
- **No code signing**, no auto-update, no macOS or Linux packaging.

## Repos, licence and signing

- **Public app repo** (https://github.com/rendowblock-jpg/memelens, created and pushed 12 Nov 2026): everything in this tree, the protocol document, the test
  vectors, CI, and the *public* key that verifies sidecar releases. Nothing secret, ever. Before the first push the
  tracked tree and the full history are scanned.
- **Private sidecar repo** (https://github.com/rendowblock-jpg/memelens-sidecar, created 12 Nov 2026, empty): the Go source
  and the engine's private signing key (as a CI secret). Checked: with credentials the API says `private: true`; without
  credentials it answers 404, so a stranger cannot even see that it exists.
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

## Sidecar: state on 12 Nov 2026

- **Contract:** `docs/SIDECAR-PROTOCOL.md`. **Vectors:** `packages/sidecar/vectors/*.json`, written by `scripts/sidecar-vectors/gen.py`, a Python implementation that shares no code with either side: 27 PnL cases (9 invalid inputs), 19 backtest cases, 57 invalid specs, 10 canonical-JSON cases and 5 refusals. The TypeScript core agrees with every PnL vector.
- **App side, `packages/sidecar`:** line codec, canonical JSON and spec hash, spec and report checkers (the report's summary must equal the sum of its positions), install layout with atomic pointers, verify-before-launch and rollback, ed25519 manifest check with a small-order-key guard, process client with timeouts, protocol-error limits, cancellation and a minimal environment for the engine. Not wired into the Electron main process, no update downloader, no UI.
- **Engine, private repo `memelens-sidecar` (Go 1.26.8):** `hello`, `pnl.compute`, `backtest.run`, `backtest.cancel`, `shutdown`; reads the app's SQLite file read-only. It passes the contract test locally on Linux (10 of 10) and its own Go tests on Linux and Windows CI (run 43195099811).
- **Not yet seen:** the contract test on Windows. Its first run failed because `testdata/vectors.pin` named a commit older than the test file; the pin was moved to `79b0a14` and the result of that run is not known when this is written.
- **Mutation checks (sidecar logic, 157 mutants):** codec/canonical 38 of 38; spec/report 57 of 58; layout/signature 51 of 61 on the first full run. Ten survivors were then marked "equivalent" by reading the code, not by proof, and one more test (fail closed on an internal error) was added afterwards and **not re-run through the mutants**.
- **Not built:** a download/update client, the pinned public key, the engine's memory budget (`-32003` is defined, not enforced), operating-system enforcement of "no network", code signing.

## Toolchain notes

- **Go on the host:** `go1.26.8` from the system package manager (`golang-go`). The official download hosts
  (`dl.google.com`, `go.dev/dl`) answer 404 from this machine even for old releases, and `go.dev/dl/?mode=json` lists
  `go1.27.4` whose file does not exist there; the first attempt downloaded a 1,449-byte HTML error page and the SHA-256
  check refused it. Go cross-compiles to Windows natively (`GOOS=windows`), but a Windows binary still has to be run on
  the Windows runner before it counts.

## Testing and process

- **Test first** for every behaviour change. See the test fail for the right reason before writing the code.
- **Mutation checks on new core logic only** (pure functions in `core` and `service`, and the engine's own maths).
  None on glue, rendering or IPC wiring. Survivor notes: one or two lines each.
- Existing mutation lists in `scripts/mutations/` stay as regression checks and are not extended for glue.
- Backtests get explicit look-ahead tests: a strategy that peeks at the future must be rejected or show no edge.
- Adapters are tested against recorded fixtures, not the live network.
- Never say "fixed", "done" or "works" without the check run in the same turn and its exit code read.
- **Mutation checks on the Windows work and the M3c logic (12 Nov 2026):** `scripts/mutations/renderer-logic.json` (51
  mutants: `riskBar`, `gaugeArc`, `smartWindow`, `formatSigned`, `formatSignedPercent`, `countOf`, `pickChain`),
  `desktop-window.json` (11: `windowSize`) and `security-windows.json` (29: the Windows file-name refusals). First run: 81
  of 91 caught. The 10 survivors pointed at 9 missing tests (an infinite gauge radius, time 0, the digit bounds, a bad
  wanted or minimum window size, short names `~2`..`~9`, the superscript-three device names, and names that merely end in
  a device name such as `mycon.css`); all were added. Second run: 90 of 91. The survivor is `ratio > 0` -> `ratio >= 0` in
  `formatSignedPercent`, equivalent because exactly 0 returns on the line before it.

## Milestones (order set 12 Nov 2026)

1. **M3c** screens: feed, token panel with risk lens, smart-money ranking, wallet panel - **done on the host** (see "The screens"); not yet seen on Windows
2. **W** Windows packaging: MSI from CI - **built, installed, run and uninstalled on a Windows runner (run 43185415658)**; still open: the owner installs it and sees it (L3)
3. **S** sidecar: the slot (manager, protocol, versioned folder, update check) and the Go backtest engine, with conformance vectors - **toolchain ready (Go 1.26.8 on the host, private repo created); nothing else started**
4. **C** calibration gate: 30 rugged vs 30 not, numbers into the weights table above
5. **M4** Solana adapter (needs a user-supplied RPC or data API key)
6. **M5** agent chat and tools (with the red-team suite above)
7. **M6** backtest report UI

Done earlier: M0 design and concentration, M1a PnL, M1b risk, M1c smart money, M2 storage, ReplayAdapter, ingest, CLI,
M3a service layer, M3b Electron main, preload and security, M3c-1 formatting, M3c-2 first presentational components,
M3c-3 the screens, W-1 the MSI pipeline on Windows CI.

## Open questions

- **Licence** (legal): Apache-2.0 recommended. Needed before the first release and before the SignPath application.
- **SignPath vs a closed sidecar:** open-source the engine, or ask SignPath, or sign another way (see above).
- **Calibration data:** needs real labelled history. Either a public dataset of rugged Solana tokens, or an RPC/indexer
  key for a one-off collection script (outside the app; the adapter is M4).
- **"Not in Electron's process tree":** reading above, please confirm.
- **Update policy default** for the engine: ask before installing (chosen), or install silently.
- Chain: Solana first. EVM later, through another adapter.
- LLM: any OpenAI-compatible endpoint; the user configures it.

## The screens (M3c)

Three screens behind a left rail: **Feed** (token table plus a detail panel for the selected token), **Smart money**
(ranked wallets with a window choice of 24 hours, 7 days, 30 days or all data) and **Wallet** (opened by clicking any
wallet address; totals plus a positions table). The look is a dark instrument panel. Rules the design follows:
- **Dashed means "not measured".** An unmeasured risk signal is drawn as an empty dashed bar, the "unknown" level badge is
  dashed, and the score gauge draws no score at all when the level is unknown. Missing data is never drawn as a safe zero.
- **Two rings on the gauge:** the thick ring is the score, the thin outer ring is how much of the total weight was measured.
- **The risk bar** has one bar per signal: width is its weight, height is how worrying it is.
- **Colour is never the only signal.** Every level is also a word, gains and losses carry + and -.
- **Everything on screen is text the user can select;** nothing in the SVG is text. No inline style and no script, so it
  runs under the strict CSP.
- Structure: `controller.ts` (what to ask for; every outcome becomes a value, nothing throws), `model.ts` (bar geometry,
  gauge arc, smart-money window), `views.tsx`, `lens.tsx`, `screens.tsx` (presentational, tested with hand-computed
  values), `App.tsx` (state only, glue, not unit tested).
- Tooling for looking at it, none of it shipped: `scripts/smoke-desktop.sh` (real app, 14 checks), `scripts/shots-desktop.sh`
  (real app, one PNG per screen listed in `scripts/shots-steps.json`), `scripts/preview-build.ts` (the built renderer with
  the real handler's answers, for browser inspection tools).

## Status (12 Nov 2026)

Public repo: https://github.com/rendowblock-jpg/memelens, `main` pushed at b4b58a8; an unauthenticated API call returned
`private: false`. Before the push the full history was scanned: no keys, tokens, key files or Solana-key-shaped strings.
One old commit (5adebe4) contains a test-run output file with absolute build-host paths (not secrets); it was left in
place rather than rewrite history. No licence file yet, so by default nobody may reuse the code (see Open questions).
No sidecar repo exists yet.

Measured on the host after the Windows packaging work: `vitest run` 697 tests in 26 files, exit 0; `tsc --noEmit` exit 0 for `packages/core`,
`packages/data`, `packages/service`, `apps/desktop` and the renderer project; real-app smoke 14/14, exit 0.
Browser-tool measurements of the built renderer (through the preview harness, not the Electron window): 1360x860 for the
feed, smart money and one wallet, and 900x600 (the app's minimum window) for the feed only. Not measured: the token panel
at 900x600 beyond the feed's own layout, the other wallets, 1024 wide, and anything in Arabic. Findings: no overflow,
cut-off text, overlap or covered controls; all text 12 px or larger; link targets 24 px; no contrast failures reported by
the audit runs I made (feed before the fixes, smart money and one wallet after).
Two layout bugs were found that way and fixed: the page grew to its content (1475 px in an 860 px window) because the
grid rows were not fixed, and headings skipped from h1 to h3.
**Not seen by a person yet.** I opened screenshots through the sandbox relay and received only a file description, not
pixels, so no statement here is about how the design *looks*; it is about measured numbers. The owner has not seen it.

Run the CLI: `npm run memelens -- ingest packages/data/fixtures/sample.json --db demo.sqlite`, then
`npm run memelens -- smart --db demo.sqlite`. Exit codes: 0 done, 1 could not be done, 2 command written wrongly,
3 ingested but items were rejected.

Known gaps (not hidden):
- Everything is verified on synthetic data. Nothing has touched real chain data.
- Risk weights and thresholds are provisional (see calibration). Only 6 of 10 signals have a data source.
- Run on Windows only by CI (see "Windows first"); the owner has not seen it. No sidecar, no Solana adapter, no agent chat.
- The app has no way to load data yet: a user with an empty database sees instructions to run the command line. The live
  adapter (M4) is what fixes that.
- No keyboard navigation inside the feed beyond tabbing to each row's button.
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
