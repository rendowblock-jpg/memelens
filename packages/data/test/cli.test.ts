import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli";
import { Store } from "../src/store";

// Every expected number below was worked out by hand from fixtures/sample.json, not read from the code:
//   tokens TOK1..TOK5 are created at T0 + i hours.
//   alice buys 1000 for 1,000,000 and sells 1000 for 2,000,000 on every token   -> +1,000,000 each, +5,000,000 in all
//   bob   buys 1000 for 1,000,000 and sells 1000 for   500,000 on every token   ->   -500,000 each, -2,500,000 in all
//   carol trades TOK1 (+100,000) and TOK2 (-100,000)                            ->  0 in all, 2 closed tokens
//   dave  buys 500 of TOK5 for 500,000 and holds; the last non-zero trade on TOK5 is bob's sell (1000 for 500,000)
//   TOK5 holders at +45min: POOL 8000 (excluded), creator5 1000, dave 500, x1 300, x2 200
const SAMPLE = fileURLToPath(new URL("../fixtures/sample.json", import.meta.url));
const T0 = 1_700_000_000_000;
const H = 3_600_000;
const M = 60_000;
const base = (i: number): number => T0 + i * H;
const LATEST = base(5) + 45 * M;

interface Result {
  code: number;
  out: string;
  err: string;
}

