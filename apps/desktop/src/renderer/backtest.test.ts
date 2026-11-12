import { parseBacktestSpec, type BacktestReport } from "@memelens/sidecar";
import { describe, expect, it } from "vitest";
import type { EngineStatusInfo } from "@memelens/service";
import { backtestWindow, blockedReason, buildSpec, checkNote, DEFAULT_FORM, parseAmount, parsePercent, parseWallets, reduceRun, type BacktestForm, type RunState } from "./backtest";
import { FormatError } from "./format";
import { quoteFor, RAW_QUOTE } from "./quote";

const SOL = quoteFor("solana"); // 9 decimals
const LATEST = 1_700_020_700_000;
const DAY = 86_400_000;
const FIVE_YEARS = 5 * 366 * DAY; // the engine's limit: 158,112,000,000 ms

describe("parseWallets", () => {
  it("splits on spaces, tabs, commas, semicolons and new lines", () => {
    expect(parseWallets("alice\nbob")).toEqual(["alice", "bob"]);
    expect(parseWallets("a, b;c  d\r\ne\tf")).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(parseWallets(",,a,,;; b ,")).toEqual(["a", "b"]);
  });
  it("keeps the first of a repeated address, in the order typed, and never changes the case", () => {
    expect(parseWallets("b a b A a")).toEqual(["b", "a", "A"]);
  });
  it("is empty for nothing", () => {
    expect(parseWallets("")).toEqual([]);
    expect(parseWallets(" \n\t ,; ")).toEqual([]);
  });
});

describe("parseAmount", () => {
  const ok = (text: string, decimals = 9): string => {
    const r = parseAmount(text, decimals);
    if (!r.ok) throw new Error(`${JSON.stringify(text)} refused: ${r.reason}`);
    return r.raw;
  };
  const refused = (text: string, decimals = 9): string => {
    const r = parseAmount(text, decimals);
    if (r.ok) throw new Error(`${JSON.stringify(text)} accepted as ${r.raw}`);
    return r.reason;
  };
  it("turns a decimal amount into raw units exactly", () => {
    expect(ok("1")).toBe("1000000000");
    expect(ok("0.5")).toBe("500000000");
    expect(ok("0.1")).toBe("100000000");
    expect(ok("0.000000001")).toBe("1");
    expect(ok("12.345678901")).toBe("12345678901");
    expect(ok("1000000")).toBe("1000000000000000");
  });
  it("does not go through floating point", () => {
    expect(ok("0.3")).toBe("300000000");
    expect(ok("1.1")).toBe("1100000000");
    expect(ok("9007199254.740993")).toBe("9007199254740993000"); // beyond 2^53: floats would round it
  });
  it("ignores spaces around the text and leading zeros", () => {
    expect(ok("  0.5  ")).toBe("500000000");
    expect(ok("007")).toBe("7000000000");
    expect(ok("00.5")).toBe("500000000");
  });
  it("refuses more decimal places than the currency has, instead of rounding", () => {
    expect(refused("0.0000000001")).toBe("places");
    expect(refused("0.5000000000")).toBe("places");
    expect(refused("1.5", 0)).toBe("places");
    expect(refused("5.0", 0)).toBe("places");
  });
  it("refuses zero in every spelling", () => {
    for (const t of ["0", "0.0", "0.000000000", "000"]) expect(refused(t), t).toBe("zero");
    expect(refused("0", 0)).toBe("zero");
  });
  it("refuses anything that is not digits with at most one dot", () => {
    for (const t of ["", " ", "abc", "-1", "+1", "1e3", ".5", "5.", "1,5", "1 000", "0x10", "1.2.3", "٣", "1_000", "NaN", "Infinity", "1\n2"]) {
      expect(refused(t), JSON.stringify(t)).toBe("format");
    }
  });
  it("accepts raw units for a currency with no decimals", () => {
    expect(ok("5", 0)).toBe("5");
    expect(ok("1000", 0)).toBe("1000");
  });
  it("accepts up to 39 digits of raw units and refuses more", () => {
    expect(ok("9".repeat(39), 0)).toBe("9".repeat(39));
    expect(refused("1" + "0".repeat(39), 0)).toBe("size");
    expect(ok("9".repeat(30))).toBe("9".repeat(30) + "000000000"); // 30 + 9 = 39 digits
    expect(refused("1" + "0".repeat(30))).toBe("size"); // 31 + 9 = 40 digits
  });
});

