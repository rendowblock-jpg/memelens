# MemeLens sidecar protocol, version 1

The sidecar is a separate program (the backtest engine) that the app starts and talks to over its standard input and
output. This document is the contract between the two. It lives in the public repository; the engine's source lives in a
private one. The contract is enforced by the tests in `packages/sidecar` (the app side) and by the conformance vectors in
`packages/sidecar/vectors` (both sides). If this text and the vectors disagree, the vectors are wrong or this text is, and
the disagreement is a bug to fix, never a thing to work around.

Words in capitals (MUST, MUST NOT, MAY) are used in their usual sense.

## 1. Transport

- The app starts the engine as a child process. The engine's standard input is its only way to receive messages and its
  standard output is its only way to send them. Standard error is for human-readable log lines and carries no protocol.
- One message is one line: a single JSON object, UTF-8, ended by `\n` (a `\r\n` is accepted when reading). Blank lines are
  ignored. A message MUST NOT contain a raw line break; JSON escapes inside strings take care of that.
- A line (without its `\n`) MUST NOT be longer than 16 MiB (16,777,216 bytes). A reader that meets a longer line stops
  trusting the stream: the app stops the engine.
- Every message is a JSON-RPC 2.0 object (`"jsonrpc": "2.0"`). Batches (JSON arrays) are not used and are refused.
  - Request (app to engine): `id` (a whole number the app chooses, never reused in one session), `method`, optional `params`.
  - Success reply: the same `id` and `result`.
  - Error reply: the same `id` and `error` = `{ code, message, data? }`.
  - Notification (engine to app): `method` and `params`, no `id`. The engine MUST NOT send requests; the app does not answer them.
- The engine MUST exit when its standard input is closed, so an app that crashed cannot leave an engine running.
- The engine MUST NOT write anything but protocol lines to standard output, and MUST NOT read anything but protocol lines
  from standard input.
- The engine MUST NOT use the network, and MUST NOT write to the database it reads. (Whether the operating system enforces
  the first is not decided; see docs/DESIGN.md. Until a test shows it, it is a promise about the code.)

## 2. Numbers

- All amounts of tokens and of the quote asset are whole numbers written as **decimal strings** of digits: `"0"` or a
  digit 1-9 followed by digits. No sign, no leading zero, no spaces, no exponent. A profit or loss (`pnl`, `realised`)
  MAY have one leading `-` (never `-0`).