async function cli(...argv: string[]): Promise<Result> {
  let out = "";
  let err = "";
  const code = await run(argv, {
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
  });
  return { code, out, err };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(...argv: string[]): Promise<any> {
  const r = await cli(...argv, "--json");
  expect(r.err, `stderr of ${argv.join(" ")}`).toBe("");
  expect(r.code, `exit code of ${argv.join(" ")}`).toBe(0);
  return JSON.parse(r.out);
}

let captured = "";
let dir: string;
let db: string;
beforeEach(() => {
  captured = "";
  dir = mkdtempSync(join(tmpdir(), "memelens-cli-"));
  db = join(dir, "t.sqlite");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function load(): Promise<void> {
  const r = await cli("ingest", SAMPLE, "--db", db);
  expect(r.code).toBe(0);
}

describe("usage and help", () => {
  it("prints usage to stderr and exits 2 when there is no command", async () => {
    const r = await cli();
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^usage:/);
  });

  it("prints help to stdout and exits 0", async () => {
    for (const flag of ["--help", "-h"]) {
      const r = await cli(flag);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      for (const word of ["ingest", "status", "pnl", "concentration", "risk", "smart", "--db", "--at", "--json"]) {
        expect(r.out).toContain(word);
      }
    }
  });

  it("explains the exit codes in the help", async () => {
    const r = await cli("help");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/exit codes/i);
  });

  it("exits 2 for an unknown command, naming it", async () => {
    const r = await cli("frobnicate");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command");
    expect(r.err).toContain("frobnicate");
  });

  it("exits 2 for a bad option, naming it", async () => {
    const r = await cli("status", "--nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--nope");
    expect(r.out).toBe("");
  });

  it("exits 2 when a positional is missing or extra", async () => {
    expect((await cli("ingest")).code).toBe(2);
    expect((await cli("pnl")).code).toBe(2);
    expect((await cli("risk")).code).toBe(2);
    expect((await cli("concentration")).code).toBe(2);
    expect((await cli("pnl", "a", "b")).code).toBe(2);
    expect((await cli("status", "extra")).code).toBe(2);
    expect((await cli("smart", "extra")).code).toBe(2);
  });

  it("exits 2 for a bad --at, --from or --min-closed, naming the option", async () => {
    await load();
    const badAt = await cli("pnl", "alice", "--db", db, "--at", "2023-02-30");
    expect(badAt.code).toBe(2);
    expect(badAt.err).toContain("--at");
    const badFrom = await cli("smart", "--db", db, "--from", "yesterday");
    expect(badFrom.code).toBe(2);
    expect(badFrom.err).toContain("--from");
    for (const v of ["0", "-1", "2.5", "x", "1e3"]) {
      const r = await cli("smart", "--db", db, "--min-closed", v);
      expect(r.code, v).toBe(2);
      expect(r.err).toContain("--min-closed");
    }
  });

  it("refuses every option a command does not use, instead of ignoring it", async () => {
    await load();
    // The spec, stated independently of the code: which of these options each command takes (--db and --json: all).
    const takes: Record<string, string[]> = {
      ingest: [],
      status: [],
      pnl: ["chain", "at"],
      concentration: ["chain", "at"],
      risk: ["chain", "at"],
      smart: ["chain", "at", "from", "min-closed"],
    };
    const positional: Record<string, string[]> = {
      ingest: [SAMPLE],
      status: [],
      pnl: ["alice"],
      concentration: ["TOK5"],
      risk: ["TOK5"],
      smart: [],
    };
    const sample: Record<string, string> = { chain: "synthetic", at: "5", from: "5", "min-closed": "2" };
    let refused = 0;
    for (const [command, allowed] of Object.entries(takes)) {
      for (const option of Object.keys(sample)) {
        const argv = [command, ...positional[command]!, `--${option}`, sample[option]!, "--db", db];
        const r = await cli(...argv);
        if (allowed.includes(option)) {
          expect(r.err, argv.join(" ")).not.toContain("is not used by");
        } else {
          expect(r.code, argv.join(" ")).toBe(2);
          expect(r.err, argv.join(" ")).toContain(`--${option} is not used by "${command}"`);
          refused++;
        }
      }
    }
    expect(refused).toBe(4 + 4 + 2 + 2 + 2 + 0); // ingest 4, status 4, pnl 2, concentration 2, risk 2 ("from", "min-closed"), smart 0
  });

  it("checks the arguments before it touches the database", async () => {
    for (const argv of [["pnl"], ["smart", "--min-closed", "0"], ["risk", "T", "--at", "2023-02-30"], ["status", "--at", "1"]]) {
      const r = await cli(...argv, "--db", db);
      expect(r.code, argv.join(" ")).toBe(2);
    }
    expect(existsSync(db)).toBe(false);
  });

  it("exits 2 when --from is after the as-of time", async () => {
    await load();
    const r = await cli("smart", "--db", db, "--from", "100", "--at", "50");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--from");
  });
});

describe("ingest", () => {
  it("loads the sample fixture and reports what it wrote", async () => {
    const o = await json("ingest", SAMPLE, "--db", db);
    expect(o.report.chain).toBe("synthetic");
    expect(o.report.tokens).toMatchObject({ received: 5, inserted: 5, rejected: 0 });
    expect(o.report.trades).toMatchObject({ received: 25, inserted: 25, duplicates: 0, rejected: 0 });
    expect(o.report.snapshots).toMatchObject({ received: 3, inserted: 3, duplicates: 0, rejected: 0 });
    expect(existsSync(db)).toBe(true);
  });

  it("is safe to repeat: the second run writes nothing", async () => {
    await load();
    const o = await json("ingest", SAMPLE, "--db", db);
    expect(o.report.trades).toMatchObject({ received: 25, inserted: 0, duplicates: 25 });
    expect(o.report.tokens).toMatchObject({ inserted: 0, unchanged: 5 });
  });

  it("prints a readable summary without --json", async () => {
    const r = await cli("ingest", SAMPLE, "--db", db);
    expect(r.code).toBe(0);
    expect(r.out).toContain("synthetic");
    expect(r.out).toMatch(/trades\s+received 25, inserted 25/);
  });

  it("exits 3 when an item was rejected, and says why", async () => {
    await load();
    const changed = JSON.parse(readFileSync(SAMPLE, "utf8"));
    changed.trades.find((t: { id: string }) => t.id === "a-buy-1").amount = "999";
    const other = join(dir, "changed.json");
    writeFileSync(other, JSON.stringify(changed));
    const r = await cli("ingest", other, "--db", db, "--json");
    expect(r.code).toBe(3);
    const o = JSON.parse(r.out);
    expect(o.report.trades.rejected).toBe(1);
    expect(o.report.rejectReasons).toEqual({ "id-conflict": 1 });
    const human = await cli("ingest", other, "--db", db);
    expect(human.code).toBe(3);
    expect(human.out).toContain("id-conflict");
  });

  it("also counts a conflicting holder snapshot as a rejected item", async () => {
    await load();
    const changed = JSON.parse(readFileSync(SAMPLE, "utf8"));
    changed.snapshots.find((s: { token: string }) => s.token === "TOK1").holdings[0].amount = "1";
    const other = join(dir, "changed-snap.json");
    writeFileSync(other, JSON.stringify(changed));
    const r = await cli("ingest", other, "--db", db, "--json");
    expect(r.code).toBe(3);
    const o = JSON.parse(r.out);
    expect(o.report.snapshots.rejected).toBe(1);
    expect(o.report.trades.rejected).toBe(0);
    expect(o.report.rejectReasons).toEqual({ "id-conflict": 1 });
  });

  it("does not overwrite the stored trade when the id conflicts", async () => {
    await load();
    const changed = JSON.parse(readFileSync(SAMPLE, "utf8"));
    changed.trades.find((t: { id: string }) => t.id === "a-buy-1").amount = "999";
    const other = join(dir, "changed.json");
    writeFileSync(other, JSON.stringify(changed));
    await cli("ingest", other, "--db", db);
    const o = await json("pnl", "alice", "--db", db);
    expect(o.report.totals.realised).toBe("5000000");
  });

  it("exits 1 for a missing fixture and does not create the database", async () => {
    const r = await cli("ingest", join(dir, "nope.json"), "--db", db);
    expect(r.code).toBe(1);
    expect(r.err).toContain("nope.json");
    expect(existsSync(db)).toBe(false);
  });

  it("exits 1 for a file that is not JSON, naming the file", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    const r = await cli("ingest", bad, "--db", db);
    expect(r.code).toBe(1);
    expect(r.err).toContain("bad.json");
    expect(existsSync(db)).toBe(false);
  });

  it("exits 1 for a fixture that fails validation, with the path of the problem", async () => {
    const doc = JSON.parse(readFileSync(SAMPLE, "utf8"));
    doc.version = 2;
    const bad = join(dir, "v2.json");
    writeFileSync(bad, JSON.stringify(doc));
    const r = await cli("ingest", bad, "--db", db);
    expect(r.code).toBe(1);
    expect(r.err).toContain("v2.json");
    expect(r.err).toContain("version");
    expect(existsSync(db)).toBe(false);
  });

  it("exits 1 when --db is a directory or not a database, with a clear message", async () => {
    const asDir = await cli("ingest", SAMPLE, "--db", dir);
    expect(asDir.code).toBe(1);
    expect(asDir.err).toContain("cannot open database");
    const garbage = join(dir, "garbage.sqlite");
    writeFileSync(garbage, "this is not a sqlite database, just text that is long enough to look like a file".repeat(20));
    const bad = await cli("status", "--db", garbage);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("cannot open database");
    expect(bad.err).toContain(garbage);
  });
});

