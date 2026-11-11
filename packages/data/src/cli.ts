import { existsSync, readFileSync } from "node:fs";
import { smartMoney, tokenConcentration, tokenRisk, walletPnl } from "./analyze";
import { parseArgs, parseTime, UsageError, type ParsedArgs } from "./args";
import { ingest } from "./ingest";
import { FixtureError, ReplayAdapter, parseFixture } from "./replay";
import { renderConcentration, renderPnl, renderRisk, renderSmart, fmtIso } from "./render";
import { Store } from "./store";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** Exit codes. 2 is for how the command was written, 1 for a command that was fine but could not be done. */
export const EXIT = { ok: 0, failed: 1, usage: 2, rejects: 3 } as const;

/** The command was written correctly but could not be carried out (missing file, unknown token, ...). */
class Failure extends Error {}

const USAGE = `usage: memelens <command> [options]

commands:
  ingest <fixture.json>     load a recorded fixture into the database
  status                    show what the database holds, per chain
  pnl <wallet>              per-address profit and loss
  concentration <token>     holder concentration
  risk <token>              risk score, with the reasons
  smart                     smart-money ranking

options:
  --db <path>        database file (default: memelens.sqlite)
  --chain <id>       which chain; needed only if the database holds several
  --at <time>        analyse as of this time (default: the newest data in the database)
  --from <time>      smart: start of the window (default: the beginning of time)
  --min-closed <n>   smart: closed tokens needed to be ranked (default: 5)
  --json             print JSON instead of text (amounts are strings, never rounded)
  -h, --help         show this help

times: unix milliseconds (1700000000000), ISO-8601 with Z or an offset (2023-11-14T22:13:20Z),
  or a date (2023-11-14, midnight UTC). A time of day without an offset is refused.

exit codes: 0 done, 1 could not be done, 2 command written wrongly, 3 ingested but some items were rejected
`;

/** Which options each command accepts. Anything else is refused, not ignored. */
const ALLOWED: Record<string, readonly string[]> = {
  ingest: ["db"],
  status: ["db"],
  pnl: ["db", "chain", "at"],
  concentration: ["db", "chain", "at"],
  risk: ["db", "chain", "at"],
  smart: ["db", "chain", "at", "from", "min-closed"],
};

/** How many positional arguments each command takes, and what to call them in messages. */
const POSITIONALS: Record<string, string | null> = {
  ingest: "fixture file",
  status: null,
  pnl: "wallet address",
  concentration: "token address",
  risk: "token address",
  smart: null,
};

function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function openDb(path: string, mustExist: boolean): Store {
  if (mustExist && !existsSync(path)) {
    throw new Failure(`database not found: ${path} (create it with: memelens ingest <fixture.json> --db ${path})`);
  }
  try {
    return Store.open(path);
  } catch (e) {
    throw new Failure(`cannot open database ${path}: ${describe(e)}`);
  }
}

function pickChain(store: Store, wanted: string | undefined): string {
  const chains = store.chains();
  if (wanted !== undefined) {
    if (!chains.includes(wanted)) {
      throw new Failure(`no data for chain "${wanted}" (chains in this database: ${chains.length > 0 ? chains.join(", ") : "none"})`);
    }
    return wanted;
  }
  if (chains.length === 0) throw new Failure("the database has no data; load some with: memelens ingest <fixture.json>");
  if (chains.length > 1) throw new UsageError(`the database holds several chains (${chains.join(", ")}); choose one with --chain`);
  return chains[0]!;
}

function optTime(args: ParsedArgs, name: string): number | undefined {
  const raw = args.options[name];
  if (raw === undefined) return undefined;
  try {
    return parseTime(raw);
  } catch (e) {
    throw new UsageError(`--${name}: ${describe(e)}`);
  }
}

function minClosed(args: ParsedArgs): number | undefined {
  const raw = args.options["min-closed"];
  if (raw === undefined) return undefined;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`--min-closed must be a whole number of at least 1, got "${raw}"`);
  return n;
}

function finish(io: CliIo, args: ParsedArgs, data: unknown, text: string): number {
  io.out(args.json ? toJson(data) : text);
  return EXIT.ok;
}

// --------------------------------------------------------------------------------------------- commands

async function cmdIngest(args: ParsedArgs, io: CliIo): Promise<number> {
  const file = args.positionals[0]!;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Failure(`cannot read ${file}: ${describe(e)}`);
  }
  let data;
  try {
    data = parseFixture(JSON.parse(text));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Failure(`${file} is not valid JSON: ${e.message}`);
    if (e instanceof FixtureError) throw new Failure(`${file}: ${e.message}`);
    throw e;
  }
  const dbPath = args.options["db"] ?? "memelens.sqlite";
  const store = openDb(dbPath, false);
  try {
    const report = await ingest(store, new ReplayAdapter(data));
    const rejected = Object.values(report.rejectReasons).reduce((a, b) => a + b, 0);
    const row = (label: string, r: Record<string, number>): string =>
      `${label.padEnd(10)}${Object.entries(r)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`;
    const lines = [
      `loaded ${file} into ${dbPath}`,
      `chain     ${report.chain}`,
      row("tokens", report.tokens),
      row("trades", report.trades),
      row("snapshots", report.snapshots),
    ];
    if (rejected > 0) {
      lines.push(`${rejected} item(s) rejected and kept in the reject table:`);
      for (const [reason, n] of Object.entries(report.rejectReasons)) lines.push(`  ${reason}: ${n}`);
    }
    io.out(args.json ? toJson({ db: dbPath, fixture: file, report }) : lines.join("\n") + "\n");
    return rejected > 0 ? EXIT.rejects : EXIT.ok;
  } finally {
    store.close();
  }
}