describe("parsePercent", () => {
  const ok = (text: string): number => {
    const r = parsePercent(text);
    if (!r.ok) throw new Error(`${JSON.stringify(text)} refused: ${r.reason}`);
    return r.bps;
  };
  const refused = (text: string): string => {
    const r = parsePercent(text);
    if (r.ok) throw new Error(`${JSON.stringify(text)} accepted as ${r.bps}`);
    return r.reason;
  };
  it("turns a percentage into basis points exactly", () => {
    expect(ok("0")).toBe(0);
    expect(ok("50")).toBe(5000);
    expect(ok("12.5")).toBe(1250);
    expect(ok("0.01")).toBe(1);
    expect(ok("0.3")).toBe(30);
    expect(ok("0.29")).toBe(29);
    expect(ok("100")).toBe(10000);
    expect(ok("9999.99")).toBe(999999);
    expect(ok("1.10")).toBe(110);
  });
  it("ignores spaces around the text and leading zeros", () => {
    expect(ok(" 12.5 ")).toBe(1250);
    expect(ok("007")).toBe(700);
  });
  it("refuses a third decimal place instead of rounding", () => {
    expect(refused("0.001")).toBe("places");
    expect(refused("1.234")).toBe("places");
    expect(refused("1.100")).toBe("places");
  });
  it("refuses anything that is not digits with at most one dot", () => {
    for (const t of ["", " ", "abc", "-1", "+1", "1,5", ".5", "5.", "1e2", "1.2.3", "5%", "٣", "1\n2"]) expect(refused(t), JSON.stringify(t)).toBe("format");
  });
  it("accepts up to 9 digits before the dot and refuses more", () => {
    expect(ok("999999999")).toBe(99_999_999_900);
    expect(refused("1000000000")).toBe("size");
  });
});

describe("backtestWindow", () => {
  it("ends at the newest data and starts the chosen span earlier", () => {
    expect(backtestWindow(LATEST, "1d")).toEqual({ from: LATEST - DAY, to: LATEST });
    expect(backtestWindow(LATEST, "7d")).toEqual({ from: LATEST - 7 * DAY, to: LATEST });
    expect(backtestWindow(LATEST, "30d")).toEqual({ from: LATEST - 30 * DAY, to: LATEST });
  });
  it("limits all data to the 5 years the engine accepts, exactly", () => {
    expect(FIVE_YEARS).toBe(158_112_000_000);
    expect(backtestWindow(LATEST, "all")).toEqual({ from: LATEST - FIVE_YEARS, to: LATEST });
    expect(backtestWindow(FIVE_YEARS, "all")).toEqual({ from: 0, to: FIVE_YEARS });
  });
  it("starts at 0 when the data is younger than that", () => {
    expect(backtestWindow(1_000_000, "all")).toEqual({ from: 0, to: 1_000_000 });
    expect(backtestWindow(1_000, "7d")).toEqual({ from: 0, to: 1_000 });
  });
  it("refuses a time that is not whole milliseconds", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => backtestWindow(bad, "all"), String(bad)).toThrow(FormatError);
  });
});

