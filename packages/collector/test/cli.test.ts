import { describe, expect, it } from "vitest";
import { formatExportSummary, formatStats, parseCliArgs, UsageError } from "../src/cli";
import type { Stats } from "../src/store";

describe("parseCliArgs", () => {
  it("reads run with its defaults", () => {
    expect(parseCliArgs(["run", "--state", "/var/x.sqlite"])).toEqual({ command: "run", state: "/var/x.sqlite", rate: 0.1, windowHours: 72, discoverEverySeconds: 20 });
  });

  it("reads every option of run", () => {
    expect(parseCliArgs(["run", "--state", "s", "--rate", "0.05", "--window-hours", "24", "--discover-every", "45"])).toEqual({ command: "run", state: "s", rate: 0.05, windowHours: 24, discoverEverySeconds: 45 });
  });

  it("reads export", () => {
    expect(parseCliArgs(["export", "--state", "s", "--out", "f.json"])).toEqual({ command: "export", state: "s", out: "f.json", minCensus: 100 });
    expect(parseCliArgs(["export", "--state", "s", "--out", "f.json", "--min-census", "6"])).toEqual({ command: "export", state: "s", out: "f.json", minCensus: 6 });
  });

  it("reads status", () => {
    expect(parseCliArgs(["status", "--state", "s"])).toEqual({ command: "status", state: "s" });
  });

  it("refuses what it does not understand, with a message that says what", () => {
    const bad: Array<[string[], RegExp]> = [
      [[], /command/],
      [["fly"], /unknown command/],
      [["run"], /--state/],
      [["run", "--state"], /--state/],
      [["run", "--state", "s", "--nope", "1"], /unknown option --nope/],
      [["run", "--state", "s", "--rate", "2"], /--rate/],
      [["run", "--state", "s", "--rate", "x"], /--rate/],
      [["run", "--state", "s", "--window-hours", "0"], /--window-hours/],
      [["run", "--state", "s", "--discover-every", "1.5"], /--discover-every/],
      [["status", "--state", "s", "--rate", "0.1"], /unknown option --rate/],
      [["export", "--state", "s"], /--out/],
      [["export", "--out", "f"], /--state/],
      [["export", "--state", "s", "--out", "f", "--min-census", "0"], /--min-census/],
      [["export", "--state", "s", "--out", "f", "--min-census", "x"], /--min-census/],
      [["export", "--state", "s", "--out", "f", "--rate", "0.1"], /unknown option --rate/],
    ];
    for (const [argv, message] of bad) expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(message);
    expect(() => parseCliArgs([])).toThrow(UsageError);
  });
});

describe("formatStats", () => {
  const stats: Stats = {
    launches: 120,
    followed: 25,
    tasks: { snapshot: { done: 10, pending: 12, missed: 3 }, path72: { pending: 25 }, path30d: { pending: 25 } },
    payloads: 55,
    payloadBytes: 1_572_864,
  };

  it("prints the launches, each kind of task by status, and the stored size", () => {
    expect(formatStats(stats)).toBe(
      ["launches seen 120, followed 25", "snapshot: done 10, missed 3, pending 12", "path72: pending 25", "path30d: pending 25", "stored 55 replies, 1.5 MiB"].join("\n"),
    );
  });

  it("says so when nothing has been collected", () => {
    expect(formatStats({ launches: 0, followed: 0, tasks: {}, payloads: 0, payloadBytes: 0 })).toBe("launches seen 0, followed 0\nno tasks yet\nstored 0 replies, 0.0 MiB");
  });
});

describe("formatExportSummary", () => {
  const summary = { stored: 120, used: 100, noReport: 12, unreadable: 8, censusUsed: true, protocolWallets: ["BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s"], byQuality: { exact: 40, estimated: 30, unattributed: 10, inconsistent: 5, unmodelled: 15 } };

  it("prints the counts, the protocol wallets and the quality of the reports used", () => {
    expect(formatExportSummary(summary)).toBe(
      [
        "reports stored 120: used 100, no report 12, unreadable 8",
        "protocol wallets (census over 100 reports): BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s",
        "quality: exact 40, estimated 30, unattributed 10, inconsistent 5, unmodelled 15",
      ].join("\n"),
    );
  });

  it("says the census was not used, and why, when there were too few reports", () => {
    expect(formatExportSummary({ ...summary, used: 6, censusUsed: false, protocolWallets: [] })).toContain("protocol wallets: NOT USED (a census needs at least the number of readable reports given by --min-census; 6 were readable)");
  });

  it("says none were found when the census ran and found none", () => {
    expect(formatExportSummary({ ...summary, protocolWallets: [] })).toContain("protocol wallets (census over 100 reports): none");
  });
});