function cmdStatus(args: ParsedArgs, io: CliIo): number {
  const dbPath = args.options["db"] ?? "memelens.sqlite";
  const store = openDb(dbPath, true);
  try {
    const chains = store.chains().map((chain) => {
      const rejectReasons: Record<string, number> = {};
      for (const r of store.rejects(chain)) rejectReasons[r.reason] = (rejectReasons[r.reason] ?? 0) + 1;
      const latestTime = store.latestTime(chain);
      return {
        chain,
        counts: store.counts(chain),
        latestTime,
        latestTimeIso: latestTime === null ? null : fmtIso(latestTime),
        rejectReasons,
      };
    });
    const data = { db: dbPath, schemaVersion: store.schemaVersion(), chains };
    const lines = [`database ${dbPath} (schema version ${data.schemaVersion})`];
    if (chains.length === 0) lines.push("no data yet");
    for (const c of chains) {
      lines.push(
        "",
        `chain ${c.chain}`,
        `  tokens ${c.counts.tokens}, trades ${c.counts.trades}, snapshots ${c.counts.snapshots}, rejects ${c.counts.rejects}`,
        `  newest data ${c.latestTimeIso ?? "none"}`,
      );
      for (const [reason, n] of Object.entries(c.rejectReasons)) lines.push(`  rejected: ${reason} x${n}`);
    }
    return finish(io, args, data, lines.join("\n") + "\n");
  } finally {
    store.close();
  }
}

/** Opens the database for reading and works out the chain and the as-of time. */
function withAnalysis(args: ParsedArgs, atOverride: number | undefined, fn: (store: Store, chain: string, asOf: number) => number): number {
  const store = openDb(args.options["db"] ?? "memelens.sqlite", true);
  try {
    const chain = pickChain(store, args.options["chain"]);
    const asOf = atOverride ?? store.latestTime(chain)!;
    return fn(store, chain, asOf);
  } finally {
    store.close();
  }
}

function notFound(token: string, asOf: number): Failure {
  return new Failure(
    `no result for ${token} as of ${fmtIso(asOf)}: the token is unknown, was created after that time, or has no holder snapshot at or before it`,
  );
}

const COMMANDS: Record<string, (args: ParsedArgs, io: CliIo) => number | Promise<number>> = {
  ingest: cmdIngest,
  status: cmdStatus,

  pnl: (args, io) =>
    withAnalysis(args, optTime(args, "at"), (store, chain, asOf) => {
      const wallet = args.positionals[0]!;
      const report = walletPnl(store, chain, wallet, { asOf });
      return finish(io, args, { chain, wallet, asOf, report }, renderPnl(wallet, chain, asOf, report));
    }),

  concentration: (args, io) =>
    withAnalysis(args, optTime(args, "at"), (store, chain, asOf) => {
      const token = args.positionals[0]!;
      const r = tokenConcentration(store, chain, token, asOf);
      if (r === null) throw notFound(token, asOf);
      return finish(io, args, { chain, ...r }, renderConcentration(token, chain, asOf, r.snapshotTime, r.snapshotAgeMs, r.concentration));
    }),

  risk: (args, io) =>
    withAnalysis(args, optTime(args, "at"), (store, chain, asOf) => {
      const token = args.positionals[0]!;
      const r = tokenRisk(store, chain, token, asOf);
      if (r === null) throw new Failure(`no result for ${token} as of ${fmtIso(asOf)}: the token is unknown or was created after that time`);
      return finish(io, args, { chain, ...r }, renderRisk(token, chain, asOf, r.snapshotTime, r.report, r.unavailable));
    }),

  smart: (args, io) => {
    const from = optTime(args, "from") ?? 0;
    const min = minClosed(args);
    const at = optTime(args, "at");
    if (at !== undefined && from > at) throw new UsageError("--from must not be after --at");
    return withAnalysis(args, at, (store, chain, to) => {
      if (from > to) throw new UsageError("--from must not be after the as-of time (the newest data in the database)");
      const minClosedTokens = min ?? 5;
      const report = smartMoney(store, chain, { from, to, minClosedTokens });
      return finish(io, args, { chain, from, to, minClosedTokens, report }, renderSmart(chain, from, to, minClosedTokens, report));
    });
  },
};

// --------------------------------------------------------------------------------------------- entry point

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help || args.command === "help") {
      io.out(USAGE);
      return EXIT.ok;
    }
    if (args.command === null) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const handler = COMMANDS[args.command];
    if (handler === undefined) throw new UsageError(`unknown command "${args.command}"`);

    for (const name of Object.keys(args.options)) {
      if (!ALLOWED[args.command]!.includes(name)) throw new UsageError(`--${name} is not used by "${args.command}"`);
    }
    const wanted = POSITIONALS[args.command];
    if (wanted !== null && args.positionals.length === 0) throw new UsageError(`"${args.command}" needs a ${wanted}`);
    const max = wanted === null ? 0 : 1;
    if (args.positionals.length > max) {
      throw new UsageError(`"${args.command}" takes ${max === 0 ? "no arguments" : "one argument"}, got ${args.positionals.length}`);
    }
    return await handler(args, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\n(see: memelens --help)\n`);
      return EXIT.usage;
    }
    if (e instanceof Failure) {
      io.err(`error: ${e.message}\n`);
      return EXIT.failed;
    }
    io.err(`internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return EXIT.failed;
  }
}
