import type { ReactElement } from "react";
import type { EngineStatusInfo } from "@memelens/service";
import type { BacktestReport, ExitReason } from "@memelens/sidecar";
import type { BacktestForm, FormErrors, FormField, RunState } from "./backtest";
import { countOf, formatSignedPercent, formatTime, formatUnits, shortAddress } from "./format";
import type { SmartSpan } from "./model";
import type { Quote } from "./quote";
import { Money } from "./screens";

// Presentational parts of the backtest screen: state in, markup out. The state itself lives in the shell (BacktestScreen).

export const MAX_POSITION_ROWS = 50;
export const EXIT_LABELS: Record<ExitReason, string> = { takeProfit: "Take profit", stopLoss: "Stop loss", maxHold: "Max hold", end: "End of data" };
export const BACKTEST_SPANS: readonly { span: SmartSpan; label: string }[] = [
  { span: "1d", label: "24 hours" },
  { span: "7d", label: "7 days" },
  { span: "30d", label: "30 days" },
  { span: "all", label: "All data (up to 5 years)" },
];

// ---------------------------------------------------------------------------------------------------- the engine

export interface EnginePanelProps {
  /** null while the first answer is awaited. */
  status: EngineStatusInfo | null;
  loadError: string | null;
  working: "checking" | "installing" | null;
  note: string | null;
  onCheck(): void;
  onInstall(): void;
}

