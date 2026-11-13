import { describe, expect, it } from "vitest";
import { formatAnalysis, formatExportSummary, formatLabelSummary, formatStats, parseCliArgs, UsageError } from "../src/cli";
import type { Analysis } from "../src/analyze";
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

  it("reads label", () => {
    expect(parseCliArgs(["label", "--state", "s", "--out", "labels.jsonl"])).toEqual({ command: "label", state: "s", out: "labels.jsonl" });
  });

  it("reads analyze with its defaults and its options", () => {
    expect(parseCliArgs(["analyze", "--state", "s", "--out", "r.json"])).toEqual({ command: "analyze", state: "s", out: "r.json", minCensus: 100, groupSize: 30 });
    expect(parseCliArgs(["analyze", "--state", "s", "--out", "r.json", "--min-census", "7", "--group-size", "12"])).toEqual({ command: "analyze", state: "s", out: "r.json", minCensus: 7, groupSize: 12 });
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
      [["analyze", "--state", "s"], /--out/],
      [["analyze", "--out", "f"], /--state/],
      [["analyze", "--state", "s", "--out", "f", "--group-size", "0"], /--group-size/],
      [["analyze", "--state", "s", "--out", "f", "--group-size", "2.5"], /--group-size/],
      [["analyze", "--state", "s", "--out", "f", "--min-census", "0"], /--min-census/],
      [["analyze", "--state", "s", "--out", "f", "--rate", "1"], /unknown option --rate/],
      [["label", "--state", "s"], /--out/],
      [["label", "--out", "f"], /--state/],
      [["label", "--state", "s", "--out", "f", "--min-census", "5"], /unknown option --min-census/],
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

describe("formatLabelSummary", () => {
  it("prints the counts by label and why the neither tokens are neither, the commonest reason first", () => {
    expect(
      formatLabelSummary({ total: 7, byLabel: { rugged: 2, survived: 1, neither: 3, "collapsed-before-scoring": 1 }, neitherByReason: { faded: 1, "missing-72h": 2 } }),
    ).toBe(["tokens labelled 7: rugged 2, survived 1, neither 3, collapsed-before-scoring 1", "neither because: missing-72h 2, faded 1"].join("\n"));
  });

  it("breaks a tie between reasons by name", () => {
    expect(formatLabelSummary({ total: 2, byLabel: { rugged: 0, survived: 0, neither: 2, "collapsed-before-scoring": 0 }, neitherByReason: { zebra: 1, apple: 1 } })).toContain("neither because: apple 1, zebra 1");
  });

  it("says none when nothing is neither", () => {
    expect(formatLabelSummary({ total: 0, byLabel: { rugged: 0, survived: 0, neither: 0, "collapsed-before-scoring": 0 }, neitherByReason: {} })).toBe("tokens labelled 0: rugged 0, survived 0, neither 0, collapsed-before-scoring 0\nneither because: none");
  });
});

describe("formatAnalysis", () => {
  const tally = (n: number, flagged: number, left: number): Analysis["rugged"]["all"] => ({ n, flagged, left, unknown: n - flagged - left });
  const analysis: Analysis = {
    ok: true,
    labels: { total: 12, byLabel: { rugged: 5, survived: 4, neither: 2, "collapsed-before-scoring": 1 }, neitherByReason: { faded: 2 } },
    census: { readable: 11, used: true, wallets: ["PW1", "PW2"] },
    rugged: { available: 5, picked: [], all: tally(5, 3, 1), wellFormed: tally(4, 3, 1), bySupply: { "below 1.5B": 2, "1.5B or more": 2, "no report": 1 } },
    survived: { available: 9, picked: [], all: tally(4, 1, 3), wellFormed: tally(4, 1, 3), bySupply: { "below 1.5B": 4, "1.5B or more": 0, "no report": 0 } },
    scored: 9,
  };
  // The Wilson numbers were computed in Python from the formula, not by the code under test.
  const expected = [
    "tokens labelled 12: rugged 5, survived 4, neither 2, collapsed-before-scoring 1",
    "neither because: faded 2",
    "protocol wallets: census over 11 readable first-hour reports found PW1, PW2",
    "",
    "RUGGED: 5 picked of 5 available",
    "  flagged high or critical: 3 of 5 = 60.0% (Wilson 95%: 23.1% to 88.2%)",
    "  no level (unknown), counted as not flagged: 1",
    "  among those with a level: 3 of 4 = 75.0% (Wilson 95%: 30.1% to 95.4%)",
    "  snapshots exact or estimated only: 3 of 4 = 75.0% (Wilson 95%: 30.1% to 95.4%); no level 0",
    "  picked by supply: below 1.5B 2, 1.5B or more 2, no report 1",
    "",
    "SURVIVED: 4 picked of 9 available",
    "  left at medium or below: 3 of 4 = 75.0% (Wilson 95%: 30.1% to 95.4%)",
    "  no level (unknown), counted as not left: 0",
    "  among those with a level: 3 of 4 = 75.0% (Wilson 95%: 30.1% to 95.4%)",
    "  snapshots exact or estimated only: 3 of 4 = 75.0% (Wilson 95%: 30.1% to 95.4%); no level 0",
    "  picked by supply: below 1.5B 4, 1.5B or more 0, no report 0",
  ].join("\n");

  it("prints the labels, the census, and for each group the rate with its interval, the unknowns, and the well-formed subset", () => {
    expect(formatAnalysis(analysis)).toBe(expected);
  });

  it("says the census was not used, and why", () => {
    expect(formatAnalysis({ ...analysis, census: { readable: 6, used: false, wallets: [] } })).toContain("protocol wallets: NOT USED (6 readable first-hour reports are fewer than the minimum for a census)");
  });

  it("says no wallet was found when the census ran and found none", () => {
    expect(formatAnalysis({ ...analysis, census: { readable: 150, used: true, wallets: [] } })).toContain("protocol wallets: census over 150 readable first-hour reports found none");
  });

  it("says so, with no rate, for a group with nobody picked, and for a subset with nobody in it", () => {
    const none = { available: 0, picked: [], all: tally(0, 0, 0), wellFormed: tally(0, 0, 0), bySupply: { "below 1.5B": 0, "1.5B or more": 0, "no report": 0 } };
    const out = formatAnalysis({ ...analysis, rugged: none });
    expect(out).toContain("RUGGED: 0 picked of 0 available");
    expect(out).toContain("  flagged high or critical: nobody picked");
    expect(out).toContain("  among those with a level: nobody");
    expect(out).toContain("  snapshots exact or estimated only: nobody; no level 0");
  });

  it("shows a rate of 0 or all with its one-sided interval", () => {
    const out = formatAnalysis({ ...analysis, survived: { available: 2, picked: [], all: tally(2, 0, 2), wellFormed: tally(2, 0, 2), bySupply: { "below 1.5B": 2, "1.5B or more": 0, "no report": 0 } } });
    expect(out).toContain("  left at medium or below: 2 of 2 = 100.0% (Wilson 95%: 34.2% to 100.0%)");
  });
});