- Times are whole numbers of milliseconds since 1970 (JSON numbers, 0 up to 2^53 - 1).
- Basis points (`Bps`) are whole numbers; 10,000 bps is 100%.
- The engine MUST compute with exact integers wide enough for the data (the app's tests use values near 10^30).
- Division of amounts truncates toward zero (the result of integer division in JavaScript `BigInt` and Go `big.Int.Quo`,
  not floor division). It matters only when a value is negative.

## 3. Canonical JSON and the spec hash

A spec is identified by `specHash`: the SHA-256, as 64 lower-case hexadecimal digits, of the **canonical JSON** text of
the spec encoded in UTF-8. Canonical JSON:

1. No whitespace between tokens.
2. Object members are written in order of their keys compared **byte by byte in UTF-8** (not UTF-16 code units: the key
   U+FF5E sorts before U+10000). Array order is kept.
3. Numbers are integers in the safe range (-(2^53 - 1) to 2^53 - 1), written in decimal without a plus sign, leading zero
   or exponent; `-0` is written `0`. Any other number is an error.
4. Strings are written in double quotes. Only these are escaped: `"` as `\"`, `\` as `\\`, backspace `\b`, tab `\t`,
   line feed `\n`, form feed `\f`, carriage return `\r`, and every other character below U+0020 as `\u00xx` with
   **lower-case** hexadecimal. Everything else is written as it is, including DEL (U+007F), `<`, `>`, `&`, U+2028, U+2029
   and all non-ASCII characters. A lone surrogate is an error.
5. `true`, `false`, `null` as they are. `undefined`, functions, symbols and big integers have no form (error).

The vectors `canonical.json` hold the exact text and hash for ten values and five refusals.

## 4. Methods

### 4.1 `hello`

The first message the app sends. `params`: `{ "client": { "name": text, "version": text }, "protocols": [whole numbers] }`.
The engine answers `{ "protocol": n, "engineVersion": text, "capabilities": [text] }`, where `n` is one of the offered
protocols (this document is protocol 1). `engineVersion` is the version of the engine (a semantic version). The app
refuses an engine whose protocol it does not support and stops it. Capabilities this version knows:

- `backtest.run` - the engine can run backtests (4.3, 4.4).
- `pnl.compute` - the engine can compute FIFO profit and loss (4.2).

An engine MUST answer `hello` before anything else and MUST NOT offer a capability it does not implement.

### 4.2 `pnl.compute`

`params`: `{ "trades": [...], "asOf"?: time, "marks"?: [...] }`.

- A trade: `{ "id": text, "time": time, "token": text, "side": "buy" | "sell", "amount": decimal string >= 1, "quote": decimal string >= 0, "fee"?: decimal string >= 0 }` (extra members are ignored). One call is one wallet's trades in one quote asset.
- A mark: `{ "token": text, "amount": decimal string >= 1, "quote": decimal string >= 0 }` - "`amount` units are worth `quote`".
  At most one mark per token.
- Invalid input (a bad field, an empty id, a duplicate trade id, two marks for one token) is an error, `-32602`, **even if
  the offending trade is after `asOf`**.

The result `{ "tokens": [...], "totals": {...} }` is exactly what `packages/core` `computePnl` returns with every amount
written as a decimal string (and `unrealised: null` where the engine reports it as null). The rules, in order:

1. Only trades with `time <= asOf` are used (all of them if `asOf` is absent). They are ordered by `time`, then by `id`
   compared by UTF-8 bytes.
2. A buy of `amount` for `quote` and `fee` adds a lot (`amount`, cost = `quote + fee`).
3. A sell has net proceeds `net = quote - fee`. It takes from the oldest lots first. Taking part of a lot costs
   `cost * take / lot.amount` (integer division, truncating toward zero) and leaves the remainder in the lot. Taking a
   whole lot costs the lot's remaining cost.
4. If the lots run out, the part of the sell that found no lot is **unmatched**: of `net`, `matchedProceeds` is `net` when the sell was fully matched, and otherwise
   `net * matched / amount` (truncating); the rest of `net` is unmatched proceeds and the unmatched amount is
   `amount - matched`. Unmatched proceeds are never part of `realised`.
5. Per token: `realised = realisedProceeds - realisedCost`. `openAmount` and `openCost` are what is left in the lots.
   `unrealised` is `0` if `openAmount` is `0`; otherwise `null` if the token has no mark, else
   `openAmount * mark.quote / mark.amount - openCost` (truncating).
6. Tokens are listed sorted by the bytes of their address. `totals.realised`, `totals.unmatchedProceeds` are sums over
   tokens; `totals.unrealised` is the sum over tokens whose `unrealised` is not null; `totals.unmarkedTokens` lists the
   tokens whose `unrealised` is null, in the same order.

The vectors `pnl.json` hold 27 cases (nine of them invalid inputs) written by an implementation that shares no code with
either side.

### 4.3 `backtest.run`

`params`: `{ "spec": Spec, "data": Data }`. The engine MUST check the spec again, with the same rules as the app, and answer
`-32602` with the path of the first wrong field (`"data": { "path": "$.strategy.stopLossBps" }`) if it is wrong.

**Spec** (every member is required; no other member is allowed; this is also the object that is hashed):

| Member | Type and range |
|---|---|
| `version` | the number `1` |
| `from`, `to` | times, `from <= to`, `to - from <= 5 * 366 * 86,400,000` ms |
| `strategy.kind` | the text `"follow-wallets"` |
| `strategy.wallets` | 1 to 100 distinct texts of 1 to 128 printable ASCII characters (U+0021 to U+007E) |
| `strategy.latencyMs` | whole number, 0 to 86,400,000 |
| `strategy.positionQuote` | decimal string of 1 to 39 digits, no leading zero (the quote asset spent per position) |
| `strategy.takeProfitBps` | `null` or a whole number 1 to 1,000,000 |
| `strategy.stopLossBps` | `null` or a whole number 1 to 9,999 |
| `strategy.maxHoldMs` | whole number, 1 to 2,592,000,000 (30 days) |
| `costs.feeBps` | whole number 0 to 1,000 |
| `costs.slippageBps` | whole number 0 to 5,000 |

**Data** is one of:

- `{ "source": "inline", "trades": [Trade + { "wallet": text }] }` - the trades travel in the request (used by tests).
- `{ "source": "sqlite", "path": absolute path, "chain": text }` - the engine opens the app's database itself, **read only**,
  and reads the trades of that chain. The path is chosen by the app's main process and never comes from the agent or the
  user. See 5.

The app and the engine both treat trades with `time < from` or `time > to` as nonexistent. **A backtest MUST NOT read
anything dated after `to`** - the vectors include a trade after `to` that would have triggered an exit.

**The strategy** (this is the whole definition; `backtest.json` has 19 cases and the 57 invalid specs):

1. Take the trades with `from <= time <= to`, ordered by `time` then `id` (bytes). Group them by `token`.
2. In a token's list, a **signal** is a trade whose wallet is in `wallets`, whose side is `buy` and whose `quote > 0`.
3. Walk the signals in order. A signal at index `i` is **ignored while open** if a position in this token is still open at
   that moment: it is ignored when `i <= blocked`, where `blocked` is the index of the trade at which the previous position
   in this token exited (initially `-1`).
4. Otherwise the **entry** is the first trade after the signal in the list (a later index) with `time >= signal.time +
   latencyMs` and `quote > 0`. If there is none, the signal is skipped as `noPrice`.
5. The entry price is that trade's `quote / amount`. The position buys `entryAmount = positionQuote * trade.amount * 10000
   / (trade.quote * (10000 + slippageBps))` units (integer division). If that is 0, the signal is skipped as `tooSmall`.
   `buyFee = positionQuote * feeBps / 10000` and `cost = positionQuote + buyFee`.
6. From the trade after the entry trade, look at each trade with `quote > 0` in order and take the **first** that meets a
   condition. Conditions are tested in this order for each trade, and the first true one decides the reason:
   `stopLoss` (when `stopLossBps` is not null): `q * entry.amount * 10000 <= entry.quote * a * (10000 - stopLossBps)`;
   `takeProfit` (when not null): `q * entry.amount * 10000 >= entry.quote * a * (10000 + takeProfitBps)`;
   `maxHold`: `trade.time - entry.time >= maxHoldMs`; where `q` and `a` are the trade's `quote` and `amount`. A trade with
   `quote = 0` is skipped (a transfer has no price).
7. If no trade meets a condition, the position exits at the **last** trade in the window with `quote > 0` (at or after the
   entry trade), reason `end`. The exit trade is the entry trade itself if nothing later has a price.
8. `proceeds = entryAmount * exit.quote * (10000 - slippageBps) / (exit.amount * 10000)` (integer division),
   `sellFee = proceeds * feeBps / 10000`, `net = proceeds - sellFee`, `pnl = net - cost`.
9. The exit index becomes `blocked` for this token. Positions of all tokens are listed sorted by `entryTime`, then by
   `entryTradeId` (bytes).

**Result** (the report):

```
{ "engineVersion": text, "specHash": 64 hex, "dataAsOf": time or null,
  "positions": [ { "token", "signalTradeId", "signalWallet", "entryTradeId", "entryTime", "entryAmount", "buyFee", "cost",
                   "exitTradeId", "exitTime", "exitReason": "takeProfit"|"stopLoss"|"maxHold"|"end",
                   "proceeds", "sellFee", "net", "pnl" } ],
  "summary": { "signals", "ignoredWhileOpen", "skipped": { "noPrice", "tooSmall" }, "entered",
               "exits": { "takeProfit", "stopLoss", "maxHold", "end" }, "wins", "losses",
               "totalCost", "totalNet", "realised", "roiBps" } }
```

- `dataAsOf` is the latest `time` among the trades used (inside the window), or `null` if there were none.
- `signals = ignoredWhileOpen + skipped.noPrice + skipped.tooSmall + entered`; `entered` is the number of positions;
  `exits` counts positions by reason; `wins` / `losses` count positions with `pnl > 0` / `pnl < 0` (break-even is neither).
- `totalCost` and `totalNet` are sums over positions, `realised = totalNet - totalCost`, and `roiBps = realised * 10000 /
  totalCost` truncated toward zero, or `null` when `totalCost` is `0`.
- **Determinism:** the same spec and the same data MUST give a byte-identical report apart from `engineVersion`. The engine
  uses no random numbers and no clock.
- The app refuses a report that is not of exactly this shape, whose summary is not the sum of its positions, whose
  `specHash` is not the hash of the spec it sent, or whose `engineVersion` differs from the one in `hello`.

While running, the engine MAY send `backtest.progress` notifications, `params = { "id": the request id, "done": n, "total": n }`.

### 4.4 `backtest.cancel`

`params`: `{ "id": the id of a running request }`. The engine answers this request with `{ "cancelled": true }` (or
`false` if that request is not running) and answers the cancelled request with the error code `-32001`, message
`"cancelled"`. If a cancelled run has not answered within 5 seconds, the app stops the engine.

### 4.5 `shutdown`

The engine answers `null` and exits promptly (code 0). The app waits 2 seconds, then stops the engine.

## 5. Reading the database

The engine opens the file named in `data.path` with SQLite's **read-only** flag and never writes to it, never creates a
journal beside it, and never changes a setting of it. The app writes to the same file with its own connection in write-ahead
mode, so the engine reads a consistent snapshot while the app keeps ingesting. The tables it may read are those of the
app's schema version 1 (`trade`: chain, id, token, wallet, time, side, amount, quote, fee; amounts are stored as decimal
text). If `PRAGMA user_version` is not `1`, the engine answers an error and does nothing else.

## 6. Errors

| Code | Meaning |
|---|---|
| `-32700` | the line was not valid JSON (the reply has `id: null`) |
| `-32600` | not a valid request |
| `-32601` | unknown method |
| `-32602` | invalid parameters; `data.path` names the first wrong field |
| `-32001` | cancelled |
| `-32002` | the data cannot be read (cannot open, wrong schema version) |
| `-32003` | the engine ran out of its memory budget |

The app treats any other reply as a protocol error. A run of 20 invalid lines, a line over the limit, an answer to an id it
did not ask, a protocol it does not support, or a report that fails its checks makes the app stop the engine and report the
reason; the user's data is never changed by any of this.

## 7. Updates and compatibility

- The protocol has its own major number (`hello.protocol`); the engine has its own version. They change independently of
  the app's version. A new engine that only adds capabilities keeps `protocol: 1`.
- The engine is installed under `<root>/versions/<version>/` with a `manifest.json`, chosen by `current.json`, with one step
  of rollback in `previous.json` (see `packages/sidecar/src/layout.ts`). The app checks the binary against its manifest
  (name, size, SHA-256) **before every launch**.
- A release is a manifest and a binary. The manifest is signed with ed25519; the app holds the public key and checks the
  signature before it installs anything (`verifyManifestSignature`). The download client is not built yet.
