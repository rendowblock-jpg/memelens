import type { EngineStatusInfo, UpdateInfo } from "@memelens/service";
import type { BacktestReport, BacktestSpec } from "@memelens/sidecar";
import type { Loaded } from "./controller";
import { smartWindow, type SmartSpan } from "./model";
import type { Quote } from "./quote";

// The pure part of the backtest screen: the form's text becomes the spec the engine accepts, or a message for each wrong
// field. Amounts are read as text and turned into whole numbers (never through floating point), and nothing is rounded
// silently: more decimals than the unit has is an error. The engine checks the spec again; this is for the person typing.

export interface BacktestForm {
  /** Wallet addresses separated by spaces, commas, semicolons or new lines. */
  wallets: string;
  span: SmartSpan;
  /** Whole seconds between the wallet's trade and ours. */
  delaySeconds: string;
  /** A decimal amount in the chain's quote currency (SOL), written with a dot. */
  positionSize: string;
  /** Percent, or empty for none. */
  takeProfitPct: string;
  stopLossPct: string;
  maxHoldHours: string;
  feePct: string;
  slippagePct: string;
}

export type FormField = Exclude<keyof BacktestForm, "span">;
export type FormErrors = Partial<Record<FormField, string>>;

export const DEFAULT_FORM: BacktestForm = {
  wallets: "",
  span: "30d",
  delaySeconds: "0",
  positionSize: "0.1",
  takeProfitPct: "",
  stopLossPct: "",
  maxHoldHours: "24",
  feePct: "0.3",
  slippagePct: "1",
};

const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = 5 * 366 * DAY_MS; // the engine's limit (packages/sidecar/src/spec.ts)
const DIGITS = /^[0-9]+$/;
const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;
const WALLET = /^[\x21-\x7e]{1,128}$/;

/** The addresses in a text box: split on spaces, commas, semicolons and new lines; a repeated address is kept once. */
export function parseWallets(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter((w) => w !== ""))];
}

export type AmountResult = { ok: true; raw: string } | { ok: false; reason: "format" | "places" | "zero" | "size" };

/** A decimal amount ("0.5") as raw units ("500000000"). Digits and at most one dot; more places than `decimals` is refused. */
export function parseAmount(text: string, decimals: number): AmountResult {
  const m = DECIMAL.exec(text.trim());
  if (m === null) return { ok: false, reason: "format" };
  const fraction = m[2] ?? "";
  if (fraction.length > decimals) return { ok: false, reason: "places" };
  const raw = BigInt(m[1]! + fraction.padEnd(decimals, "0")).toString();
  if (raw === "0") return { ok: false, reason: "zero" };
  if (raw.length > 39) return { ok: false, reason: "size" };
  return { ok: true, raw };
}

export type PercentResult = { ok: true; bps: number } | { ok: false; reason: "format" | "places" | "size" };

/** A percentage with up to two decimals ("12.5") as basis points (1250). */
export function parsePercent(text: string): PercentResult {
  const m = DECIMAL.exec(text.trim());
  if (m === null) return { ok: false, reason: "format" };
  const fraction = m[2] ?? "";
  if (fraction.length > 2) return { ok: false, reason: "places" };
  const whole = Number(m[1]);
  if (whole > 999_999_999) return { ok: false, reason: "size" };
  return { ok: true, bps: whole * 100 + Number(fraction.padEnd(2, "0")) };
}

/** The window the spec covers: like the smart-money window, but "all data" is limited to what the engine accepts (5 years). */
export function backtestWindow(latest: number, span: SmartSpan): { from: number; to: number } {
  const w = smartWindow(latest, span);
  return { from: Math.max(w.from, w.to - MAX_WINDOW_MS), to: w.to };
}

