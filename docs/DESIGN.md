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
- **Draft release `v0.1.0-preview.1`** (id 442707219) holds `MemeLens-0.1.0-x64.msi` (126,603,264 bytes, SHA-256
  `4ACB7D07D1C86F18CE8F3B668B2224C0783D8046B2DE27E41AE5B6A8E490C2BF`), built from commit `40bfcf49915387fd617fac4c20147f659f379866`
  (run 43258934566, a live-engine run) and swapped in on 12 Nov 2026, after the first-run sample button and the release host
  existed: the file before it (asset 739882611, the `8aab0fc` build) had neither. The new file was uploaded under a temporary
  name; GitHub's digest and size were compared with the build log's hash and the host's own hash (all three equal), and only then
  was the old file deleted and the new one renamed (asset 740226250). It is a draft and a pre-release: with no credentials the
  release answers 404, so only repository admins see it. The notes say what was seen (a Windows runner only: install, first
  start with the sample button, engine download and install from the release host, a backtest, uninstall; 5 + 24 checks and 26
  smoke checks, 1,337 unit tests passed), that it is unsigned, and what is unmeasured (a real PC, speed and memory on Windows,
  an upgrade over an older version). Nothing was installed anywhere but on the build runner.
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
  one app version, and the app does not install or use a sidecar yet.
- **The package job waits for the test job** (`needs: test`, added 12 Nov), so a red test cannot produce an MSI.
- **No code signing**, no auto-update, no macOS or Linux packaging.

## Repos, licence and signing

