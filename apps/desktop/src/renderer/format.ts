// Pure display formatting for the renderer. Nothing here touches the DOM or the clock.
// Amounts arrive as decimal strings (see toWire) and are handled as bigint, so nothing loses precision.
// Bad input throws FormatError: a wrong number on screen is worse than a visible error.

export class FormatError extends Error {}

const MAX_DECIMALS = 36;
const MAX_FRACTION = 18;
const MAX_SIGNIFICANT = 40;
/** 9999-12-31T23:59:59.999Z: the last instant toISOString prints with a 4-digit year. */
const MAX_TIME = 253_402_300_799_999;

function checkInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new FormatError(`${name} must be a whole number from ${min} to ${max}`);
  }
}

function parseRaw(name: string, raw: string): bigint {
  if (typeof raw !== "string" || !/^-?[0-9]+$/.test(raw)) throw new FormatError(`${name} must be a whole number written in digits`);
  return BigInt(raw);
}

function group(digits: string): string {
  return digits.replace(/\B(?=(?:[0-9]{3})+(?![0-9]))/g, ",");
}

/** Prints n / 10^dp exactly (n >= 0): grouped integer part, no trailing zeros. */
function render(n: bigint, dp: number): string {
  const s = n.toString().padStart(dp + 1, "0");
  const whole = s.slice(0, s.length - dp);
  const frac = s.slice(s.length - dp).replace(/0+$/, "");
  return group(whole) + (frac === "" ? "" : `.${frac}`);
}

/**
 * A raw amount (smallest units) as a decimal number, rounded half up to `maxFraction` places.
 * A non-zero amount that would round to zero prints as "<0.0001", never as "0".
 */
export function formatUnits(raw: string, decimals: number, maxFraction = 4): string {
  checkInt("decimals", decimals, 0, MAX_DECIMALS);
  checkInt("maxFraction", maxFraction, 0, MAX_FRACTION);
  const value = parseRaw("amount", raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const sign = negative ? "-" : "";

  let n = abs;
  let dp = decimals;
  if (decimals > maxFraction) {
    const divisor = 10n ** BigInt(decimals - maxFraction);
    n = (abs * 2n + divisor) / (2n * divisor);
    dp = maxFraction;
  }
  if (abs === 0n) return "0";
  if (n === 0n) return `${sign}<${render(1n, dp)}`;
  return sign + render(n, dp);
}

/** Like formatUnits but with an explicit "+" on gains, for profit and loss. Zero has no sign. */
export function formatSigned(raw: string, decimals: number, maxFraction = 4): string {
  const text = formatUnits(raw, decimals, maxFraction);
  return text === "0" || text.startsWith("-") ? text : `+${text}`;
}

/** "1 trade", "0 trades", "12 trades": the count with its noun in the right number. */
export function countOf(n: number, singular: string, plural: string = `${singular}s`): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new FormatError("a count must be a whole number, 0 or more");
  return `${group(String(n))} ${n === 1 ? singular : plural}`;
}

/** A ratio that can be negative or above 1 (a return on cost) as a signed percentage. null prints a dash. */
export function formatSignedPercent(ratio: number | null, digits = 1): string {
  if (ratio === null) return "—";
  if (!Number.isFinite(ratio)) throw new FormatError("a ratio must be a finite number");
  checkInt("digits", digits, 0, 6);
  const text = (ratio * 100).toFixed(digits);
  if (Number(text) === 0) return `${(0).toFixed(digits)}%`;
  return `${ratio > 0 ? "+" : ""}${text}%`;
}

/**
 * Price of one whole token in whole quote units, from a mark ("`amount` raw token units are worth `quote` raw
 * quote units"). Shows at least `significant` significant digits, rounded half up; the integer part is never
 * rounded away.
 */
export function formatPrice(amount: string, quote: string, tokenDecimals: number, quoteDecimals: number, significant = 4): string {
  checkInt("tokenDecimals", tokenDecimals, 0, MAX_DECIMALS);
  checkInt("quoteDecimals", quoteDecimals, 0, MAX_DECIMALS);
  checkInt("significant", significant, 1, MAX_SIGNIFICANT);
  const tokens = parseRaw("amount", amount);
  const quoted = parseRaw("quote", quote);
  if (tokens < 0n || quoted < 0n) throw new FormatError("amounts must not be negative");
  if (tokens === 0n) throw new FormatError("a mark with zero tokens has no price");
  // Also keeps the loop below from running forever: with num = 0 it would never reach den.
  if (quoted === 0n) return "0";

  // price = (quote / 10^qd) / (amount / 10^td) = num / den
  const num = quoted * 10n ** BigInt(tokenDecimals);
  const den = tokens * 10n ** BigInt(quoteDecimals);
  const whole = num / den;
  let dp: number;
  if (whole > 0n) {
    dp = Math.max(0, significant - whole.toString().length);
  } else {
    // p = position after the decimal point of the first significant digit
    let p = 1;
    let scaled = num * 10n;
    while (scaled < den) {
      scaled *= 10n;
      p++;
    }
    dp = p - 1 + significant;
  }
  const n = (num * 10n ** BigInt(dp) * 2n + den) / (2n * den);
  return render(n, dp);
}

/** A 0..1 share as a percentage. null (unknown) prints a dash, never 0%. */
export function formatPercent(share: number | null, digits = 1): string {
  checkInt("digits", digits, 0, 6);
  if (share === null) return "—";
  if (!Number.isFinite(share) || share < 0 || share > 1) {
    throw new FormatError("a share must be a number from 0 to 1");
  }
  return `${(share * 100).toFixed(digits)}%`;
}

/** A duration as at most two units: "45s", "5m", "3h 20m", "2d 4h". */
export function formatAge(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new FormatError("an age must be a whole number of milliseconds, 0 or more");
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** A unix-ms time as UTC to the minute: "2023-11-14 22:13 UTC". Independent of locale and time zone. */
export function formatTime(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIME) throw new FormatError("a time must be unix milliseconds from 1970 to the year 9999");
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "ABCD…WXYZ". An address that would not get shorter is returned as it is. */
export function shortAddress(address: string, head = 4, tail = 4): string {
  checkInt("head", head, 0, 64);
  checkInt("tail", tail, 0, 64);
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(address.length - tail)}`;
}

/** A measured risk-signal value: "unknown", "yes"/"no", or a number with 4 significant digits. */
export function formatSignalValue(value: number | boolean | null): string {
  if (value === null) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (!Number.isFinite(value)) throw new FormatError("a signal value must be a finite number");
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const exponent = Number(abs.toExponential(3).split("e")[1]);
  const fixed = abs.toFixed(Math.min(MAX_FRACTION, Math.max(0, 3 - exponent)));
  if (/^0(?:\.0*)?$/.test(fixed) && abs !== 0) return `${sign}<${render(1n, MAX_FRACTION)}`;
  const [whole = "0", frac = ""] = fixed.split(".");
  const trimmed = frac.replace(/0+$/, "");
  return sign + group(whole) + (trimmed === "" ? "" : `.${trimmed}`);
}