/** A whole number written in digits, within [min, max], or null. */
function whole(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!DIGITS.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

export type BuildResult = { ok: true; spec: BacktestSpec } | { ok: false; errors: FormErrors };

/** The form as a spec, or a message for every wrong field. `latest` is the newest data time; `quote` the chain's currency. */
export function buildSpec(form: BacktestForm, latest: number, quote: Quote): BuildResult {
  const errors: FormErrors = {};
  const window = backtestWindow(latest, form.span);

  const wallets = parseWallets(form.wallets);
  if (wallets.length === 0) errors.wallets = "Enter at least one wallet address.";
  else if (wallets.length > 100) errors.wallets = `Use at most 100 wallets (you entered ${wallets.length}).`;
  else {
    const bad = wallets.findIndex((w) => !WALLET.test(w));
    if (bad !== -1) errors.wallets = `Wallet number ${bad + 1} is not a valid address.`;
  }

  const seconds = whole(form.delaySeconds, 0, 86_400);
  if (seconds === null) errors.delaySeconds = "Enter a whole number of seconds from 0 to 86,400.";

  let positionQuote = "";
  const amount = parseAmount(form.positionSize, quote.decimals);
  if (amount.ok) positionQuote = amount.raw;
  else if (amount.reason === "format") errors.positionSize = "Enter an amount such as 0.5, with a dot for decimals.";
  else if (amount.reason === "places") errors.positionSize = quote.decimals === 0 ? "Use a whole number." : `Use at most ${quote.decimals} decimal places.`;
  else if (amount.reason === "zero") errors.positionSize = "Must be more than 0.";
  else errors.positionSize = "That amount is too large.";

  const takeProfitBps = optionalPercent(form.takeProfitPct, 1_000_000, {
    format: "Enter a percentage such as 50, or leave it empty.",
    zero: "Must be more than 0, or leave it empty.",
    big: "At most 10,000%.",
  });
  if (typeof takeProfitBps === "string") errors.takeProfitPct = takeProfitBps;
  const stopLossBps = optionalPercent(form.stopLossPct, 9999, {
    format: "Enter a percentage such as 20, or leave it empty.",
    zero: "Must be more than 0, or leave it empty.",
    big: "Must be less than 100%.",
  });
  if (typeof stopLossBps === "string") errors.stopLossPct = stopLossBps;

  const hours = whole(form.maxHoldHours, 1, 720);
  if (hours === null) errors.maxHoldHours = "Enter a whole number of hours from 1 to 720.";

  const feeBps = requiredPercent(form.feePct, 1000, "Enter a percentage such as 0.3.", "Enter a percentage from 0 to 10.");
  if (typeof feeBps === "string") errors.feePct = feeBps;
  const slippageBps = requiredPercent(form.slippagePct, 5000, "Enter a percentage such as 1.", "Enter a percentage from 0 to 50.");
  if (typeof slippageBps === "string") errors.slippagePct = slippageBps;

  if (
    Object.keys(errors).length > 0 ||
    seconds === null ||
    hours === null ||
    typeof takeProfitBps === "string" ||
    typeof stopLossBps === "string" ||
    typeof feeBps === "string" ||
    typeof slippageBps === "string"
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    spec: {
      version: 1,
      from: window.from,
      to: window.to,
      strategy: { kind: "follow-wallets", wallets, latencyMs: seconds * 1000, positionQuote, takeProfitBps, stopLossBps, maxHoldMs: hours * 3_600_000 },
      costs: { feeBps, slippageBps },
    },
  };
}

/** An optional percentage: null when empty, basis points when good, or the message. */
function optionalPercent(text: string, maxBps: number, say: { format: string; zero: string; big: string }): number | null | string {
  if (text.trim() === "") return null;
  const p = parsePercent(text);
  if (!p.ok) return p.reason === "format" ? say.format : p.reason === "places" ? "Use at most 2 decimal places." : say.big;
  if (p.bps < 1) return say.zero;
  return p.bps > maxBps ? say.big : p.bps;
}

/** A required percentage: basis points when good, or the message. */
function requiredPercent(text: string, maxBps: number, format: string, range: string): number | string {
  const p = parsePercent(text);
  if (!p.ok) return p.reason === "format" ? format : p.reason === "places" ? "Use at most 2 decimal places." : range;
  return p.bps > maxBps ? range : p.bps;
}

export type RunState =
  | { phase: "idle" }
  | { phase: "running"; since: number; cancelling: boolean }
  | { phase: "done"; report: BacktestReport }
  | { phase: "failed"; message: string }
  | { phase: "cancelled" };

export type RunEvent = { type: "start"; at: number } | { type: "cancel" } | { type: "finished"; result: Loaded<BacktestReport> };

/** The life of one run. Events that do not make sense in the current state change nothing (an answer to a run that is over, a second start). */
export function reduceRun(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case "start":
      return state.phase === "running" ? state : { phase: "running", since: event.at, cancelling: false };
    case "cancel":
      return state.phase === "running" && !state.cancelling ? { ...state, cancelling: true } : state;
    case "finished":
      if (state.phase !== "running") return state;
      if (event.result.state === "ok") return { phase: "done", report: event.result.data };
      return state.cancelling ? { phase: "cancelled" } : { phase: "failed", message: event.result.message };
  }
}

/** What an update check found, as a sentence for the person looking at the screen. */
export function checkNote(info: UpdateInfo): string {
  switch (info.kind) {
    case "up-to-date":
      return `You have the latest engine (${info.version}).`;
    case "older":
      return `The newest published engine (${info.latest}) is older than yours (${info.current}); nothing to do.`;
    case "available":
      return `Version ${info.version} is available.`;
  }
}

/** Why a backtest cannot start right now, or null when it can. The most basic reason comes first. */
export function blockedReason(status: EngineStatusInfo | null, loadError: string | null, working: "checking" | "installing" | null): string | null {
  if (status === null) return loadError === null ? "Waiting for the engine's state." : "The engine's state could not be read.";
  if (status.installed === null) return "No engine is installed, so a backtest cannot run.";
  if (working === "installing") return "The engine is being updated.";
  if (status.busy) return "A backtest is already running.";
  return null;
}
