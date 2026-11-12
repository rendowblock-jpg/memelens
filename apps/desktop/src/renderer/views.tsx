import type { ReactElement } from "react";
import type { ApiResponses } from "@memelens/service";
import { formatAge, formatPercent, formatPrice, formatSignalValue, formatTime, formatUnits, shortAddress } from "./format";
import type { Quote } from "./quote";
import { RiskBar, RiskGauge } from "./lens";

// Presentational components: data in, markup out, no state and no calls. They throw FormatError on a malformed
// number (the app's error boundary shows it) rather than printing something wrong.

export type FeedData = ApiResponses["feed"];
export type FeedRowData = FeedData["rows"][number];
export type TokenData = NonNullable<ApiResponses["token"]>;
type RiskData = FeedRowData["risk"];
type MarkData = FeedRowData["lastPrice"];

const DASH = "—";

function quoteText(raw: string, quote: Quote): string {
  return `${formatUnits(raw, quote.decimals)} ${quote.symbol}`;
}

function priceText(mark: MarkData, tokenDecimals: number, quote: Quote): string {
  if (mark === null) return DASH;
  return `${formatPrice(mark.amount, mark.quote, tokenDecimals, quote.decimals)} ${quote.symbol}`;
}

type SignalData = TokenData["risk"]["report"]["signals"][number];
const SHARE_SIGNALS: ReadonlySet<string> = new Set(["top10Share", "creatorShare"]);

/** The age signal is milliseconds and the share signals are 0..1; everything else prints as a plain number. */
function signalText(s: SignalData): string {
  const v = s.value;
  if (typeof v === "number") {
    if (s.id === "age" && Number.isSafeInteger(v) && v >= 0) return formatAge(v);
    if (SHARE_SIGNALS.has(s.id) && v >= 0 && v <= 1) return formatPercent(v);
  }
  return formatSignalValue(v);
}

/** Says where the numbers come from, so a demo can never be mistaken for real chain data. */
export function DataNotice({ chain, asOf }: { chain: string; asOf: number }): ReactElement {
  return (
    <p className="notice" data-testid="notice">
      <span>
        Chain <strong>{chain}</strong> · as of <time>{formatTime(asOf)}</time> (newest data in the database)
      </span>
      {chain === "synthetic" ? (
        <strong className="synthetic"> SYNTHETIC DATA: made up for tests and demos, not real chain data.</strong>
      ) : null}
    </p>
  );
}

/** The level in words, so colour is never the only signal. Below the minimum coverage the score is not shown. */
export function RiskBadge({ risk }: { risk: RiskData }): ReactElement {
  const known = risk.level !== "unknown";
  return (
    <span className="risk-cell">
      <span className={`badge risk-${risk.level}`}>{known ? `${risk.level} ${Math.round(risk.score)}` : "unknown"}</span>
      {risk.hardFlags.length > 0 ? <span className="flag">⚑ {risk.hardFlags.join(", ")}</span> : null}
      <span className="muted"> {formatPercent(risk.coverage, 0)} of signals known</span>
    </span>
  );
}