function form(over: Partial<BacktestForm> = {}): BacktestForm {
  return { ...DEFAULT_FORM, wallets: "alice bob", ...over };
}
function specOf(over: Partial<BacktestForm> = {}, quote = SOL): ReturnType<typeof parseBacktestSpec> {
  const r = buildSpec(form(over), LATEST, quote);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.errors)}`);
  return r.spec;
}
function errorsOf(over: Partial<BacktestForm>, quote = SOL): Record<string, string> {
  const r = buildSpec(form(over), LATEST, quote);
  if (r.ok) throw new Error("accepted");
  return r.errors as Record<string, string>;
}

describe("buildSpec: a good form", () => {
  it("makes the spec the engine expects, from the defaults", () => {
    expect(specOf()).toEqual({
      version: 1,
      from: LATEST - 30 * DAY,
      to: LATEST,
      strategy: { kind: "follow-wallets", wallets: ["alice", "bob"], latencyMs: 0, positionQuote: "100000000", takeProfitBps: null, stopLossBps: null, maxHoldMs: DAY },
      costs: { feeBps: 30, slippageBps: 100 },
    });
  });
  it("converts every field into the engine's unit", () => {
    const s = specOf({ delaySeconds: "5", positionSize: "2.5", takeProfitPct: "50", stopLossPct: "20", maxHoldHours: "2", feePct: "0.25", slippagePct: "1.5", span: "7d" });
    expect(s.from).toBe(LATEST - 7 * DAY);
    expect(s.strategy).toEqual({ kind: "follow-wallets", wallets: ["alice", "bob"], latencyMs: 5000, positionQuote: "2500000000", takeProfitBps: 5000, stopLossBps: 2000, maxHoldMs: 7_200_000 });
    expect(s.costs).toEqual({ feeBps: 25, slippageBps: 150 });
  });
  it("uses raw units for a chain whose currency is not known", () => {
    expect(specOf({ positionSize: "1000" }, RAW_QUOTE).strategy.positionQuote).toBe("1000");
  });
  it("lists each wallet once, in the order typed", () => {
    expect(specOf({ wallets: "bob, alice\nbob" }).strategy.wallets).toEqual(["bob", "alice"]);
  });
  it("treats an empty take-profit or stop-loss as none, also when it is only spaces", () => {
    const s = specOf({ takeProfitPct: "  ", stopLossPct: "" });
    expect(s.strategy.takeProfitBps).toBeNull();
    expect(s.strategy.stopLossBps).toBeNull();
  });
  it("does not change the form it is given", () => {
    const f = form({ wallets: "bob alice bob" });
    const copy = JSON.stringify(f);
    buildSpec(f, LATEST, SOL);
    expect(JSON.stringify(f)).toBe(copy);
  });
  it("uses the clamped window for all data", () => {
    expect(specOf({ span: "all" }).from).toBe(LATEST - FIVE_YEARS);
  });
  it("always makes a spec the engine's own checker accepts", () => {
    const variants: Partial<BacktestForm>[] = [
      {}, { span: "1d" }, { span: "all" }, { delaySeconds: "86400" }, { maxHoldHours: "720" }, { maxHoldHours: "1" }, { feePct: "10" }, { feePct: "0" }, { slippagePct: "50" },
      { slippagePct: "0" }, { takeProfitPct: "10000" }, { takeProfitPct: "0.01" }, { stopLossPct: "99.99" }, { stopLossPct: "0.01" }, { positionSize: "0.000000001" },
      { positionSize: "999999999999999999999999999999" }, { wallets: Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ") }, { wallets: "x".repeat(128) },
    ];
    for (const v of variants) {
      const s = specOf(v);
      expect(() => parseBacktestSpec(s), JSON.stringify(v)).not.toThrow();
      expect(parseBacktestSpec(s)).toEqual(s);
    }
  });
});

describe("buildSpec: what it refuses, with a message for the field", () => {
  it("names a form with no wallet", () => {
    expect(errorsOf({ wallets: "" })).toEqual({ wallets: "Enter at least one wallet address." });
    expect(errorsOf({ wallets: " , ;\n" })).toEqual({ wallets: "Enter at least one wallet address." });
  });
  it("allows 100 wallets and refuses 101", () => {
    expect(errorsOf({ wallets: Array.from({ length: 101 }, (_, i) => `w${i}`).join(" ") })).toEqual({ wallets: "Use at most 100 wallets (you entered 101)." });
  });
  it("refuses an address the engine would refuse, naming its number but not repeating it", () => {
    expect(errorsOf({ wallets: "alice bób" })).toEqual({ wallets: "Wallet number 2 is not a valid address." });
    expect(errorsOf({ wallets: "x".repeat(129) })).toEqual({ wallets: "Wallet number 1 is not a valid address." });
    expect(errorsOf({ wallets: "ok a\u0000b" })).toEqual({ wallets: "Wallet number 2 is not a valid address." });
  });
  it("refuses a delay that is not whole seconds from 0 to 86,400", () => {
    const message = "Enter a whole number of seconds from 0 to 86,400.";
    for (const t of ["", "x", "-1", "1.5", "1e3", "86401", "999999999999999999999"]) expect(errorsOf({ delaySeconds: t }), t).toEqual({ delaySeconds: message });
    expect(specOf({ delaySeconds: "86400" }).strategy.latencyMs).toBe(86_400_000);
    expect(specOf({ delaySeconds: " 7 " }).strategy.latencyMs).toBe(7000);
  });
  it("refuses a position size with the reason", () => {
    expect(errorsOf({ positionSize: "" })).toEqual({ positionSize: "Enter an amount such as 0.5, with a dot for decimals." });
    expect(errorsOf({ positionSize: "1,5" })).toEqual({ positionSize: "Enter an amount such as 0.5, with a dot for decimals." });
    expect(errorsOf({ positionSize: "0" })).toEqual({ positionSize: "Must be more than 0." });
    expect(errorsOf({ positionSize: "0.0000000001" })).toEqual({ positionSize: "Use at most 9 decimal places." });
    expect(errorsOf({ positionSize: "1" + "0".repeat(30) })).toEqual({ positionSize: "That amount is too large." });
  });
  it("asks for a whole number when the currency has no decimals", () => {
    expect(errorsOf({ positionSize: "1.5" }, RAW_QUOTE)).toEqual({ positionSize: "Use a whole number." });
  });
  it("refuses a take-profit with the reason, and allows up to 10,000%", () => {
    expect(errorsOf({ takeProfitPct: "x" })).toEqual({ takeProfitPct: "Enter a percentage such as 50, or leave it empty." });
    expect(errorsOf({ takeProfitPct: "1.234" })).toEqual({ takeProfitPct: "Use at most 2 decimal places." });
    expect(errorsOf({ takeProfitPct: "0" })).toEqual({ takeProfitPct: "Must be more than 0, or leave it empty." });
    expect(errorsOf({ takeProfitPct: "10000.01" })).toEqual({ takeProfitPct: "At most 10,000%." });
    expect(errorsOf({ takeProfitPct: "9999999999" })).toEqual({ takeProfitPct: "At most 10,000%." });
    expect(specOf({ takeProfitPct: "10000" }).strategy.takeProfitBps).toBe(1_000_000);
  });
  it("refuses a stop-loss with the reason, and allows up to 99.99%", () => {
    expect(errorsOf({ stopLossPct: "x" })).toEqual({ stopLossPct: "Enter a percentage such as 20, or leave it empty." });
    expect(errorsOf({ stopLossPct: "1.234" })).toEqual({ stopLossPct: "Use at most 2 decimal places." });
    expect(errorsOf({ stopLossPct: "0" })).toEqual({ stopLossPct: "Must be more than 0, or leave it empty." });
    expect(errorsOf({ stopLossPct: "100" })).toEqual({ stopLossPct: "Must be less than 100%." });
    expect(errorsOf({ stopLossPct: "9999999999" })).toEqual({ stopLossPct: "Must be less than 100%." });
    expect(specOf({ stopLossPct: "99.99" }).strategy.stopLossBps).toBe(9999);
  });
  it("refuses a hold time that is not whole hours from 1 to 720", () => {
    const message = "Enter a whole number of hours from 1 to 720.";
    for (const t of ["", "x", "0", "-1", "1.5", "721"]) expect(errorsOf({ maxHoldHours: t }), t).toEqual({ maxHoldHours: message });
    expect(specOf({ maxHoldHours: "720" }).strategy.maxHoldMs).toBe(2_592_000_000);
    expect(specOf({ maxHoldHours: "1" }).strategy.maxHoldMs).toBe(3_600_000);
  });
  it("refuses a fee above 10% and a slippage above 50%", () => {
    expect(errorsOf({ feePct: "x" })).toEqual({ feePct: "Enter a percentage such as 0.3." });
    expect(errorsOf({ feePct: "0.123" })).toEqual({ feePct: "Use at most 2 decimal places." });
    expect(errorsOf({ feePct: "10.01" })).toEqual({ feePct: "Enter a percentage from 0 to 10." });
    expect(errorsOf({ feePct: "9999999999" })).toEqual({ feePct: "Enter a percentage from 0 to 10." });
    expect(errorsOf({ slippagePct: "x" })).toEqual({ slippagePct: "Enter a percentage such as 1." });
    expect(errorsOf({ slippagePct: "0.123" })).toEqual({ slippagePct: "Use at most 2 decimal places." });
    expect(errorsOf({ slippagePct: "50.01" })).toEqual({ slippagePct: "Enter a percentage from 0 to 50." });
    expect(specOf({ feePct: "10", slippagePct: "50" }).costs).toEqual({ feeBps: 1000, slippageBps: 5000 });
    expect(specOf({ feePct: "0", slippagePct: "0" }).costs).toEqual({ feeBps: 0, slippageBps: 0 });
  });
  it("reports every wrong field at once", () => {
    expect(errorsOf({ wallets: "", delaySeconds: "x", positionSize: "0", takeProfitPct: "0", stopLossPct: "100", maxHoldHours: "0", feePct: "11", slippagePct: "51" })).toEqual({
      wallets: "Enter at least one wallet address.",
      delaySeconds: "Enter a whole number of seconds from 0 to 86,400.",
      positionSize: "Must be more than 0.",
      takeProfitPct: "Must be more than 0, or leave it empty.",
      stopLossPct: "Must be less than 100%.",
      maxHoldHours: "Enter a whole number of hours from 1 to 720.",
      feePct: "Enter a percentage from 0 to 10.",
      slippagePct: "Enter a percentage from 0 to 50.",
    });
  });
});

describe("reduceRun", () => {
  const idle: RunState = { phase: "idle" };
  const running: RunState = { phase: "running", since: 1000, cancelling: false };
  const cancelling: RunState = { phase: "running", since: 1000, cancelling: true };
  const report = { engineVersion: "1.0.0" } as unknown as BacktestReport;
  const good = { type: "finished", result: { state: "ok", data: report } } as const;
  const bad = { type: "finished", result: { state: "error", message: "the engine stopped unexpectedly" } } as const;

  it("starts from any state that is not running, remembering when", () => {
    for (const from of [idle, { phase: "done", report }, { phase: "failed", message: "x" }, { phase: "cancelled" }] as RunState[]) {
      expect(reduceRun(from, { type: "start", at: 5000 }), from.phase).toEqual({ phase: "running", since: 5000, cancelling: false });
    }
  });
  it("ignores a start while running", () => {
    expect(reduceRun(running, { type: "start", at: 9000 })).toBe(running);
    expect(reduceRun(cancelling, { type: "start", at: 9000 })).toBe(cancelling);
  });
  it("marks a running backtest as being cancelled, once", () => {
    expect(reduceRun(running, { type: "cancel" })).toEqual({ phase: "running", since: 1000, cancelling: true });
    expect(reduceRun(cancelling, { type: "cancel" })).toBe(cancelling);
  });
  it("ignores a cancel when nothing runs", () => {
    for (const s of [idle, { phase: "done", report }, { phase: "failed", message: "x" }, { phase: "cancelled" }] as RunState[]) expect(reduceRun(s, { type: "cancel" }), s.phase).toBe(s);
  });
  it("shows the report when the run finishes well, even if a cancel was asked for meanwhile", () => {
    expect(reduceRun(running, good)).toEqual({ phase: "done", report });
    expect(reduceRun(cancelling, good)).toEqual({ phase: "done", report });
  });
  it("shows the reason when it fails, and 'cancelled' when the failure follows a cancel", () => {
    expect(reduceRun(running, bad)).toEqual({ phase: "failed", message: "the engine stopped unexpectedly" });
    expect(reduceRun(cancelling, bad)).toEqual({ phase: "cancelled" });
  });
  it("ignores an answer that arrives when nothing is running", () => {
    for (const s of [idle, { phase: "done", report }, { phase: "failed", message: "x" }, { phase: "cancelled" }] as RunState[]) {
      expect(reduceRun(s, good), s.phase).toBe(s);
      expect(reduceRun(s, bad), s.phase).toBe(s);
    }
  });
});

describe("checkNote", () => {
  it("says what an update check found, in words", () => {
    expect(checkNote({ kind: "up-to-date", version: "1.0.0" })).toBe("You have the latest engine (1.0.0).");
    expect(checkNote({ kind: "older", latest: "0.9.0", current: "1.0.0" })).toBe("The newest published engine (0.9.0) is older than yours (1.0.0); nothing to do.");
    expect(checkNote({ kind: "available", version: "1.2.0" })).toBe("Version 1.2.0 is available.");
  });
});

describe("blockedReason", () => {
  const status: EngineStatusInfo = { installed: "1.0.0", running: false, busy: false, problem: null, canUpdate: true, offered: null };
  it("is null when a backtest can start", () => {
    expect(blockedReason(status, null, null)).toBeNull();
    expect(blockedReason({ ...status, running: true }, null, null)).toBeNull();
    expect(blockedReason({ ...status, problem: "the engine was stopped after a failed run: x" }, null, null)).toBeNull();
  });
  it("waits for the engine's state, or says it could not be read", () => {
    expect(blockedReason(null, null, null)).toBe("Waiting for the engine's state.");
    expect(blockedReason(null, "request failed", null)).toBe("The engine's state could not be read.");
  });
  it("says when there is no engine", () => {
    expect(blockedReason({ ...status, installed: null }, null, null)).toBe("No engine is installed, so a backtest cannot run.");
  });
  it("says when the engine is being updated or already busy", () => {
    expect(blockedReason(status, null, "installing")).toBe("The engine is being updated.");
    expect(blockedReason(status, null, "checking")).toBeNull();
    expect(blockedReason({ ...status, busy: true }, null, null)).toBe("A backtest is already running.");
  });
  it("gives the most basic reason first", () => {
    expect(blockedReason({ ...status, installed: null, busy: true }, null, "installing")).toBe("No engine is installed, so a backtest cannot run.");
    expect(blockedReason({ ...status, busy: true }, null, "installing")).toBe("The engine is being updated.");
  });
});
