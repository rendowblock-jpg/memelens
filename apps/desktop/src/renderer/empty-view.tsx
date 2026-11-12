import type { ReactElement } from "react";
import type { SampleState } from "./empty";

/** What a person sees on a copy of MemeLens that has no data: what is missing, why, and one button that makes it usable. */
export function EmptyDatabase({ state, onLoad }: { state: SampleState; onLoad(): void }): ReactElement {
  const busy = state.phase === "loading" || state.phase === "loaded";
  return (
    <div className="empty" data-testid="empty-state">
      <h2>No data yet</h2>
      <p className="muted">
        This copy of MemeLens has no data. A real-data adapter is not built yet. To look around, load a small made-up sample: every screen marks it as SYNTHETIC DATA, and
        nothing in it is real.
      </p>
      <p>
        <button type="button" className="primary" onClick={onLoad} disabled={busy}>
          {state.phase === "loading" ? "Loading…" : state.phase === "loaded" ? "Opening the sample…" : "Load the sample data"}
        </button>
      </p>
      {state.phase === "failed" ? (
        <p className="error" role="alert">
          {`Could not load the sample: ${state.message}`}
        </p>
      ) : null}
      <details>
        <summary>From a source checkout</summary>
        <pre>npm run memelens -- ingest packages/data/fixtures/sample.json --db &lt;your database&gt;</pre>
      </details>
    </div>
  );
}
