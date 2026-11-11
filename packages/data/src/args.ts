/** A mistake in how the command was written. The CLI exits with code 2 for these. */
export class UsageError extends Error {}

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  /** Raw option values, not yet converted. */
  options: Record<string, string>;
  json: boolean;
  help: boolean;
}

const MS_DIGITS = /^[0-9]+$/;
// date, optionally followed by T hh:mm[:ss[.fff]] and a mandatory Z or +hh:mm / -hh:mm.
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/;

function badTime(text: string): never {
  throw new UsageError(
    `invalid time ${JSON.stringify(text)}: use unix milliseconds (1700000000000) or ISO-8601 with Z or an offset ` +
      "(2023-11-14T22:13:20Z), or a plain date (2023-11-14, midnight UTC)",
  );
}

/**
 * Unix ms from digits, or from ISO-8601. Strict on purpose: JavaScript's Date.parse rolls 2023-02-30 over to
 * 2 March and reads a time with no offset as local time, and an analysis "as of" the wrong instant is a wrong
 * answer that looks right. Here the calendar is checked and a time of day must say its offset.
 */
export function parseTime(text: string): number {
  if (MS_DIGITS.test(text)) {
    const n = Number(text);
    if (!Number.isSafeInteger(n)) badTime(text);
    return n;
  }
  const m = ISO.exec(text);
  if (m === null) return badTime(text);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hasTime = m[4] !== undefined;
  const hour = hasTime ? Number(m[4]) : 0;
  const minute = hasTime ? Number(m[5]) : 0;
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  // Build the date and see whether the month survived. A day that does not exist (Feb 30, day 00) rolls into a
  // neighbouring month, and a month outside 1..12 can never equal a real month index, so this one compare covers both.
  // setUTCFullYear keeps years below 100 literal (the Date constructor would map them to 19xx).
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (probe.getUTCMonth() !== month - 1) badTime(text);
  if (hour > 23 || minute > 59 || second > 59) badTime(text);

  let offsetMinutes = 0;
  const zone = m[8];
  if (zone !== undefined && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) badTime(text);
    offsetMinutes = sign * (oh * 60 + om);
  }
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, millis);
  const ms = utc.getTime() - offsetMinutes * 60_000;
  if (!Number.isSafeInteger(ms) || ms < 0) badTime(text);
  return ms;
}

const VALUE_OPTIONS: ReadonlySet<string> = new Set(["db", "chain", "at", "from", "min-closed"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const words: string[] = [];
  const options: Record<string, string> = {};
  let json = false;
  let help = false;
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (literal) {
      words.push(tok);
    } else if (tok === "--") {
      literal = true;
    } else if (tok === "-h" || tok === "--help") {
      help = true;
    } else if (tok === "--json") {
      json = true;
    } else if (tok.startsWith("--json=")) {
      throw new UsageError("--json is a flag and takes no value");
    } else if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option --${name}`);
      if (name in options) throw new UsageError(`--${name} given more than once`);
      let value: string | undefined;
      if (eq === -1) {
        value = argv[i + 1];
        if (value !== undefined && !value.startsWith("--")) i++;
        else value = undefined;
      } else {
        value = tok.slice(eq + 1);
      }
      if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
      options[name] = value;
    } else if (tok.startsWith("-") && tok.length > 1) {
      throw new UsageError(`unknown option ${tok}`);
    } else {
      words.push(tok);
    }
  }
  return { command: words[0] ?? null, positionals: words.slice(1), options, json, help };
}