describe("unexpected failures", () => {
  it("are reported as an internal error with exit 1, never a crash", async () => {
    const code = await run(["--help"], {
      out: () => {
        throw new Error("boom");
      },
      err: (s) => {
        captured += s;
      },
    });
    expect(code).toBe(1);
    expect(captured).toContain("internal error");
    expect(captured).toContain("boom");
  });
});

describe("status", () => {
  it("reports counts, the newest data time and reject reasons per chain", async () => {
    await load();
    const o = await json("status", "--db", db);
    expect(o.schemaVersion).toBe(1);
    expect(o.chains).toEqual([
      {
        chain: "synthetic",
        counts: { tokens: 5, trades: 25, snapshots: 3, rejects: 0 },
        latestTime: LATEST,
        latestTimeIso: new Date(LATEST).toISOString(),
        rejectReasons: {},
      },
    ]);
  });

  it("includes reject reasons after a conflicting ingest", async () => {
    await load();
    const changed = JSON.parse(readFileSync(SAMPLE, "utf8"));
    changed.trades.find((t: { id: string }) => t.id === "b-buy-2").quote = "1";
    const other = join(dir, "changed.json");
    writeFileSync(other, JSON.stringify(changed));
    await cli("ingest", other, "--db", db);
    const o = await json("status", "--db", db);
    expect(o.chains[0].counts.rejects).toBe(1);
    expect(o.chains[0].rejectReasons).toEqual({ "id-conflict": 1 });
  });

  it("keeps each chain's counts and reject reasons separate", async () => {
    await load();
    const copy = JSON.parse(readFileSync(SAMPLE, "utf8"));
    copy.chain = "other";
    copy.trades = copy.trades.slice(0, 4);
    copy.snapshots = [];
    const p = join(dir, "other.json");
    writeFileSync(p, JSON.stringify(copy));
    await cli("ingest", p, "--db", db);
    const changed = JSON.parse(readFileSync(SAMPLE, "utf8"));
    changed.trades.find((t: { id: string }) => t.id === "a-buy-1").amount = "999";
    const q = join(dir, "changed.json");
    writeFileSync(q, JSON.stringify(changed));
    await cli("ingest", q, "--db", db); // conflict on chain "synthetic" only
    const o = await json("status", "--db", db);
    const by = Object.fromEntries(o.chains.map((c: { chain: string }) => [c.chain, c]));
    expect(Object.keys(by).sort()).toEqual(["other", "synthetic"]);
    expect(by.synthetic.counts).toEqual({ tokens: 5, trades: 25, snapshots: 3, rejects: 1 });
    expect(by.synthetic.rejectReasons).toEqual({ "id-conflict": 1 });
    expect(by.other.counts).toEqual({ tokens: 5, trades: 4, snapshots: 0, rejects: 0 });
    expect(by.other.rejectReasons).toEqual({});
    expect(by.other.latestTime).toBe(base(5)); // newest of: TOK5 created at base(5), trades of the first 4 are earlier
  });

  it("prints a readable summary without --json", async () => {
    await load();
    const r = await cli("status", "--db", db);
    expect(r.code).toBe(0);
    expect(r.out).toContain("synthetic");
    expect(r.out).toContain(new Date(LATEST).toISOString());
  });

  it("exits 1 for a database that does not exist, and does not create it", async () => {
    const r = await cli("status", "--db", db);
    expect(r.code).toBe(1);
    expect(r.err).toContain("database not found");
    expect(r.err).toContain(db);
    expect(existsSync(db)).toBe(false);
  });

  it("says so when the database exists but holds nothing", async () => {
    Store.open(db).close();
    const o = await json("status", "--db", db);
    expect(o.chains).toEqual([]);
    const human = await cli("status", "--db", db);
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/no data/i);
  });
});

