import { useEffect, useReducer, useRef, type ReactElement } from "react";
import type { Api } from "@memelens/service";
import { loadSampleData } from "./controller";
import { reduceSample } from "./empty";
import { EmptyDatabase } from "./empty-view";

// The stateful shell of the empty screen: it holds the button's state and connects it to the window's api. What the button's
// life is (empty.ts) and how it looks (empty-view.tsx) are separate and tested; this file only wires them together.

export function EmptyDatabaseScreen({ api, onLoaded }: { api: Api; onLoaded(): void }): ReactElement {
  const [state, dispatch] = useReducer(reduceSample, { phase: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = (): void => {
    if (state.phase === "loading" || state.phase === "loaded") return;
    dispatch({ type: "click" });
    void loadSampleData(api).then((result) => {
      if (!alive.current) return;
      dispatch({ type: "answered", result });
      if (result.state === "ok") onLoaded();
    });
  };

  return <EmptyDatabase state={state} onLoad={load} />;
}
