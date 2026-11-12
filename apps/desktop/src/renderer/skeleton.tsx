import type { ReactElement } from "react";

/** The most rows a skeleton draws: enough to fill a screen, few enough to keep the page light. */
export const SKELETON_MAX_LINES = 12;

/**
 * What the window shows while an answer is on its way. It says what is loading in words for a screen reader (the lines
 * themselves are hidden from it), and the stylesheet keeps it invisible for the first 160 ms, so a quick answer never
 * flashes a grey placeholder at the person.
 */
export function Skeleton({ what, lines = 6 }: { what: string; lines?: number }): ReactElement {
  const rows = Math.min(SKELETON_MAX_LINES, Math.max(1, Math.floor(lines)));
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="sr-only">Loading {what}…</span>
      <div className="sk-line head" aria-hidden="true" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-line" aria-hidden="true" />
      ))}
    </div>
  );
}
