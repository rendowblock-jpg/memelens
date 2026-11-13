import { describe, expect, it } from "vitest";
import { formatStats, parseCliArgs, UsageError } from "../src/cli";
import type { Stats } from "../src/store";

describe("parseCliArgs", () => {
  it("reads run with its defaults", () => {
    expect(parseCliArgs(["run", "--state", "/var/x.sqlite"])).toEqual({ command: "run", state: "/var/x.sqlite", rate: 0.1, windowHours: 72, discoverEverySeconds: 20 });
  });

  it("reads every option of run", () => {
    expect(parseCliArgs(["run", "--state", "s", "--rate", "0.05", "--window-hours", "24", "--discover-every", "45"])).toEqual({ command: "run", state: "s", rate: 0.05, windowHours: 24, discoverEverySeconds: 45 });
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
