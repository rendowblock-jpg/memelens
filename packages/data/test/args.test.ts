import { describe, expect, it } from "vitest";
import { parseArgs, parseTime, UsageError } from "../src/args";

describe("parseTime: accepted forms", () => {
  it("takes unix milliseconds as digits", () => {
    expect(parseTime("1700000000000")).toBe(1_700_000_000_000);
    expect(parseTime("0")).toBe(0);
  });

  it("takes ISO-8601 with an explicit Z or offset", () => {
    expect(parseTime("2023-11-14T22:13:20Z")).toBe(1_700_000_000_000);
    expect(parseTime("2023-11-14T22:13:20.123Z")).toBe(1_700_000_000_123);
    expect(parseTime("2023-11-14T23:13:20+01:00")).toBe(1_700_000_000_000);
    expect(parseTime("2023-11-14T21:13:20-01:00")).toBe(1_700_000_000_000);
    expect(parseTime("2023-11-14T22:13Z")).toBe(1_700_000_000_000 - 20_000);
  });

  it("reads 1, 2 or 3 fraction digits as the fraction of a second they are", () => {
    expect(parseTime("2023-11-14T22:13:20.5Z")).toBe(1_700_000_000_500);
    expect(parseTime("2023-11-14T22:13:20.05Z")).toBe(1_700_000_000_050);
    expect(parseTime("2023-11-14T22:13:20.12Z")).toBe(1_700_000_000_120);
    expect(parseTime("2023-11-14T22:13:20.001Z")).toBe(1_700_000_000_001);
  });

  it("reads a date with no time as midnight UTC", () => {
    expect(parseTime("2023-11-14")).toBe(Date.UTC(2023, 10, 14));
  });

  it("accepts real leap days", () => {
    expect(parseTime("2024-02-29T00:00:00Z")).toBe(Date.UTC(2024, 1, 29));
    expect(parseTime("2000-02-29")).toBe(Date.UTC(2000, 1, 29));
  });
});

describe("parseTime: rejected forms", () => {
  const bad = [
    "",
    " ",
    "abc",
    "-5",
    "1.5",
    "1e12",
    "9007199254740993", // above Number.MAX_SAFE_INTEGER
    "2023-11-14T22:13:20", // time of day with no offset would silently mean local time
    "2023-11-14 22:13:20Z",
    "2023-02-30", // Date.parse would roll this over to 2 March
    "2023-02-29T00:00:00Z",
    "2100-02-29", // 2100 is not a leap year
    "2023-04-31",
    "2023-13-01",
    "2023-00-10",
    "2023-11-00",
    "2023-11-14T24:00:00Z",
    "2023-11-14T22:60:00Z",
    "2023-11-14T22:13:60Z",
    "2023-11-14T22:13:20+24:00",
    "2023-11-14T22:13:20+01:60",
    "1969-12-31T23:59:59Z", // before 1970: the store has no negative times
    "1970-01-01T00:00:00+01:00", // same instant is before 1970 once the offset is applied
  ];
  for (const text of bad) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(() => parseTime(text)).toThrow(UsageError);
    });
  }

  it("names the bad value in the message", () => {
    expect(() => parseTime("2023-02-30")).toThrow(/2023-02-30/);
  });
});

describe("parseArgs", () => {
  it("splits command, positionals and options", () => {
    const p = parseArgs(["pnl", "alice", "--db", "x.sqlite", "--at", "5"]);
    expect(p.command).toBe("pnl");
    expect(p.positionals).toEqual(["alice"]);
    expect(p.options).toEqual({ db: "x.sqlite", at: "5" });
    expect(p.json).toBe(false);
    expect(p.help).toBe(false);
  });

  it("accepts --name=value as well as --name value", () => {
    expect(parseArgs(["status", "--db=a.sqlite", "--chain", "solana"]).options).toEqual({ db: "a.sqlite", chain: "solana" });
  });

  it("keeps a value that contains '='", () => {
    expect(parseArgs(["status", "--db=a=b.sqlite"]).options["db"]).toBe("a=b.sqlite");
  });

  it("reads --json and --help as flags", () => {
    expect(parseArgs(["status", "--json"]).json).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["status", "--help"]).help).toBe(true);
  });

  it("has no command when nothing is given", () => {
    expect(parseArgs([]).command).toBeNull();
  });

  it("treats everything after -- as positional", () => {
    expect(parseArgs(["pnl", "--", "--weird-wallet"]).positionals).toEqual(["--weird-wallet"]);
  });

  it("lets option order vary", () => {
    expect(parseArgs(["--db", "d", "risk", "TOK1"]).command).toBe("risk");
    expect(parseArgs(["--db", "d", "risk", "TOK1"]).positionals).toEqual(["TOK1"]);
  });

  it("rejects an unknown option", () => {
    expect(() => parseArgs(["status", "--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "--nope"])).toThrow(/unknown option --nope/);
    expect(() => parseArgs(["status", "--nope", "x"])).toThrow(/unknown option --nope/);
    expect(() => parseArgs(["status", "--nope=1"])).toThrow(/unknown option --nope/);
  });

  it("rejects an option with no value", () => {
    expect(() => parseArgs(["status", "--db"])).toThrow(/--db/);
    expect(() => parseArgs(["status", "--db", "--json"])).toThrow(/--db/);
    expect(() => parseArgs(["status", "--db="])).toThrow(/--db/);
  });

  it("rejects the same option twice", () => {
    expect(() => parseArgs(["status", "--db", "a", "--db", "b"])).toThrow(/--db/);
  });

  it("rejects a value given to a flag", () => {
    expect(() => parseArgs(["status", "--json=yes"])).toThrow(/--json is a flag and takes no value/);
  });

  it("rejects an unknown short option", () => {
    expect(() => parseArgs(["status", "-x"])).toThrow(/-x/);
  });
});
