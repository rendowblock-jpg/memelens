import type { BacktestSpec } from "./types";

export class SpecError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = 5 * 366 * DAY_MS;
const WALLET = /^[\x21-\x7e]{1,128}$/;
const POSITION_QUOTE = /^[1-9][0-9]{0,38}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
}

/** Checks that `obj` has exactly the fields in `names` (unknown ones are reported first), and returns it. */
function exactly(path: string, v: unknown, names: readonly string[]): Record<string, unknown> {
  if (!isRecord(v)) throw new SpecError(path, "must be an object");
  for (const k of Object.keys(v)) if (!names.includes(k)) throw new SpecError(`${path}.${k}`, "is not a field of the spec");
  for (const k of names) if (!Object.hasOwn(v, k)) throw new SpecError(`${path}.${k}`, "is missing");
  return v;
}

function int(path: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new SpecError(path, `must be a whole number from ${min} to ${max}`);
  }
  return v;
}

/** Strict check of a backtest spec. Returns a copy; throws SpecError naming the first wrong field. */
export function parseBacktestSpec(input: unknown): BacktestSpec {
  const top = exactly("$", input, ["version", "from", "to", "strategy", "costs"]);
  if (top["version"] !== 1) throw new SpecError("$.version", "must be the number 1");
  const from = int("$.from", top["from"], 0, Number.MAX_SAFE_INTEGER);
  const to = int("$.to", top["to"], 0, Number.MAX_SAFE_INTEGER);
  if (from > to) throw new SpecError("$.to", "must not be before from");
  if (to - from > MAX_WINDOW_MS) throw new SpecError("$.to", "the window must not be longer than 5 years (1,830 days)");

  const s = exactly("$.strategy", top["strategy"], ["kind", "wallets", "latencyMs", "positionQuote", "takeProfitBps", "stopLossBps", "maxHoldMs"]);
  if (s["kind"] !== "follow-wallets") throw new SpecError("$.strategy.kind", 'must be "follow-wallets"');
  const wallets = s["wallets"];
  if (!Array.isArray(wallets) || wallets.length < 1 || wallets.length > 100) throw new SpecError("$.strategy.wallets", "must be a list of 1 to 100 wallets");
  const seen = new Set<string>();
  const copy: string[] = [];
  wallets.forEach((w, i) => {
    const where = `$.strategy.wallets[${i}]`;
    if (typeof w !== "string" || !WALLET.test(w)) throw new SpecError(where, "must be 1 to 128 printable ASCII characters without spaces");
    if (seen.has(w)) throw new SpecError(where, "is listed twice");
    seen.add(w);
    copy.push(w);
  });
  const latencyMs = int("$.strategy.latencyMs", s["latencyMs"], 0, DAY_MS);
  const quote = s["positionQuote"];
  if (typeof quote !== "string" || !POSITION_QUOTE.test(quote)) {
    throw new SpecError("$.strategy.positionQuote", "must be a whole number from 1 to 39 digits, written as text, without a leading zero");
  }
  const orNull = (path: string, v: unknown, max: number): number | null => (v === null ? null : int(path, v, 1, max));
  const takeProfitBps = orNull("$.strategy.takeProfitBps", s["takeProfitBps"], 1_000_000);
  const stopLossBps = orNull("$.strategy.stopLossBps", s["stopLossBps"], 9999);
  const maxHoldMs = int("$.strategy.maxHoldMs", s["maxHoldMs"], 1, 2_592_000_000);

  const c = exactly("$.costs", top["costs"], ["feeBps", "slippageBps"]);
  const feeBps = int("$.costs.feeBps", c["feeBps"], 0, 1000);
  const slippageBps = int("$.costs.slippageBps", c["slippageBps"], 0, 5000);

  return {
    version: 1,
    from,
    to,
    strategy: { kind: "follow-wallets", wallets: copy, latencyMs, positionQuote: quote, takeProfitBps, stopLossBps, maxHoldMs },
    costs: { feeBps, slippageBps },
  };
}