describe("chain selection", () => {
  it("uses the only chain in the database when --chain is not given", async () => {
    await load();
    expect((await json("pnl", "alice", "--db", db)).chain).toBe("synthetic");
  });

  it("exits 1 when --chain names a chain with no data, listing what exists", async () => {
    await load();
    const r = await cli("pnl", "alice", "--db", db, "--chain", "solana");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no data for chain");
    expect(r.err).toContain("solana");
    expect(r.err).toContain("synthetic");
  });

  it("exits 2 and lists the chains when there are several and none is chosen", async () => {
    await load();
    const copy = JSON.parse(readFileSync(SAMPLE, "utf8"));
    copy.chain = "other";
    const p = join(dir, "other.json");
    writeFileSync(p, JSON.stringify(copy));
    expect((await cli("ingest", p, "--db", db)).code).toBe(0);
    const r = await cli("pnl", "alice", "--db", db);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--chain");
    expect(r.err).toContain("other");
    expect(r.err).toContain("synthetic");
    const chosen = await json("pnl", "alice", "--db", db, "--chain", "other");
    expect(chosen.chain).toBe("other");
    expect(chosen.report.totals.realised).toBe("5000000");
  });

  it("exits 1 for an analysis on a database with no data", async () => {
    Store.open(db).close();
    const r = await cli("pnl", "alice", "--db", db);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no data/i);
  });

  it("exits 1 for an analysis on a database that does not exist, without creating it", async () => {
    for (const argv of [["pnl", "alice"], ["risk", "TOK1"], ["concentration", "TOK1"], ["smart"]]) {
      const r = await cli(...argv, "--db", db);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toContain("database not found");
    }
    expect(existsSync(db)).toBe(false);
  });
});