export function EnginePanel({ status, loadError, working, note, onCheck, onInstall }: EnginePanelProps): ReactElement {
  return (
    <section className="engine-panel" aria-label="Backtest engine">
      <h2>Backtest engine</h2>
      {status === null && loadError === null ? <p className="muted" role="status">Checking the engine…</p> : null}
      {loadError !== null ? <p className="error" role="alert">{`Could not read the engine's state: ${loadError}`}</p> : null}
      {status === null ? null : (
        <>
          <p className="engine-state" data-testid="engine-state">
            {status.installed === null ? "No engine is installed" : `Engine ${status.installed} is installed · ${status.busy ? "running a backtest" : status.running ? "running" : "idle"}`}
          </p>
          {status.installed === null ? (
            <p className="muted">{status.canUpdate ? "Use Check for update to download one." : "This build has no source for engine updates yet, so backtests cannot run."}</p>
          ) : null}
          {status.problem === null ? null : <p className="error" role="alert">{status.problem}</p>}
          {status.canUpdate ? (
            <div className="engine-actions">
              <button type="button" onClick={onCheck} disabled={working !== null || status.busy}>
                {working === "checking" ? "Checking…" : "Check for update"}
              </button>
              {status.offered === null ? null : (
                <button type="button" className="primary" onClick={onInstall} disabled={working !== null || status.busy}>
                  {working === "installing" ? "Installing…" : `Install version ${status.offered}`}
                </button>
              )}
            </div>
          ) : null}
        </>
      )}
      {note === null ? null : <p className="muted" role="status">{note}</p>}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------- the form

export interface FormViewProps {
  form: BacktestForm;
  errors: FormErrors;
  quote: Quote;
  /** Why the run button is off (no engine, no data), or null. */
  blockedReason: string | null;
  run: RunState;
  onChange(field: FormField, value: string): void;
  onSpan(span: SmartSpan): void;
  onRun(): void;
  onCancel(): void;
}

interface FieldDef {
  field: Exclude<FormField, "wallets">;
  label: (q: Quote) => string;
  hint: string;
}

const FIELDS: readonly FieldDef[] = [
  { field: "delaySeconds", label: () => "Delay before copying (seconds)", hint: "How long after the wallet's trade we would have acted." },
  { field: "positionSize", label: (q) => `Position size (${q.symbol})`, hint: "How much each copied trade buys." },
  { field: "takeProfitPct", label: () => "Take profit (%)", hint: "Optional. Sell when the price is this far above the entry." },
  { field: "stopLossPct", label: () => "Stop loss (%)", hint: "Optional. Sell when the price is this far below the entry." },
  { field: "maxHoldHours", label: () => "Longest hold (hours)", hint: "Sell after this long if neither limit was hit." },
  { field: "feePct", label: () => "Fee (%)", hint: "Charged on every buy and every sell." },
  { field: "slippagePct", label: () => "Slippage (%)", hint: "Price moving against us on every fill." },
];

export function BacktestFormView({ form, errors, quote, blockedReason, run, onChange, onSpan, onRun, onCancel }: FormViewProps): ReactElement {
  const running = run.phase === "running";
  const cancelling = run.phase === "running" && run.cancelling;

  const describe = (field: FormField): { "aria-invalid"?: true; "aria-describedby"?: string } =>
    errors[field] === undefined ? {} : { "aria-invalid": true, "aria-describedby": `bt-${field}-error` };
  const error = (field: FormField): ReactElement | null =>
    errors[field] === undefined ? null : <p className="field-error" id={`bt-${field}-error`} role="alert">{errors[field]}</p>;

  return (
    <form
      className="bt-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!running && blockedReason === null) onRun();
      }}
    >
      <fieldset disabled={running}>
        <legend>Follow chosen wallets</legend>
        <div className="field wide">
          <label htmlFor="bt-wallets">Wallets to follow</label>
          <textarea
            id="bt-wallets"
            rows={4}
            spellCheck={false}
            autoComplete="off"
            value={form.wallets}
            disabled={running}
            onChange={(e) => onChange("wallets", e.target.value)}
            {...describe("wallets")}
          />
          <p className="hint">One address per line, or separated by commas. Up to 100.</p>
          {error("wallets")}
        </div>
        <div className="field wide">
          <span className="label" id="bt-span-label">Period</span>
          <div className="segmented" role="group" aria-labelledby="bt-span-label">
            {BACKTEST_SPANS.map((s) => (
              <button key={s.span} type="button" aria-pressed={s.span === form.span} onClick={() => onSpan(s.span)} disabled={running}>
                {s.label}
              </button>
            ))}
          </div>
          <p className="hint">Ends at the newest recorded trade, not at today's date.</p>
        </div>
        {FIELDS.map((f) => (
          <div className="field" key={f.field}>
            <label htmlFor={`bt-${f.field}`}>{f.label(quote)}</label>
            <input
              id={`bt-${f.field}`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={form[f.field]}
              disabled={running}
              onChange={(e) => onChange(f.field, e.target.value)}
              {...describe(f.field)}
            />
            <p className="hint">{f.hint}</p>
            {error(f.field)}
          </div>
        ))}
      </fieldset>
      <div className="bt-actions">
        {running ? (
          <button type="button" onClick={onCancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        ) : (
          <button type="submit" className="primary" disabled={blockedReason !== null}>
            Run backtest
          </button>
        )}
        {blockedReason === null ? null : <p className="muted">{blockedReason}</p>}
      </div>
    </form>
  );
}

// ----------------------------------------------------------------------------------------------------- the result

export function BacktestResult({ report, quote }: { report: BacktestReport; quote: Quote }): ReactElement {
  const s = report.summary;
  const amount = (raw: string): string => `${formatUnits(raw, quote.decimals)} ${quote.symbol}`;
  const exits = (Object.keys(EXIT_LABELS) as ExitReason[]).map((reason) => `${EXIT_LABELS[reason]} ${s.exits[reason]}`).join(" · ");
  const rows: readonly (readonly [string, string])[] = [
    ["Signals from the chosen wallets", String(s.signals)],
    ["Entered", String(s.entered)],
    ["Ignored while a position was open", String(s.ignoredWhileOpen)],
    ["Skipped: no later price", String(s.skipped.noPrice)],
    ["Skipped: amount too small", String(s.skipped.tooSmall)],
    ["Winning positions", String(s.wins)],
    ["Losing positions", String(s.losses)],
    ["Exits", exits],
    ["Total spent (with fees)", amount(s.totalCost)],
    ["Total received (after fees)", amount(s.totalNet)],
  ];
  const shown = report.positions.slice(0, MAX_POSITION_ROWS);

  return (
    <section className="bt-result" aria-label="Backtest result">
      <h2>Result</h2>
      <p className="muted bt-note">
        {`A replay of recorded trades, not a forecast. Each entry is priced at the token's next recorded trade after your delay, plus the slippage you chose. Engine ${report.engineVersion}${
          report.dataAsOf === null ? "" : ` · Data up to ${formatTime(report.dataAsOf)}`
        }.`}
      </p>
      {report.positions.length === 0 ? (
        <p className="bt-empty" data-testid="bt-empty">
          No trade was entered. None of the chosen wallets bought in this period, or every signal was skipped. Check the wallet addresses and the period.
        </p>
      ) : null}
      <dl className="totals">
        <div className="total"><dt>Result</dt><dd><Money raw={s.realised} quote={quote} /></dd></div>
        <div className="total"><dt>Return on cost</dt><dd>{formatSignedPercent(s.roiBps === null ? null : s.roiBps / 10_000)}</dd></div>
        <div className="total"><dt>Positions</dt><dd>{countOf(s.entered, "position")}</dd></div>
      </dl>
      <table className="bt-summary" aria-label="Backtest summary">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.positions.length === 0 ? null : (
        <>
          <table className="bt-positions" aria-label="Backtest positions">
            <thead>
              <tr>
                <th>Token</th>
                <th>Wallet</th>
                <th>Entered</th>
                <th>Exited</th>
                <th>Reason</th>
                <th>Spent</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => (
                <tr key={`${p.entryTradeId}-${i}`}>
                  <td className="addr">{shortAddress(p.token)}</td>
                  <td className="addr">{shortAddress(p.signalWallet)}</td>
                  <td><time>{formatTime(p.entryTime)}</time></td>
                  <td><time>{formatTime(p.exitTime)}</time></td>
                  <td>{EXIT_LABELS[p.exitReason]}</td>
                  <td>{amount(p.cost)}</td>
                  <td><Money raw={p.pnl} quote={quote} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.positions.length > shown.length ? <p className="muted">{`Showing the first ${shown.length} of ${countOf(report.positions.length, "position")}.`}</p> : null}
        </>
      )}
    </section>
  );
}
