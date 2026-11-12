import type { RiskSignal } from "@memelens/core";
import { FormatError } from "./format";

// Pure helpers for the screens. Nothing here touches the DOM, the clock or the network.

export interface BarSegment {
  id: string;
  label: string;
  known: boolean;
  /** Left edge and width as a percentage (0..100) of the bar. */
  x: number;
  width: number;
  /** How much of the segment is filled: the signal's risk (0..1). 0 for an unknown signal. */
  fill: number;
}

/**
 * The risk bar: one segment per signal, as wide as its weight. An unknown signal keeps its full width and is empty,
 * so the part of the score nobody has measured is visible and is never mistaken for "safe".
 */
export function riskBar(signals: readonly Pick<RiskSignal, "id" | "label" | "known" | "weight" | "risk">[]): BarSegment[] {
  const used = signals.filter((s) => {
    if (!Number.isFinite(s.weight) || s.weight < 0) throw new FormatError(`the weight of ${s.id} must be a number, 0 or more`);
    return s.weight > 0;
  });
  const total = used.reduce((sum, s) => sum + s.weight, 0);
  let before = 0;
  return used.map((s) => {
    if (s.known && !(s.risk >= 0 && s.risk <= 1)) throw new FormatError(`the risk of ${s.id} must be a number from 0 to 1`);
    const segment: BarSegment = {
      id: s.id,
      label: s.label,
      known: s.known,
      x: (100 * before) / total,
      width: (100 * s.weight) / total,
      fill: s.known ? s.risk : 0,
    };
    before += s.weight;
    return segment;
  });
}

export interface Arc {
  circumference: number;
  dash: number;
  gap: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The stroke-dasharray parts for a circle of the given radius drawn `percent` percent of the way round. */
export function gaugeArc(percent: number, radius: number): Arc {
  if (!(percent >= 0 && percent <= 100)) throw new FormatError("a gauge percentage must be a number from 0 to 100");
  if (!(Number.isFinite(radius) && radius > 0)) throw new FormatError("a gauge radius must be a positive number");
  const circumference = 2 * Math.PI * radius;
  const dash = (circumference * percent) / 100;
  return { circumference: round3(circumference), dash: round3(dash), gap: round3(circumference - dash) };
}

export type SmartSpan = "1d" | "7d" | "30d" | "all";

const DAY_MS = 86_400_000;
const SPAN_DAYS: Record<Exclude<SmartSpan, "all">, number> = { "1d": 1, "7d": 7, "30d": 30 };

/** The smart-money window: ends at the newest data (never the wall clock) and starts `span` earlier. */
export function smartWindow(latest: number, span: SmartSpan): { from: number; to: number } {
  if (!Number.isSafeInteger(latest) || latest < 0) throw new FormatError("a time must be whole milliseconds, 0 or more");
  if (span === "all") return { from: 0, to: latest };
  return { from: Math.max(0, latest - SPAN_DAYS[span] * DAY_MS), to: latest };
}
