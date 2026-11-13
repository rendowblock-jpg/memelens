import type { Stats } from "./store";

export class UsageError extends Error {}

export type CliArgs =
  | { command: "run"; state: string; rate: number; windowHours: number; discoverEverySeconds: number }
  | { command: "status"; state: string };

const OPTIONS: Record<string, string[]> = {
  run: ["--state", "--rate", "--window-hours", "--discover-every"],
  status: ["--state"],
};

/** Reads `run --state FILE [--rate 0.1] [--window-hours 72] [--discover-every 20]` and `status --state FILE`. Anything else is refused by name. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError("a command is needed: run or status");
  const allowed = OPTIONS[command];
  if (allowed === undefined) throw new UsageError(`unknown command ${command} (use run or status)`);
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    if (!allowed.includes(flag)) throw new UsageError(`unknown option ${flag}`);
    const value = rest[i + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    values.set(flag, value);
  }
  const state = values.get("--state");
  if (state === undefined || state === "") throw new UsageError("--state FILE is needed");
  if (command === "status") return { command: "status", state };

  const rate = values.has("--rate") ? Number(values.get("--rate")) : 0.1;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new UsageError("--rate must be a number from 0 to 1");
  const windowHours = values.has("--window-hours") ? Number(values.get("--window-hours")) : 72;
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new UsageError("--window-hours must be a number above 0");
  const discoverEverySeconds = values.has("--discover-every") ? Number(values.get("--discover-every")) : 20;
  if (!Number.isInteger(discoverEverySeconds) || discoverEverySeconds <= 0) throw new UsageError("--discover-every must be a whole number of seconds above 0");
  return { command: "run", state, rate, windowHours, discoverEverySeconds };
}

const KIND_ORDER = ["snapshot", "path72", "path30d"];

/** The status text printed by `status` and logged now and then by `run`. */
export function formatStats(stats: Stats): string {
  const lines = [`launches seen ${stats.launches}, followed ${stats.followed}`];
  const kinds = Object.keys(stats.tasks).sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  if (kinds.length === 0) lines.push("no tasks yet");
  for (const kind of kinds) {
    const byStatus = stats.tasks[kind]!;
    lines.push(`${kind}: ${Object.keys(byStatus).sort().map((s) => `${s} ${byStatus[s]}`).join(", ")}`);
  }
  lines.push(`stored ${stats.payloads} replies, ${(stats.payloadBytes / 1024 ** 2).toFixed(1)} MiB`);
  return lines.join("\n");
}