describe("pnl", () => {
  beforeEach(load);

  it("defaults the as-of time to the newest data and says so", async () => {
    const o = await json("pnl", "alice", "--db", db);
    expect(o.asOf).toBe(LATEST);
    expect(o.wallet).toBe("alice");
  });

  it("computes alice's realised PnL: +1,000,000 on each of five tokens", async () => {
    const o = await json("pnl", "alice", "--db", db);
    expect(o.report.totals.realised).toBe("5000000");
    expect(o.report.tokens.map((t: { token: string }) => t.token)).toEqual(["TOK1", "TOK2", "TOK3", "TOK4", "TOK5"]);
    for (const t of o.report.tokens) {
      expect(t.realised).toBe("1000000");
      expect(t.openAmount).toBe("0");
    }
  });

  it("computes bob's losses", async () => {
    const o = await json("pnl", "bob", "--db", db);
    expect(o.report.totals.realised).toBe("-2500000");
  });

  it("values dave's open position at the last non-zero trade, which is bob's low sell", async () => {
    const o = await json("pnl", "dave", "--db", db);
    expect(o.report.tokens).toHaveLength(1);
    const t = o.report.tokens[0];
    expect(t.token).toBe("TOK5");
    expect(t.openAmount).toBe("500");
    expect(t.openCost).toBe("500000");
    expect(t.unrealised).toBe("-250000");
    expect(o.report.totals.unrealised).toBe("-250000");
    expect(o.report.totals.unmarkedTokens).toEqual([]);
  });

  it("honours --at: alice has bought TOK1 but not yet sold it", async () => {
    const at = base(1) + 20 * M;
    const o = await json("pnl", "alice", "--db", db, "--at", String(at));
    expect(o.asOf).toBe(at);
    expect(o.report.tokens).toHaveLength(1);
    expect(o.report.tokens[0]).toMatchObject({ token: "TOK1", openAmount: "1000", openCost: "1000000", realised: "0" });
    expect(o.report.totals.realised).toBe("0");
  });

  it("takes --at as an ISO time too", async () => {
    const at = base(1) + 20 * M;
    const o = await json("pnl", "alice", "--db", db, "--at", new Date(at).toISOString());
    expect(o.asOf).toBe(at);
  });

  it("returns an empty report, exit 0, for a wallet that never traded", async () => {
    const o = await json("pnl", "nobody", "--db", db);
    expect(o.report.tokens).toEqual([]);
    expect(o.report.totals.realised).toBe("0");
    const human = await cli("pnl", "nobody", "--db", db);
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/no trades/i);
  });

  it("prints the as-of time, the wallet and the amounts with separators", async () => {
    const r = await cli("pnl", "alice", "--db", db);
    expect(r.code).toBe(0);
    expect(r.out).toContain("alice");
    expect(r.out).toContain(new Date(LATEST).toISOString());
    expect(r.out).toContain("5,000,000");
    const bob = await cli("pnl", "bob", "--db", db);
    expect(bob.out).toContain("-2,500,000");
  });

  it("warns that an open position's value rests on one trade", async () => {
    const r = await cli("pnl", "dave", "--db", db);
    expect(r.out).toMatch(/last trade/i);
  });
});

