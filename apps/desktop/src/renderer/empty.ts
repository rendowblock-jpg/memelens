import type { SampleLoaded } from "@memelens/service";
import type { Loaded } from "./controller";

// The life of the "Load the sample data" button on the empty screen. One load at a time; an answer that nobody asked for changes
// nothing; after a failure the button can be pressed again; after success it stays off until the data replaces this screen.

export type SampleState = { phase: "idle" } | { phase: "loading" } | { phase: "loaded" } | { phase: "failed"; message: string };
export type SampleEvent = { type: "click" } | { type: "answered"; result: Loaded<SampleLoaded> };

export function reduceSample(state: SampleState, event: SampleEvent): SampleState {
  switch (event.type) {
    case "click":
      return state.phase === "idle" || state.phase === "failed" ? { phase: "loading" } : state;
    case "answered":
      if (state.phase !== "loading") return state;
      return event.result.state === "ok" ? { phase: "loaded" } : { phase: "failed", message: event.result.message };
  }
}
