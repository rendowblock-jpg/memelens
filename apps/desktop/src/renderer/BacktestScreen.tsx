import { useCallback, useEffect, useReducer, useRef, useState, type ReactElement } from "react";
import type { Api, EngineStatusInfo } from "@memelens/service";
import { blockedReason, buildSpec, checkNote, DEFAULT_FORM, reduceRun, type BacktestForm, type FormErrors, type FormField, type RunState } from "./backtest";
import { BacktestFormView, BacktestResult, EnginePanel } from "./backtest-views";
import { cancelEngineBacktest, checkEngineUpdate, installEngineUpdate, loadEngineStatus, runEngineBacktest } from "./controller";
import { formatAge } from "./format";
import type { SmartSpan } from "./model";
import type { Quote } from "./quote";

// The stateful shell of the backtest screen: it holds the form text, the run's life and the engine's state, and connects
// them to the window's api. What a form means (backtest.ts), what a reply means (controller.ts) and how each part looks
// (backtest-views.tsx) are separate and tested; this file only wires them together.

export function BacktestScreen({ api, chain, latest, quote }: { api: Api; chain: string; latest: number; quote: Quote }): ReactElement {
  const [form, setForm] = useState<BacktestForm>(DEFAULT_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [run, dispatch] = useReducer(reduceRun, { phase: "idle" } as RunState);
  const [status, setStatus] = useState<EngineStatusInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [working, setWorking] = useState<"checking" | "installing" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const r = await loadEngineStatus(api);
    if (!alive.current) return;
    if (r.state === "ok") {
      setStatus(r.data);
      setLoadError(null);
    } else {
      setLoadError(r.message);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A clock for "running for 12s", only while a run is going.
  useEffect(() => {
    if (run.phase !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.phase]);

  const onChange = (field: FormField, value: string): void => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => (e[field] === undefined ? e : { ...e, [field]: undefined }));
  };
  const onSpan = (span: SmartSpan): void => setForm((f) => ({ ...f, span }));

  const onRun = (): void => {
    if (run.phase === "running") return;
    const built = buildSpec(form, latest, quote);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    dispatch({ type: "start", at: Date.now() });
    void runEngineBacktest(api, built.spec, chain).then((result) => {
      if (!alive.current) return;
      dispatch({ type: "finished", result });
      void refresh();
    });
  };
  const onCancel = (): void => {
    dispatch({ type: "cancel" });
    void cancelEngineBacktest(api);
  };

  const onCheck = (): void => {
    setWorking("checking");
    setNote(null);
    void checkEngineUpdate(api).then(async (r) => {
      if (!alive.current) return;
      setNote(r.state === "ok" ? checkNote(r.data) : r.message);
      setWorking(null);
      await refresh();
    });
  };
  const onInstall = (): void => {
    setWorking("installing");
    setNote(null);
    void installEngineUpdate(api).then(async (r) => {
      if (!alive.current) return;
      setNote(r.state === "ok" ? `Installed engine ${r.data.version}.` : r.message);
      setWorking(null);
      await refresh();
    });
  };

  return (
    <div className="bt">
      <EnginePanel status={status} loadError={loadError} working={working} note={note} onCheck={onCheck} onInstall={onInstall} />
      <BacktestFormView
        form={form}
        errors={errors}
        quote={quote}
        blockedReason={blockedReason(status, loadError, working)}
        run={run}
        onChange={onChange}
        onSpan={onSpan}
        onRun={onRun}
        onCancel={onCancel}
      />
      {run.phase === "running" ? (
        <p className="muted" role="status" data-testid="bt-running">{run.cancelling ? "Cancelling…" : `Running for ${formatAge(Math.max(0, now - run.since))}…`}</p>
      ) : null}
      {run.phase === "failed" ? <p className="error" role="alert">{`The backtest did not finish: ${run.message}`}</p> : null}
      {run.phase === "cancelled" ? <p className="muted" role="status">The backtest was cancelled.</p> : null}
      {run.phase === "done" ? <BacktestResult report={run.report} quote={quote} /> : null}
    </div>
  );
}