- **Public app repo** (https://github.com/rendowblock-jpg/memelens, created and pushed 12 Nov 2026): everything in this tree, the protocol document, the test
  vectors, CI, and the *public* key that verifies sidecar releases. Nothing secret, ever. Before the first push the
  tracked tree and the full history are scanned.
- **Private sidecar repo** (https://github.com/rendowblock-jpg/memelens-sidecar, created 12 Nov 2026): the Go source
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

### Calibration protocol (gate before M4 - collection started, nothing scored)

Score 30 tokens that rugged against 30 that did not, and report the hit rate for each group.
- **Labels fixed before scoring.** The definition of "rugged" is written down and committed before any score is
  looked at. The exact definitions are in "Calibration collection" below, committed before the first token was
  collected. "Did not rug": same venue and launch window, still trading after 30 days, picked at random, not by hand.
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

### Calibration collection (13 Nov 2026): prospective, not retrospective

**Why prospective.** Measured 12-13 Nov from the build host with no key: the Foundation RPC allows about 1 call a second
and answers HTTP 429 beyond that; `getTokenLargestAccounts` ("who holds this token") is refused with 429 on that endpoint
at any spacing, and on every other free endpoint tried (PublicNode, dRPC, Ankr, OnFinality: key or paid plan; BlockPI:
bad certificate). Holders as they were at launch + 1 hour cannot be asked of any node afterwards, and rebuilding them from
transactions costs thousands of calls per token. So the tokens are watched from the moment they appear, and each one is
read at launch + 1 hour. This also removes look-ahead by construction: nothing about a token is read before the scoring
time that was not true at that time. It costs calendar time: the first numbers come about 33 days after collection starts.

**Sources, all keyless, all read from the build host (outside the app; the app's adapter is M4):**
- *GeckoTerminal* `new_pools`: discovery (token address, pool address, name, `pool_created_at`), and OHLCV candles
  (minute candles for the first hour, hourly candles afterwards) and the token's pools (liquidity) for outcomes.
  Its public limit is 30 calls a minute; the collector stays under 12.
- *RugCheck* `/v1/tokens/{mint}/report`: top holders (up to 20, with owner), total holder count, supply, creator, the
  creator's balance, mint and freeze authority, the markets (curve and vault addresses). Checked 13 Nov on a young
  pump.fun token and on an established one with 2,467 holders (20 listed). Its own `rugged` flag and score are stored
  for audit and **never used** as an input or a label.
- Population: tokens whose first GeckoTerminal pool is on `pump-fun` (the bonding curve). Tokens GeckoTerminal never
  lists (no trade yet) cannot enter; that is a stated limit, and the numbers apply to pump.fun launches only.

**Sampling.** A launch is followed if `sha256("memelens-calibration-v1:" + mint)`, read as a fraction of 2^32, is
below 0.1. The rule depends only on the address, so it cannot prefer tokens by outcome. A launch first seen more than
30 minutes after its pool was created is recorded but not followed (the +60 minute reading could not be on time); the
count of those is reported. GeckoTerminal's newest-pools page is polled every 20 seconds (a page covers about 45
seconds; page 2 is read too when no launch on page 1 was known before). Measured 13 Nov 2026: about 15 pump.fun
launches appear per minute, so about 1.5 are followed per minute, about 6,500 in 72 hours. Discovery runs for 72 hours
from the first poll; every followed token is then tracked to launch + 30 days. Missed polls and missed windows are
counted and reported, not hidden.

**Schedule per followed token** (t0 = `pool_created_at`): at +60 min (window +60 to +75 min) the report and the minute
candles of the first hour; at +72 h the report, the token's pools and the hourly candles; at +30 d the same again.
The scoring time S is the moment the +60 min report was fetched.

**Definitions, fixed before the first token is collected.** The price path is the hourly (and, up to S, minute) USD
candles of the token's pool with the most volume in each period; "peak" is the running maximum of the candle highs.
- *Already collapsed:* at S the price is at most 10% of the highest price before S. Excluded from both groups,
  counted and reported. (A score taken after the collapse would be scoring the aftermath.)
- *Rugged:* not already collapsed, and between S and +72 h some candle low is at most 10% of the running peak, and the
  price at +72 h is at most 25% of that peak (no recovery), and it is not the case that the creator held tokens at +60 min
  and still held more than 90% of them at +72 h (a creator who sat through the fall is an ordinary failure, not a rug).
  A creator with no balance at +60 min cannot be shown to have held, so the collapse alone decides. What this measures
  is a collapse the creator did not sit through; "rugged" is the protocol's word for it.
- *Survived:* no candle low at or below 10% of the running peak at any time in 30 days, and at +30 d some pool has
  at least USD 1,000 volume over its last 24 hourly candles and at least USD 1,000 liquidity.
- *Neither:* everything else (faded, collapsed after 72 h, too little data). Counted, never silently dropped.
- Thresholds (90%, 25%, 72 h, 30 d, USD 1,000) are fixed here and not tuned afterwards.

**The 60.** After the last token has reached +30 d: take the Rugged and Survived tokens, order each group by
`sha256("memelens-calibration-v1:pick:" + mint)`, and take the first 30 of each. If a group has fewer than 30, report
that count and the groups as they are. Nothing is picked by hand.

**Scoring input at S (also fixed before data).** Holdings: the listed top holders, summed by owner. Not holders and
excluded from the counted supply: the curve and pool vaults (RugCheck `markets` and its AMM and locker accounts) and
"protocol wallets": an owner that is the largest holder in at least 25% of all collected tokens (computed over every
token collected, with no outcome used). One such wallet was seen on 13 Nov holding 46-53% of every 2-billion-supply
token. The unlisted remainder (supply minus excluded minus listed) is spread evenly over the unlisted holders (total
count minus listed minus excluded), so the top-10 share is exact and the HHI is a lower bound. Creator share, mint and
freeze authority come from the same report; age is S minus t0. Only five signals can vary at S; coverage is 57 of 100.

**Scoring input, as built and measured (13 Nov 2026, 10:3xZ; written before any +72 h outcome exists).** The rules above were
turned into `packages/collector/src/export.ts` and checked against a second implementation in Python
(`test/reference/export_reference.py`) on six real RugCheck reports (five young pump.fun tokens and one graduated token).
What the real reports showed, which changes or sharpens the text above:
- *The curve is a holder row, sometimes.* RugCheck lists the bonding curve as a holder (the owner is the market's address)
  when it ranks in the top 20, and leaves it out otherwise. A curve that is not listed is not in `totalHolders` either.
  So the unlisted tail is `totalHolders - rows listed`, and "excluded" is not subtracted again.
- *The curve's balance is known even when unlisted:* the market's vault balance plus pump.fun's unsold reserve, 206,900,000
  tokens (1,000,000,000 minus the 793,100,000 sold on the curve). Where the curve is listed, its row equals that sum to the
  token on 6 of 6 reports. A graduated pool (`pump_fun_amm`) has no reserve. A market of any other type, or without a vault of
  this token, makes the report `unmodelled`.
- *Protocol wallets:* the largest counted holder is taken after removing markets, known AMMs and lockers (the curve is often
  the biggest row, which would hide the wallet). On the six reports the wallet `BwWK17cb...` was largest in 2 of 6; with the
  curve and that wallet removed, a 2-billion-token launch has nobody left to score, which the risk code reports as unknown
  (never as safe). The census is used only over at least 100 readable reports; below that it is skipped and said so.
- *`creatorBalance` is not used:* it read 0 where the creator was listed holding 5.0%. The creator's share is the creator's
  listed row over the counted supply. A creator that is not listed is "holds nothing" only when every holder is listed;
  with unlisted holders it is not named at all (the signal is then unavailable), never read as zero.
- *Quality of each snapshot, printed next to every result:* `exact` (every token accounted for, every holder listed),
  `estimated` (unlisted holders share what is left), `unattributed` (more than 0.1% of the supply is in no field and nobody
  is left to hold it: it is given to nobody), `inconsistent` (rows exceed the supply by more than 0.1%), `unmodelled`.
  **Fixed before outcomes: every collected token is scored whatever its quality, and each result is reported for all tokens and
  again for `exact` + `estimated` only.** Nothing is dropped after seeing a label.
- `pct` in a report is a share of the whole supply, the supply can exceed what a JSON number holds exactly for tokens of
  other decimals; such a report is refused (`ReportError`), counted and listed, never rounded.

**Limits to print next to any number:** (1) pump.fun only; (2) a top-20 list, HHI is a lower bound; (3) the creator's
earlier dumps, liquidity, clustering and wash trading are not scored, so this measures the five-signal model; (4) price
path resolution is one hour after S, so a collapse and recovery inside one hour is invisible; (5) RugCheck and
GeckoTerminal are third parties and can be wrong or change; their raw replies are kept; (6) with 30 per group the
intervals are wide (see above); (7) if the weights are changed after this, the numbers are in-sample.

## Sidecar: state on 12 Nov 2026

- **Contract:** `docs/SIDECAR-PROTOCOL.md`. **Vectors:** `packages/sidecar/vectors/*.json`, written by `scripts/sidecar-vectors/gen.py`, a Python implementation that shares no code with either side: 27 PnL cases (9 invalid inputs), 19 backtest cases, 57 invalid specs, 15 canonical-JSON cases. The TypeScript core agrees with every PnL vector.
- **App side, `packages/sidecar`:** line codec, canonical JSON and spec hash, spec and report checkers (the report's summary must equal the sum of its positions), install layout with atomic pointers, verify-before-launch and rollback, ed25519 manifest check with a small-order-key guard, process client with timeouts, protocol-error limits, cancellation and a minimal environment for the engine.
- **Update path (new, `trust.ts`, `fetch.ts`, `updater.ts`):** `checkForUpdate` reads the latest signed manifest and offers it; `installUpdate` runs in this order: signature (before the manifest is parsed), parse, no downgrade, download with the signed size as the limit, size and SHA-256, place in `versions/<v>`, verify from disk, run the new engine's `hello` and compare its version with the manifest's, and only then make it current. Any failure removes what it placed. The same version counts as up to date only if the installed copy is intact **and** its manifest is byte-for-byte the signed one; otherwise it is offered again, which repairs it. Downloads go only to listed hosts, over https, with every redirect hop checked, no credentials in addresses, a byte limit, and a deadline that covers the body. The network code is a function of the main process; the renderer's CSP is unchanged.
- **Engine, private repo `memelens-sidecar` (Go 1.26.8):** `hello`, `pnl.compute`, `backtest.run`, `backtest.cancel`, `shutdown`; reads the app's SQLite file read-only. Release tool `memelens-release` (`keygen`, `publish`) writes the layout the updater reads and checks what it wrote.
- **Signing key (changed 12 Nov, later):** the app trusts one key, the release pipeline's (`trust.ts`: `3meG0F38M2TSrHKv2t8EjE1PfOnNzbSbuJJYKlzS3mM`). Its private half was generated on the build host, sealed straight into the private engine repository as the Actions secret `ENGINE_SIGNING_KEY`, and shredded from the host; no private key file was found on the host afterwards. The old development key is no longer trusted (a test fails if it comes back). The list holds several keys so a key can still be replaced without a flag day. Lost secret: publish an app that trusts a new key as well, then sign with it. The development key's private half still sits in `/root/projects/tools/keys` and is trusted by nothing.
- **Seen, Linux (this host):** the whole chain on real binaries, 14 of 14 (the Go tool signs, a local server serves, the updater checks, installs and starts the real engine and a vector runs through it; a flipped byte, a wrong key and a manifest that lies about the version are each refused and leave nothing installed). `vitest` 1063 passed, 14 skipped (the skipped ones need the real binaries), `typecheck:all` exit 0, desktop smoke 15 of 15.
- **Seen, Windows CI:** the contract test against the real engine, 10 of 10 (private repo run 43195999636). The chain test (14 of 14) on Windows: see the run noted in the status section below.
- **Mutation checks:** codec/canonical 38 of 38. Spec/report 57 of 58. Layout/signature **52 of 61** (re-run after the fail-closed test; was 51; the 9 survivors are marked equivalent by reading the code, not by proof). Update path: fetch 25 of 26, updater 34 of 37, trust 3 of 4; every survivor is marked equivalent with its reason in the list file. Go release tool 36 of 39 (survivors: a folder given as the binary still fails later; two read-back checks that only a fault-injection test could trip). Equivalent-by-reading is a claim, not a result.
- **Found by running them:** my own "endless body" test used a stream that never ended, so with the size check removed it grew to 4.4 GB and the kernel killed the job. Test streams are now bounded and the mutation runs execute inside a memory-capped scope.
- **Wired into the app (12 Nov, later):** ten channels reach the window: the five data channels and `engineStatus`, `engineRun`, `engineCancel`, `engineCheck`, `engineInstall`. `SidecarManager` runs in the main process and the app chooses the database path; the window can name a strategy and a chain, nothing else (an extra field such as `path` is refused). Errors reach the window as fixed sentences and the original text goes to the log. An install stops an idle engine first and is refused while a backtest runs. `MEMELENS_SIDECAR_DIR` moves the engine folder (absolute, no `..`; a bad value makes the engine unavailable, the app still starts). With no release host configured the window is told so. Seen: Linux smoke 20 of 20; manager mutation list 68 of 74 (the 6 survivors marked equivalent by reading). Not seen: the engine channels on Windows beyond unit tests; no mutation run yet on `engine.ts` or `engine-api.ts`.
- **Backtest screen (12 Nov, later):** a third place in the rail (Feed, Smart money, Backtest; Wallet appears only while a wallet is open). The form is plain text; `backtest.ts` turns it into the engine's spec without floating point (amounts and percentages are read as digits, more decimals than the unit has is an error, never rounded) and gives a message for every wrong field at once. The engine panel shows the installed version, "No engine is installed" with the reason the Run button is off, and Check for update / Install when the build has a release source (it has none yet). The result leads with the signed result and the return on cost, says it is a replay and not a forecast, and says "No trade was entered" instead of showing zeros. The screen stays mounted when you leave the tab, so a running backtest is not lost. Seen on this host: renderer tests (form 52, views 34, controller 26), packaged Linux app 15 of 15 including the Backtest screen, smoke 23 of 23, and the form -> real handler -> manager -> real Go engine -> view chain 4 of 4 (`backtest.e2e.test.tsx`, run by the private pipeline). Mutation checks: `engine-api.ts` 38 of 41, `engine.ts` 88 of 89, `backtest.ts` 110 of 112 (every survivor marked equivalent with its reason, by reading). Not seen: the screen on Windows, and by a person.
- **Memory budget and oversize replies (12 Nov, later):** the engine now takes `-memory-mb` (default 512, range 1 to 65536) and measures the live Go heap. Loading the trades gets half of it, the run the whole; over the limit it first collects garbage and refuses only if the data itself is still over, with `-32003` and a message in MiB. A reply longer than a line may be (16 MiB) is replaced by a `-32003` that fits. Before this, an engine given 70,000 positions wrote a 19,228,215-byte line and the app's client reported a protocol error and stopped a healthy engine (seen against the previous binary); now the client gets `remote -32003` and the same engine answers the next request (seen against the new binary, both on this host). Measured: 447 bytes per trade once loaded, and a run adds about 0.93 times that on top (sampled, so a lower bound; a test fails if it passes 2.0). Limits of the claim: the budget counts the Go heap only. Measured on Linux (Go 1.26.8, the real engine reading app-shaped databases, peak process memory from `VmHWM` against the peak heap in the engine's own GC trace): 100,000 trades peaked at 87 MB of process memory for a 71 MB heap, 300,000 at 233 MB for 209 MB, and 600,000 (a 147 MB database file) at 471 MB for 408 MB, so the process took 1.11 to 1.23 times the heap, 16 to 63 MB more. The SQLite driver's own allocations are therefore small next to the heap. Not measured: Windows (no `VmHWM` there), and anything past 600,000 trades. With the default budget of 512 MiB the process can be expected to peak a little above 512 MiB, which matters on a PC with about 1.8 GB free. Mutation list `scripts/mutations/budget.json` in the private repo: **63 of 64 caught**; the one survivor (the context check inside the load loop) is equivalent by reading, because `database/sql` closes the rows when the context ends. The first run said 53 of 64 and that number was inflated: two of my own tests were flaky (they sent two requests before reading either reply, and failed in 53 and 23 of 300 local runs), so some mutants were "caught" by accident. The same flake turned private run 43238493723 red on Linux and Windows. After the fix (send, read, then send) the tests pass 400 of 400 runs and private run 43240965128 is green. **Seen on Windows CI** (run 43240965128, `34d3151`): Go tests on Windows and Linux, and the Windows contract job 25 of 25, including the memory-budget refusal and the oversize reply answered with `-32003` and no protocol error.
- **Release host (12 Nov, later):** public repository `rendowblock-jpg/memelens-engine` (signed binaries and manifests only; the source stays private), served from `raw.githubusercontent.com`. The app's address is `ENGINE_RELEASE` in `apps/desktop/src/main/engine-release.ts` (one host on the allow list). The private repository's workflow "Publish engine" (started by hand, with a version) runs the tests, reads the keys the pinned app trusts, builds Windows and Linux engines, refuses to sign with a key the app does not trust (`memelens-release -trusted-keys`), signs, pushes through a write deploy key held as a second secret, and then on Windows and Linux makes the app's own updater find, verify, install, start and use what was published (`engine-release.live.test.ts`). **Seen:** run 43245207352 published 0.1.0 (win32-x64 sha256 `811de6d1...`, linux-x64 `3f339922...`) and both verify jobs passed (Windows 1 test, 878 ms; Linux 1 test, 1,171 ms; the test is skipped without `MEMELENS_LIVE_VERSION`, and the logs show it set). The files were fetched without credentials and have a 64-byte signature. Host rehearsal with a throwaway key: reproducible (publishing the same version twice leaves the tree byte-identical), an untrusted key leaves no folder, a flipped signature byte is refused as `signature`. **Seen on Linux against the real host** (the packaged app, `check-packaged.mjs --live-engine`, 21 of 21): Check for update offered engine 0.1.1, Install put it in place, the screen showed 'Engine 0.1.1 is installed', and a backtest on the app's database entered 5 positions. **Windows, installed MSI, same path: seen.** Run 43250135345 (started by hand with `live_engine`, commit `eda84e6`): the installed app was offered engine 0.1.2, installed it from the release host, showed 'Engine 0.1.2 is installed · idle', and a backtest on its database entered 5 positions; PACKAGED OK: 22/22 checks passed, but that run pointed the app at a temporary engine folder (MEMELENS_SIDECAR_DIR). Run 43253217380 (commit `4adab15`) repeated it with the app choosing its own per-user folder: the engine went to `%LOCALAPPDATA%\MemeLens\sidecar`, `current.json` named 0.1.2, the backtest entered 5 positions, PACKAGED OK 24/24, and a new step then found the engine still there after `msiexec /x` with the SHA-256 its manifest names. The installer in the draft release still predates the release address and cannot fetch. **Toolchain and vulnerability scan (this replaces an earlier, misleading paragraph):** 0.1.0 was built with Go 1.26.0 (the version `go.mod` names), 0.1.1 with 1.26.8 and 0.1.2 with 1.26.11, the newest 1.26 patch at the time. The publish workflow now writes the Go version out and runs `govulncheck` in source mode before any secret is read (0.1.2: no vulnerabilities found). The earlier text said a binary-mode scan reported 47 findings for 0.1.0 against 14 for a 1.26.8 build. As a measure of risk that was wrong: the binary we publish is stripped and has no symbols, so a scan of it reports every standard-library flaw whether or not the code can reach it. On a 1.26.8 build of the same source, source mode reports 0 affected, and binary mode on an unstripped build reports 0 affected. `net/http`, `crypto/tls`, `crypto/x509` and `html/template` are not in the engine's dependency graph. Versions 0.1.0, 0.1.1 and 0.1.2 each passed the Windows and Linux verify jobs (private runs 43245207352, 43247027177, 43248580488). A 0.1.1 build made on this host with the pipeline's flags is bit-identical to the published one on both platforms. `raw.githubusercontent.com` caches files for 300 seconds; a watcher that fetched the manifest and its signature as a pair saw each switch to a new version, and every pair it printed was valid. A published version is never changed.
- **First-run sample (12 Nov, later):** a copy of MemeLens with no data used to show a command that only works from a source checkout. It now shows "No data yet", says no real-data adapter exists and that the sample is made up, and offers "Load the sample data". The button calls one new channel, `loadSample` (11 channels now). It takes no payload, loads the sample bundled inside the app (the same file the command line loads) and only when the database holds no chain at all; a second click while loading, and a second load afterwards, are refused. Tests first, each red for the right reason. Mutation lists: `desktop-sample.json` 19 of 20 (the survivor, rejected trades not counted in the "sample had rejected items" check, is equivalent by reading: each of the 8 rules in `validateTrade` is also enforced, with the same predicate, by `parseFixture`, so a parsed trade is never rejected by the validator (I tried four ways to build such a trade and the parser refused all four); not examined for tokens), `service-sample-api.json` 17 of 18 (survivor equivalent by reading), `renderer-empty.json` 9 of 9. Seen on Linux: the packaged app started with no database shows "No data yet", the button fills it, the feed shows the sample, a second load is refused (`--first-run`, 5 of 5); the ordinary packaged check still 16 of 16. Windows: a `First run` step was added to the package job (installed MSI, database path left to the app); its result is not read yet.
- **Not built:** choosing wallets from the smart-money ranking (the Backtest screen takes addresses typed or pasted), enforcing a limit on the SQLite driver's own memory, operating-system enforcement of "no network", code signing.

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
3. **S** sidecar: the slot (manager, protocol, versioned folder, update check) and the Go backtest engine, with conformance vectors - **engine, contract test, signed update path and release tool built and tested; wired into the Electron main process behind ten IPC channels; Backtest screen built, not yet seen on Windows or by the owner**
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
- **Calibration data:** decided 13 Nov 2026: a prospective collector (see "Calibration collection"). The retrospective
  route was measured and rejected: Foundation RPC about 1 call a second with HTTP 429 beyond it, `getTokenLargestAccounts`
  refused on every free endpoint, holders at a past moment not queryable. SolRPDS (CC BY 4.0, pool-level, 2021-2024)
  labels by inactivity, not by this definition, and has no holders at launch + 1 hour. A probe mistake, recorded so it
  is not repeated: the first cost probe took the USDC mint for a memecoin (the filter "Instruction: Create" also
  matches `CreateIdempotent`); the second crashed on a token without a first balance (a pump.fun create without a
  dev buy has no `postTokenBalances`). A third-party key (Helius, Birdeye) would give a second holder source; not
  taken, because opening an account is the owner's call.
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
- **State audit (13 Nov 2026):** `scripts/audit-states.mjs` (with `scripts/audit-shell.cjs`, an empty Electron window with
  a DevTools port, never packaged) serves the preview build and measures, in a real Chromium, 10 screen states (feed,
  first run, token panel, smart money, wallet, Backtest with no engine / ready / problem / result / failed run) at 1366x728,
  900x600 and 1920x1040, in normal, forced-colors, more-contrast and reduced-motion modes: axe-core (WCAG 2.2 A/AA and
  best practice), 24x24 px targets, sideways scroll, text running out of its box, one `<h1>` and one `<main>`, a visible edge on
  every control and a non-colour mark on the selected item in forced colors, no animation under reduced motion. Run it
  with `xvfb-run -a node scripts/audit-states.mjs` after `scripts/preview-build.ts`. Result on Linux: 120 combinations,
  870 of 870 checks. It found one real bug (the wallet's positions table 24 px wider than its panel at 900x600; fixed,
  with a test) and two false alarms in its own first version. Forced-colors is Chromium's emulation, not real Windows
  High Contrast, and has not been rendered on a Windows desktop. The Windows runner runs the same axe and 24 px
  checks on the installed app (run 43399748516 on `b8e133d`: 29 of 29 and 9 of 9, 0 violations on 6 screens).
- **Looking at the UI (13 Nov 2026):** pixels reach the agent only through the sandbox route (`audit/tools/eyes`: sealed
  proof, then tag -> decode -> `read_file`); proven 6/6 on 13 Nov (S59A). A picture is for structure, weight and
  overlap; fractions, sizes, counts and words come from `scripts/probe-page.mjs` (real Chromium, real mouse and keys) and
  `scripts/audit-states.mjs`. First looks and their checking are in `docs/ui-readings/`: 14 claims from the eye, 9 right or
  close, 3 wrong in a detail, 1 an artifact of the preview's scripted start. Findings so far: a finished backtest sits
  306px below the fold with nothing to announce it.
- **The uninstall stall (13 Nov):** in three runs (43218046784, 43222454513, 43267334943) the Uninstall step began and never
  ended until the job limit cancelled it, although `msiexec /x` takes about 2 s and the step's own time limits (3 and 6
  minutes) never fired; so the runner itself stopped answering, not `msiexec`. Run 43399748516 uninstalled in 1.2 s. Cause
  unknown, probably the runner. Mitigation: the MSI, pictures and install log are uploaded before the uninstall, and the
  job limit is 25 minutes.

## Status (12 Nov 2026)

Public repo: https://github.com/rendowblock-jpg/memelens, `main` pushed at b4b58a8; an unauthenticated API call returned
`private: false`. Before the push the full history was scanned: no keys, tokens, key files or Solana-key-shaped strings.
One old commit (5adebe4) contains a test-run output file with absolute build-host paths (not secrets); it was left in
place rather than rewrite history. No licence file yet, so by default nobody may reuse the code (see Open questions).
The private sidecar repo now exists (see "Sidecar: state").

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
- Run on Windows only by CI (see "Windows first"); the owner has not seen it. The sidecar engine exists but is not wired into the app yet; no Solana adapter, no agent chat.
- A fresh install has no data. With an empty database the app offers a button that loads the bundled made-up sample (only into a completely empty database, never added to existing data). There is still no real-data adapter, so a fresh install can show only synthetic data until M4.
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
