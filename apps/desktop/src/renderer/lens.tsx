import type { ReactElement } from "react";
import { FormatError } from "./format";
import { gaugeArc, riskBar } from "./model";
import type { TokenData } from "./views";

// The two drawings that show a risk score. Both are plain SVG with attributes only (no inline style, no script),
// so they work under the app's strict content security policy. Text lives in HTML next to them, not in the SVG.

type Report = TokenData["risk"]["report"];

const n3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Two rings. The thick inner ring is the score; the thin outer ring is how much of the total weight was measured.
 * An unknown level draws no score at all, so a number that cannot be trusted is never drawn.
 */
export function RiskGauge({ risk }: { risk: Pick<Report, "level" | "score" | "coverage"> }): ReactElement {
  if (!(risk.coverage >= 0 && risk.coverage <= 1)) throw new FormatError("a coverage must be a number from 0 to 1");
  const known = risk.level !== "unknown";
  const measured = `${Math.round(risk.coverage * 100)}% of the signals are measured.`;
  const label = known ? `Risk score ${Math.round(risk.score)} of 100, ${risk.level}. ${measured}` : `Risk unknown. ${measured}`;
  const outer = gaugeArc(risk.coverage * 100, 44);
  const inner = known ? gaugeArc(Math.min(100, Math.max(0, risk.score)), 32) : null;
  return (
    <div className="gauge" role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" width="104" height="104" aria-hidden="true" focusable="false">
        <circle className="gauge-track" cx="50" cy="50" r="44" />
        <circle className="gauge-coverage" cx="50" cy="50" r="44" strokeDasharray={`${outer.dash} ${outer.gap}`} transform="rotate(-90 50 50)" />
        <circle className="gauge-track" cx="50" cy="50" r="32" />
        {inner === null ? null : (
          <circle
            className={`gauge-score risk-${risk.level}`}
            cx="50"
            cy="50"
            r="32"
            strokeDasharray={`${inner.dash} ${inner.gap}`}
            transform="rotate(-90 50 50)"
          />
        )}
      </svg>
      <span className="gauge-num" aria-hidden="true">{known ? Math.round(risk.score) : "?"}</span>
    </div>
  );
}

const GAP = 0.4;
const HEIGHT = 10;

/**
 * One bar per signal: as wide as its weight, filled from the bottom by how worrying it is. A signal nobody has
 * measured keeps its width and is drawn empty with a dashed outline, so missing data is visible and not mistaken for safe.
 */
export function RiskBar({ signals }: { signals: Report["signals"] }): ReactElement {
  const segments = riskBar(signals);
  const measured = segments.filter((s) => s.known).length;
  const label = `Risk by signal: ${measured} of ${segments.length} signals measured, ${segments.length - measured} not measured.`;
  return (
    <figure className="risk-bar">
      <svg viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label} focusable="false">
        {segments.map((s) => {
          const x = n3(s.x + GAP / 2);
          const width = n3(s.width - GAP);
          return (
            <g key={s.id}>
              <rect className="seg-track" x={x} y={0} width={width} height={HEIGHT} />
              {s.known ? (
                <rect className="seg-fill" x={x} y={n3(HEIGHT - HEIGHT * s.fill)} width={width} height={n3(HEIGHT * s.fill)} />
              ) : (
                <rect className="seg-unknown" x={x} y={0} width={width} height={HEIGHT} />
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="muted">
        Each bar is one signal. Wider means it counts for more, taller means it is more worrying, dashed means not measured.
      </figcaption>
    </figure>
  );
}