export function FeedTable({
  feed,
  quote,
  selected,
  onSelect,
}: {
  feed: FeedData;
  quote: Quote;
  selected: string | null;
  onSelect: (token: string) => void;
}): ReactElement {
  if (feed.rows.length === 0) return <p className="muted">No tokens at or before this time.</p>;
  return (
    <table className="feed" aria-label="Token feed">
      <thead>
        <tr>
          <th scope="col">Token</th>
          <th scope="col" className="num">Age</th>
          <th scope="col" className="num">Last price</th>
          <th scope="col" className="num">Volume</th>
          <th scope="col" className="num">Trades</th>
          <th scope="col" className="num">Holders</th>
          <th scope="col" className="num">Top 10</th>
          <th scope="col">Risk</th>
        </tr>
      </thead>
      <tbody>
        {feed.rows.map((r) => (
          <tr key={r.token} className={r.token === selected ? "selected" : undefined} data-token={r.token}>
            <th scope="row">
              <button type="button" className="link" aria-pressed={r.token === selected} onClick={() => onSelect(r.token)}>
                {r.symbol ?? shortAddress(r.token)}
              </button>
              <span className="addr" title={r.token}>{shortAddress(r.token)}</span>
            </th>
            <td className="num">{formatAge(r.ageMs)}</td>
            <td className="num">{priceText(r.lastPrice, r.decimals, quote)}</td>
            <td className="num">{quoteText(r.volumeQuote, quote)}</td>
            <td className="num">{r.trades}</td>
            <td className="num">{r.holders === null ? DASH : r.holders}</td>
            <td className="num">{formatPercent(r.top10Share)}</td>
            <td><RiskBadge risk={r.risk} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A wallet address: a button that opens the wallet when the app can, plain text otherwise. */
function WalletRef({ address, onOpen }: { address: string; onOpen?: ((wallet: string) => void) | undefined }): ReactElement {
  if (onOpen === undefined) return <code title={address}>{shortAddress(address)}</code>;
  return (
    <button type="button" className="link wallet" title={address} onClick={() => onOpen(address)}>
      {shortAddress(address)}
    </button>
  );
}

export function TokenPanel({ detail, quote, onOpenWallet }: { detail: TokenData; quote: Quote; onOpenWallet?: ((wallet: string) => void) | undefined }): ReactElement {
  const { info, risk, concentration } = detail;
  const report = risk.report;
  return (
    <section className="token-panel" aria-label="Token detail" data-token={info.token}>
      <h2>
        {info.symbol ?? shortAddress(info.token)} <code className="addr">{info.token}</code>
      </h2>
      <p className="muted">
        Created <time>{formatTime(info.createdAt)}</time> · {formatAge(detail.asOf - info.createdAt)} old · {detail.trades} trades
        · creator {info.creator === null ? "unknown" : <code title={info.creator}>{shortAddress(info.creator)}</code>} · mint authority{" "}
        {formatSignalValue(info.mintAuthorityActive)} · freeze authority {formatSignalValue(info.freezeAuthorityActive)}
      </p>
      <p>
        Last price <strong>{priceText(detail.lastPrice, info.decimals, quote)}</strong>
        <span className="muted"> (from the last trade only: indicative, not a market price)</span>
      </p>

      <h3>Risk</h3>
      <div className="risk-lens">
        <RiskGauge risk={report} />
        <div className="risk-summary">
          <p>
            <RiskBadge risk={report} />
          </p>
          {report.level === "unknown" ? (
            <p className="muted">Not enough of the signals are known to give a level. The score below covers only what is known.</p>
          ) : null}
        </div>
      </div>
      <RiskBar signals={report.signals} />
      <table className="signals" aria-label="Risk signals">
        <thead>
          <tr>
            <th scope="col">Signal</th>
            <th scope="col">Value</th>
            <th scope="col" className="num">Adds</th>
          </tr>
        </thead>
        <tbody>
          {report.signals.map((s) => (
            <tr key={s.id} className={s.known ? undefined : "muted"}>
              <th scope="row">{s.label}</th>
              <td>{s.known ? signalText(s) : (risk.unavailable[s.id] ?? "unknown")}</td>
              <td className="num">{s.known ? s.contribution.toFixed(1) : DASH}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Holders</h3>
      {concentration === null ? (
        <p className="muted">No holder snapshot at or before this time.</p>
      ) : (
        <>
          <p>
            {concentration.value.holders} holders · snapshot {formatAge(concentration.snapshotAgeMs)} old · top 1{" "}
            {formatPercent(concentration.value.topShare[1] ?? null)} · top 5 {formatPercent(concentration.value.topShare[5] ?? null)} · top
            10 {formatPercent(concentration.value.topShare[10] ?? null)} · top 20 {formatPercent(concentration.value.topShare[20] ?? null)} ·
            HHI {formatSignalValue(concentration.value.hhi)} · Gini {formatSignalValue(concentration.value.gini)}
          </p>
          <table className="holders" aria-label="Top holders">
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col" className="num">Amount</th>
                <th scope="col" className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {concentration.topHolders.map((h) => (
                <tr key={h.address}>
                  <th scope="row"><WalletRef address={h.address} onOpen={onOpenWallet} /></th>
                  <td className="num">{formatUnits(h.amount, info.decimals)}</td>
                  <td className="num">{formatPercent(h.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Recent trades</h3>
      {detail.recentTrades.length === 0 ? (
        <p className="muted">No trades at or before this time.</p>
      ) : (
        <table className="trades" aria-label="Recent trades">
          <thead>
            <tr>
              <th scope="col">Time (UTC)</th>
              <th scope="col">Side</th>
              <th scope="col" className="num">Amount</th>
              <th scope="col" className="num">{quote.symbol}</th>
              <th scope="col">Wallet</th>
            </tr>
          </thead>
          <tbody>
            {detail.recentTrades.map((t) => (
              <tr key={t.id}>
                <td>{formatTime(t.time)}</td>
                <td>{t.side}</td>
                <td className="num">{formatUnits(t.amount, info.decimals)}</td>
                <td className="num">{formatUnits(t.quote, quote.decimals)}</td>
                <td><WalletRef address={t.wallet} onOpen={onOpenWallet} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