describe("concentration", () => {
  beforeEach(load);

  it("uses the newest snapshot and leaves out the excluded pool", async () => {
    const o = await json("concentration", "TOK5", "--db", db);
    expect(o.token).toBe("TOK5");
    expect(o.asOf).toBe(LATEST);
    expect(o.snapshotTime).toBe(LATEST);
    expect(o.snapshotAgeMs).toBe(0);
    expect(o.concentration.holders).toBe(4);
    expect(o.concentration.total).toBe("2000");
    expect(o.concentration.topShare["1"]).toBe(0.5);
    expect(o.concentration.hhi).toBeCloseTo(0.345, 9); // .5^2 + .25^2 + .15^2 + .1^2
  });

  it("picks the older snapshot when --at is before the newer one, and reports its age", async () => {
    const at = base(5) + 10 * M;
    const o = await json("concentration", "TOK5", "--db", db, "--at", String(at));
    expect(o.snapshotTime).toBe(base(5) + 5 * M);
    expect(o.snapshotAgeMs).toBe(5 * M);
    expect(o.concentration.holders).toBe(1);
    expect(o.concentration.total).toBe("1000");
    expect(o.concentration.topShare["1"]).toBe(1);
  });

  it("exits 1 when there is no snapshot yet at the as-of time", async () => {
    const r = await cli("concentration", "TOK5", "--db", db, "--at", String(base(5) + 2 * M));
    expect(r.code).toBe(1);
    expect(r.err).toContain("TOK5");
    expect(r.out).toBe("");
  });

  it("exits 1 for an unknown token", async () => {
    const r = await cli("concentration", "TOK9", "--db", db);
    expect(r.code).toBe(1);
    expect(r.err).toContain("TOK9");
  });

  it("prints the snapshot age so stale numbers are visible", async () => {
    const at = base(5) + 10 * M;
    const r = await cli("concentration", "TOK5", "--db", db, "--at", String(at));
    expect(r.out).toMatch(/snapshot/i);
    expect(r.out).toContain(new Date(base(5) + 5 * M).toISOString());
  });
});

describe("risk", () => {
  beforeEach(load);

  it("flags TOK5: an active mint authority forces the level to high or worse", async () => {
    const o = await json("risk", "TOK5", "--db", db);
    expect(o.token).toBe("TOK5");
    expect(o.report.hardFlags).toContain("mintAuthority");
    expect(["high", "critical"]).toContain(o.report.level);
    expect(o.input.creatorShare).toBe(0.5);
    expect(o.input.ageMs).toBe(45 * M); // LATEST is 45 minutes after TOK5 was created
    expect(o.snapshotTime).toBe(LATEST);
  });

  it("says why each missing signal is missing", async () => {
    const o = await json("risk", "TOK5", "--db", db);
    expect(Object.keys(o.unavailable).sort()).toEqual(["clustering", "creatorDumps", "liquidity", "washTrading"]);
    expect(o.unavailable.liquidity).toBe("no liquidity data yet");
  });

  it("treats unknown authority flags as unknown, not as safe (TOK1)", async () => {
    const o = await json("risk", "TOK1", "--db", db);
    expect(o.unavailable.mintAuthority).toMatch(/not known/);
    expect(o.unavailable.freezeAuthority).toMatch(/not known/);
    expect(o.input).not.toHaveProperty("mintAuthorityActive");
    expect(o.report.hardFlags).toEqual([]);
    expect(o.report.coverage).toBeLessThan(1);
  });

  it("scores TOK1's creator share as 0: the creator holds nothing in the snapshot", async () => {
    const o = await json("risk", "TOK1", "--db", db);
    expect(o.input.creatorShare).toBe(0);
  });

  it("exits 1 for an unknown token, and for a token that does not exist yet at --at", async () => {
    const a = await cli("risk", "TOK9", "--db", db);
    expect(a.code).toBe(1);
    const b = await cli("risk", "TOK5", "--db", db, "--at", String(base(5) - 1));
    expect(b.code).toBe(1);
    expect(b.err).toContain("TOK5");
  });

  it("prints the level, the coverage and the unavailable signals in plain words", async () => {
    const r = await cli("risk", "TOK5", "--db", db);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/level/i);
    expect(r.out).toMatch(/coverage/i);
    expect(r.out).toContain("mintAuthority");
    expect(r.out).toContain("no liquidity data yet");
    expect(r.out).toContain(new Date(LATEST).toISOString());
  });
});

