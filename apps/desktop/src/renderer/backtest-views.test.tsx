import { renderToStaticMarkup } from "react-dom/server";
import type { EngineStatusInfo } from "@memelens/service";
import type { BacktestReport, Position } from "@memelens/sidecar";
import { describe, expect, it } from "vitest";
import { DEFAULT_FORM, type BacktestForm, type FormErrors, type RunState } from "./backtest";
import { BacktestFormView, BacktestResult, EnginePanel, MAX_POSITION_ROWS, type EnginePanelProps, type FormViewProps } from "./backtest-views";
import { quoteFor, RAW_QUOTE } from "./quote";

const SOL = quoteFor("solana");
const noop = (): void => {};

function plain(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function cellsOf(rowHtml: string): string[] {
  return rowHtml.split(/<\/t[dh]>/).filter((c) => c.trim() !== "").map(plain);
}
function table(markup: string, label: string): { head: string[]; rows: string[][] } {
  const t = new RegExp(`<table[^>]*aria-label="${label}"[^>]*>(.*?)</table>`, "s").exec(markup);
  if (t === null) throw new Error(`no table "${label}"`);
  const head = /<thead>(.*?)<\/thead>/s.exec(t[1]!);
  const body = /<tbody>(.*?)<\/tbody>/s.exec(t[1]!);
  return {
    head: head === null ? [] : cellsOf(/<tr[^>]*>(.*?)<\/tr>/s.exec(head[1]!)![1]!),
    rows: body === null ? [] : [...body[1]!.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((m) => cellsOf(m[1]!)),
  };
}
/** The attributes of the element with this id, and (for a textarea) its text. */
function control(markup: string, id: string): Record<string, string> | null {
  const m = new RegExp(`<(input|textarea|button)([^>]*\\bid="${id}"[^>]*)>(?:([^<]*)</textarea>)?`).exec(markup);
  if (m === null) return null;
  const attrs: Record<string, string> = { tag: m[1]! };
  for (const a of m[2]!.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[1]!.toLowerCase()] = (a[2] ?? "").replace(/&quot;/g, '"'); // React may write camelCase names such as autoComplete
  if (m[3] !== undefined) attrs["text"] = m[3];
  return attrs;
}
function buttonByText(markup: string, text: string): { disabled: boolean } | null {
  for (const m of markup.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)) {
    if (plain(m[2]!) === text) return { disabled: /\bdisabled(=|\s|$)/.test(m[1]!) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------- EnginePanel
const STATUS: EngineStatusInfo = { installed: "1.0.0", running: false, busy: false, problem: null, canUpdate: true, offered: null };
function panel(over: Partial<EnginePanelProps> = {}): string {
  return renderToStaticMarkup(<EnginePanel status={STATUS} loadError={null} working={null} note={null} onCheck={noop} onInstall={noop} {...over} />);
}

describe("EnginePanel", () => {
  it("says it is waiting for the first answer", () => {
    const html = panel({ status: null });
    expect(plain(html)).toContain("Checking the engine…");
    expect(html).toContain('role="status"');
    expect(buttonByText(html, "Check for update")).toBeNull();
  });
  it("shows a failure to read the state as an alert", () => {
    const html = panel({ status: null, loadError: "request failed" });
    expect(plain(html)).toContain("Could not read the engine's state: request failed");
    expect(html).toMatch(/role="alert"[^>]*>[^<]*Could not read/);
  });
  it("names the installed version and whether it is running", () => {
    expect(plain(panel())).toContain("Engine 1.0.0 is installed · idle");
    expect(plain(panel({ status: { ...STATUS, running: true } }))).toContain("Engine 1.0.0 is installed · running");
    expect(plain(panel({ status: { ...STATUS, running: true, busy: true } }))).toContain("Engine 1.0.0 is installed · running a backtest");
  });
  it("says no engine is installed and what to do about it", () => {
    const withSource = plain(panel({ status: { ...STATUS, installed: null } }));
    expect(withSource).toContain("No engine is installed");
    expect(withSource).toContain("Use Check for update to download one.");
    const without = plain(panel({ status: { ...STATUS, installed: null, canUpdate: false } }));
    expect(without).toContain("No engine is installed");
    expect(without).toContain("This build has no source for engine updates yet, so backtests cannot run.");
    expect(without).not.toContain("Use Check for update");
  });
  it("shows a problem the engine reported as an alert", () => {
    const html = panel({ status: { ...STATUS, installed: null, problem: "LOCALAPPDATA is not set to an absolute path" } });
    expect(html).toMatch(/role="alert"[^>]*>[^<]*LOCALAPPDATA is not set to an absolute path/);
    expect(panel()).not.toContain('role="alert"');
  });
  it("offers the check only when this build can update, and not while something is happening", () => {
    expect(buttonByText(panel(), "Check for update")).toEqual({ disabled: false });
    expect(buttonByText(panel({ status: { ...STATUS, canUpdate: false } }), "Check for update")).toBeNull();
    expect(buttonByText(panel({ status: { ...STATUS, busy: true } }), "Check for update")).toEqual({ disabled: true });
    expect(buttonByText(panel({ working: "checking" }), "Checking…")).toEqual({ disabled: true });
    expect(buttonByText(panel({ working: "installing" }), "Check for update")).toEqual({ disabled: true });
  });
  it("offers the install only when a version is on offer", () => {
    expect(panel()).not.toContain("Install version");
    const offered = { ...STATUS, offered: "1.2.0" };
    expect(buttonByText(panel({ status: offered }), "Install version 1.2.0")).toEqual({ disabled: false });
    expect(buttonByText(panel({ status: { ...offered, busy: true } }), "Install version 1.2.0")).toEqual({ disabled: true });
    expect(buttonByText(panel({ status: offered, working: "checking" }), "Install version 1.2.0")).toEqual({ disabled: true });
    expect(buttonByText(panel({ status: offered, working: "installing" }), "Installing…")).toEqual({ disabled: true });
  });
  it("shows the note from the last check or install", () => {
    const html = panel({ note: "You have the latest engine (1.0.0)." });
    expect(plain(html)).toContain("You have the latest engine (1.0.0).");
    expect(plain(panel())).not.toContain("latest engine");
  });
});

// ------------------------------------------------------------------------------------------------ BacktestFormView
const IDLE: RunState = { phase: "idle" };
function formView(over: Partial<FormViewProps> = {}, form: Partial<BacktestForm> = {}, errors: FormErrors = {}): string {
  return renderToStaticMarkup(
    <BacktestFormView form={{ ...DEFAULT_FORM, ...form }} errors={errors} quote={SOL} blockedReason={null} run={IDLE} onChange={noop} onSpan={noop} onRun={noop} onCancel={noop} {...over} />,
  );
}

describe("BacktestFormView", () => {
  it("labels every field, with the currency where an amount is asked for", () => {
    const html = plain(formView());
    for (const label of ["Wallets to follow", "Period", "Delay before copying (seconds)", "Position size (SOL)", "Take profit (%)", "Stop loss (%)", "Longest hold (hours)", "Fee (%)", "Slippage (%)"]) {
      expect(html, label).toContain(label);
    }
    expect(plain(formView({ quote: RAW_QUOTE }))).toContain("Position size (raw units)");
  });
  it("ties each label to its control", () => {
    const html = formView();
    for (const [id, text] of [["bt-wallets", "Wallets to follow"], ["bt-delaySeconds", "Delay before copying (seconds)"], ["bt-positionSize", "Position size (SOL)"], ["bt-takeProfitPct", "Take profit (%)"], ["bt-stopLossPct", "Stop loss (%)"], ["bt-maxHoldHours", "Longest hold (hours)"], ["bt-feePct", "Fee (%)"], ["bt-slippagePct", "Slippage (%)"]] as const) {
      expect(html, id).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>${text.replace(/[()]/g, "\\$&")}</label>`));
      expect(control(html, id), id).not.toBeNull();
    }
  });
  it("puts the form's text in the controls", () => {
    const html = formView({}, { wallets: "alice\nbob", delaySeconds: "3", positionSize: "0.25", takeProfitPct: "50", stopLossPct: "20", maxHoldHours: "6", feePct: "0.5", slippagePct: "2" });
    expect(control(html, "bt-wallets")?.["text"]).toBe("alice\nbob");
    expect(control(html, "bt-delaySeconds")?.["value"]).toBe("3");
    expect(control(html, "bt-positionSize")?.["value"]).toBe("0.25");
    expect(control(html, "bt-takeProfitPct")?.["value"]).toBe("50");
    expect(control(html, "bt-stopLossPct")?.["value"]).toBe("20");
    expect(control(html, "bt-maxHoldHours")?.["value"]).toBe("6");
    expect(control(html, "bt-feePct")?.["value"]).toBe("0.5");
    expect(control(html, "bt-slippagePct")?.["value"]).toBe("2");
  });
  it("does not let the browser correct addresses", () => {
    const wallets = control(formView(), "bt-wallets")!;
    expect(wallets["spellcheck"]).toBe("false");
    expect(wallets["autocomplete"]).toBe("off");
  });
  it("marks the chosen period", () => {
    const html = formView({}, { span: "7d" });
    const pressed = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/gs)].map((m) => [plain(m[2]!), m[1]]);
    expect(pressed).toEqual([["24 hours", "false"], ["7 days", "true"], ["30 days", "false"], ["All data (up to 5 years)", "false"]]);
  });
  it("shows a message beside each wrong field and marks only those fields invalid", () => {
    const html = formView({}, {}, { wallets: "Enter at least one wallet address.", feePct: "Enter a percentage from 0 to 10." });
    expect(html).toMatch(/<p[^>]*id="bt-wallets-error"[^>]*role="alert"[^>]*>Enter at least one wallet address\.<\/p>|<p[^>]*role="alert"[^>]*id="bt-wallets-error"[^>]*>Enter at least one wallet address\.<\/p>/);
    expect(control(html, "bt-wallets")).toMatchObject({ "aria-invalid": "true", "aria-describedby": "bt-wallets-error" });
    expect(control(html, "bt-feePct")).toMatchObject({ "aria-invalid": "true", "aria-describedby": "bt-feePct-error" });
    expect(control(html, "bt-slippagePct")?.["aria-invalid"]).toBeUndefined();
    expect(control(html, "bt-slippagePct")?.["aria-describedby"]).toBeUndefined();
    expect(html).not.toContain("bt-slippagePct-error");
  });
  it("has the run button on when nothing blocks it", () => {
    const html = formView();
    expect(buttonByText(html, "Run backtest")).toEqual({ disabled: false });
    expect(plain(html)).not.toContain("blocked");
  });
  it("turns the run button off and says why", () => {
    const html = formView({ blockedReason: "No engine is installed." });
    expect(buttonByText(html, "Run backtest")).toEqual({ disabled: true });
    expect(plain(html)).toContain("No engine is installed.");
  });
  it("while running: no run button, a cancel button, and the form cannot be edited", () => {
    const html = formView({ run: { phase: "running", since: 0, cancelling: false } });
    expect(buttonByText(html, "Run backtest")).toBeNull();
    expect(buttonByText(html, "Cancel")).toEqual({ disabled: false });
    for (const id of ["bt-wallets", "bt-delaySeconds", "bt-positionSize", "bt-takeProfitPct", "bt-stopLossPct", "bt-maxHoldHours", "bt-feePct", "bt-slippagePct"]) {
      expect(control(html, id)?.["disabled"], id).toBeDefined();
    }
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });
  it("shows the cancel as under way and cannot be pressed twice", () => {
    const html = formView({ run: { phase: "running", since: 0, cancelling: true } });
    expect(buttonByText(html, "Cancelling…")).toEqual({ disabled: true });
  });
  it("is editable again after a run has ended", () => {
    for (const run of [{ phase: "failed", message: "x" }, { phase: "cancelled" }] as RunState[]) {
      const html = formView({ run });
      expect(html, run.phase).not.toMatch(/<fieldset[^>]*disabled/);
      expect(buttonByText(html, "Run backtest")).toEqual({ disabled: false });
    }
  });
});

// ------------------------------------------------------------------------------------------------- BacktestResult
// Worked by hand. Seven positions entered, 7 SOL spent in all (1 SOL each), 7.35 SOL received after fees, so the result is
// +0.35 SOL, a return of 0.35 / 7 = 5.0% (500 basis points).
function position(over: Partial<Position> = {}): Position {
  return {
    token: "TOK1", signalTradeId: "s1", signalWallet: "alice", entryTradeId: "e1", entryTime: 1_700_000_000_000, entryAmount: "1000", buyFee: "3000000", cost: "1000000000",
    exitTradeId: "x1", exitTime: 1_700_003_600_000, exitReason: "takeProfit", proceeds: "1510000000", sellFee: "4530000", net: "1500000000", pnl: "500000000", ...over,
  };
}
function report(over: Partial<BacktestReport> = {}, summary: Partial<BacktestReport["summary"]> = {}): BacktestReport {
  return {
    engineVersion: "1.0.0",
    specHash: "h",
    dataAsOf: 1_700_020_700_000,
    positions: [position(), position({ token: "TOK2", signalWallet: "bob", exitReason: "stopLoss", net: "800000000", pnl: "-200000000", entryTime: 1_700_000_060_000, exitTime: 1_700_000_660_000 })],
    summary: {
      signals: 10, ignoredWhileOpen: 2, skipped: { noPrice: 1, tooSmall: 0 }, entered: 7, exits: { takeProfit: 3, stopLoss: 2, maxHold: 1, end: 1 }, wins: 4, losses: 3,
      totalCost: "7000000000", totalNet: "7350000000", realised: "350000000", roiBps: 500, ...summary,
    },
    ...over,
  };
}
const result = (r: BacktestReport, quote = SOL): string => renderToStaticMarkup(<BacktestResult report={r} quote={quote} />);

describe("BacktestResult: the summary", () => {
  it("shows every figure of the report, in words and in the chain's currency", () => {
    expect(table(result(report()), "Backtest summary").rows).toEqual([
      ["Signals from the chosen wallets", "10"],
      ["Entered", "7"],
      ["Ignored while a position was open", "2"],
      ["Skipped: no later price", "1"],
      ["Skipped: amount too small", "0"],
      ["Winning positions", "4"],
      ["Losing positions", "3"],
      ["Exits", "Take profit 3 · Stop loss 2 · Max hold 1 · End of data 1"],
      ["Total spent (with fees)", "7 SOL"],
      ["Total received (after fees)", "7.35 SOL"],
    ]);
  });
  it("leads with the result, its sign, and the return on cost", () => {
    const text = plain(result(report()));
    expect(text).toContain("Result +0.35 SOL");
    expect(text).toContain("Return on cost +5.0%");
    expect(text).toContain("7 positions");
    expect(result(report())).toMatch(/class="money gain"[^>]*>\+0\.35 SOL/);
  });
  it("shows a loss with its sign and the loss colour", () => {
    const html = result(report({}, { totalNet: "6650000000", realised: "-350000000", roiBps: -500 }));
    expect(plain(html)).toContain("Result -0.35 SOL");
    expect(plain(html)).toContain("Return on cost -5.0%");
    expect(html).toMatch(/class="money loss"[^>]*>-0\.35 SOL/);
  });
  it("shows a result of exactly zero without a sign", () => {
    const html = result(report({}, { totalNet: "7000000000", realised: "0", roiBps: 0 }));
    expect(plain(html)).toContain("Result 0 SOL");
    expect(plain(html)).toContain("Return on cost 0.0%");
    expect(html).toMatch(/class="money flat"/);
  });
  it("counts one position in the singular", () => {
    expect(plain(result(report({}, { entered: 1 })))).toContain("1 position");
    expect(plain(result(report({}, { entered: 1 })))).not.toContain("1 positions");
  });
  it("says how the replay is priced and which engine and data it used", () => {
    const text = plain(result(report()));
    expect(text).toContain("A replay of recorded trades, not a forecast.");
    expect(text).toContain("Engine 1.0.0");
    expect(text).toContain("Data up to 2023-11-15 03:58 UTC"); // 1,700,020,700,000 ms
    expect(plain(result(report({ dataAsOf: null })))).not.toContain("Data up to");
  });
  it("uses raw units when the currency is not known", () => {
    expect(table(result(report(), RAW_QUOTE), "Backtest summary").rows.slice(-2)).toEqual([["Total spent (with fees)", "7,000,000,000 raw units"], ["Total received (after fees)", "7,350,000,000 raw units"]]);
  });
});

describe("BacktestResult: the positions", () => {
  it("lists each position with who, when, why it ended and what it made", () => {
    const t = table(result(report()), "Backtest positions");
    expect(t.head).toEqual(["Token", "Wallet", "Entered", "Exited", "Reason", "Spent", "Result"]);
    expect(t.rows).toEqual([
      ["TOK1", "alice", "2023-11-14 22:13 UTC", "2023-11-14 23:13 UTC", "Take profit", "1 SOL", "+0.5 SOL"],
      ["TOK2", "bob", "2023-11-14 22:14 UTC", "2023-11-14 22:24 UTC", "Stop loss", "1 SOL", "-0.2 SOL"],
    ]);
  });
  it("shortens a long address", () => {
    const html = result(report({ positions: [position({ token: "So11111111111111111111111111111111111111112", signalWallet: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" })] }));
    expect(table(html, "Backtest positions").rows[0]!.slice(0, 2)).toEqual(["So11…1112", "9WzD…AWWM"]);
  });
  it("names every way a position can end", () => {
    const reasons = (["takeProfit", "stopLoss", "maxHold", "end"] as const).map((exitReason) => position({ exitReason }));
    expect(table(result(report({ positions: reasons })), "Backtest positions").rows.map((r) => r[4])).toEqual(["Take profit", "Stop loss", "Max hold", "End of data"]);
  });
  it("shows the first 50 and says how many there are", () => {
    expect(MAX_POSITION_ROWS).toBe(50);
    const many = Array.from({ length: 60 }, (_, i) => position({ token: `T${i}` }));
    const html = result(report({ positions: many }, { entered: 60 }));
    const rows = table(html, "Backtest positions").rows;
    expect(rows).toHaveLength(50);
    expect(rows[0]![0]).toBe("T0");
    expect(rows[49]![0]).toBe("T49");
    expect(plain(html)).toContain("Showing the first 50 of 60 positions.");
  });
  it("says nothing about a limit when everything is shown", () => {
    expect(plain(result(report({ positions: Array.from({ length: 50 }, () => position()) }, { entered: 50 })))).not.toContain("Showing the first");
    expect(plain(result(report()))).not.toContain("Showing the first");
  });
});

describe("BacktestResult: nothing entered", () => {
  const empty = (): string => result(report({ positions: [], dataAsOf: null }, { signals: 0, entered: 0, ignoredWhileOpen: 0, skipped: { noPrice: 0, tooSmall: 0 }, exits: { takeProfit: 0, stopLoss: 0, maxHold: 0, end: 0 }, wins: 0, losses: 0, totalCost: "0", totalNet: "0", realised: "0", roiBps: null }));
  it("says so, with the usual reason, instead of showing zeros as a result", () => {
    const html = empty();
    expect(html).toContain('data-testid="bt-empty"');
    expect(plain(html)).toContain("No trade was entered. None of the chosen wallets bought in this period, or every signal was skipped. Check the wallet addresses and the period.");
  });
  it("shows no return, a dash, and no positions table", () => {
    const html = empty();
    expect(plain(html)).toContain("Return on cost —");
    expect(html).not.toContain('aria-label="Backtest positions"');
  });
  it("does not say it when something was entered", () => {
    expect(result(report())).not.toContain("bt-empty");
  });
});