describe("smart", () => {
  beforeEach(load);

  it("ranks alice first and explains everyone else", async () => {
    const o = await json("smart", "--db", db);
    expect(o.from).toBe(0);
    expect(o.to).toBe(LATEST);
    expect(o.minClosedTokens).toBe(5);
    expect(o.report.ranked).toHaveLength(1);
    expect(o.report.ranked[0]).toMatchObject({ address: "alice", rank: 1, realised: "5000000", closedTokens: 5, wins: 5 });
    expect(o.report.ranked[0].hitRateLow).toBeCloseTo(0.5655, 3);
    expect(o.report.unranked.map((w: { address: string; reason: string }) => [w.address, w.reason])).toEqual([
      ["bob", "not-profitable"],
      ["carol", "too-few-closed-tokens"],
      ["dave", "too-few-closed-tokens"],
    ]);
  });

  it("changes carol's reason when --min-closed is lowered: she closed 2 tokens and broke even", async () => {
    const o = await json("smart", "--db", db, "--min-closed", "2");
    expect(o.minClosedTokens).toBe(2);
    const reasons = Object.fromEntries(o.report.unranked.map((w: { address: string; reason: string }) => [w.address, w.reason]));
    expect(reasons).toEqual({ bob: "not-profitable", carol: "not-profitable", dave: "too-few-closed-tokens" });
  });

  it("scores only the window: from TOK3 on, alice closed 3 tokens for +3,000,000", async () => {
    const o = await json("smart", "--db", db, "--from", String(base(3)), "--min-closed", "3");
    expect(o.from).toBe(base(3));
    expect(o.report.ranked).toHaveLength(1);
    expect(o.report.ranked[0]).toMatchObject({ address: "alice", realised: "3000000", closedTokens: 3, wins: 3 });
    const strict = await json("smart", "--db", db, "--from", String(base(3)));
    expect(strict.report.ranked).toEqual([]);
    expect(strict.report.unranked.find((w: { address: string }) => w.address === "alice").reason).toBe("too-few-closed-tokens");
  });

  it("never looks past --at: with only TOK1..TOK2 finished, nobody has 5 closed tokens", async () => {
    const at = base(2) + 59 * M;
    const o = await json("smart", "--db", db, "--at", String(at));
    expect(o.to).toBe(at);
    expect(o.report.ranked).toEqual([]);
    const alice = o.report.unranked.find((w: { address: string }) => w.address === "alice");
    expect(alice).toMatchObject({ realised: "2000000", closedTokens: 2 });
  });

  it("accepts a window that is a single instant", async () => {
    const o = await json("smart", "--db", db, "--from", String(base(3)), "--at", String(base(3)));
    expect(o.from).toBe(base(3));
    expect(o.to).toBe(base(3));
  });

  it("prints a ranked table and the reasons without --json", async () => {
    const r = await cli("smart", "--db", db);
    expect(r.code).toBe(0);
    expect(r.out).toContain("alice");
    expect(r.out).toContain("5,000,000");
    expect(r.out).toContain("not-profitable");
    expect(r.out).toContain("too-few-closed-tokens");
    expect(r.out).toContain(new Date(LATEST).toISOString());
  });
});

describe("analysis commands are read-only", () => {
  it("leave the stored data unchanged", async () => {
    await load();
    const before = await json("status", "--db", db);
    await cli("pnl", "alice", "--db", db);
    await cli("risk", "TOK5", "--db", db);
    await cli("concentration", "TOK5", "--db", db);
    await cli("smart", "--db", db);
    const after = await json("status", "--db", db);
    expect(after).toEqual(before);
  });
});

describe("json output", () => {
  it("never prints a bigint as a number and always parses", async () => {
    await load();
    for (const argv of [["pnl", "alice"], ["risk", "TOK5"], ["concentration", "TOK5"], ["smart"], ["status"]]) {
      const r = await cli(...argv, "--db", db, "--json");
      expect(r.code, argv.join(" ")).toBe(0);
      expect(() => JSON.parse(r.out), argv.join(" ")).not.toThrow();
    }
    const big = JSON.parse((await cli("pnl", "alice", "--db", db, "--json")).out);
    expect(typeof big.report.totals.realised).toBe("string");
  });
});
