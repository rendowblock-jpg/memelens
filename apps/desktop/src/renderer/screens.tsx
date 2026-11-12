import type { ReactElement } from "react";
import type { ApiResponses } from "@memelens/service";
import { formatPercent, formatSigned, formatSignedPercent, formatTime, formatUnits, shortAddress } from "./format";
import type { Quote } from "./quote";

// Presentational screens: data in, markup out. Same rule as views.tsx: a malformed number throws FormatError.

export type SmartData = ApiResponses["smart"];
export type WalletData = ApiResponses["wallet"];
export interface TokenMeta {
  symbol: string | null;
  decimals: number;
}
export type TokenMetaMap = Readonly<Record<string, TokenMeta>>;
export type Screen = "feed" | "smart" | "wallet";

const DASH = "—";

/** A signed money amount with its unit, with a class so gains and losses can be coloured (the sign is the real signal). */
function Money({ raw, quote }: { raw: string; quote: Quote }): ReactElement {
  const text = formatSigned(raw, quote.decimals);
  const tone = text.startsWith("+") ? "gain" : text.startsWith("-") ? "loss" : "flat";
  return <span className={`money ${tone}`}>{`${text} ${quote.symbol}`}</span>;
}

function WalletButton({ address, onOpen }: { address: string; onOpen: (wallet: string) => void }): ReactElement {
  return (
    <button type="button" className="link wallet" title={address} onClick={() => onOpen(address)}>
      {shortAddress(address)}
    </button>
  );
}

const REASONS: Record<string, (minClosed: number) => string> = {
  "too-few-closed-tokens": (n) => `Fewer than ${n} closed tokens`,
  "not-profitable": () => "Not profitable in this window",
};

export function SmartTable({
  report,
  quote,
  minClosed,
  onOpenWallet,
}: {
  report: SmartData["report"];
  quote: Quote;
  minClosed: number;
  onOpenWallet: (wallet: string) => void;
}): ReactElement {
  return (
    <div className="smart">
      <h3>Ranked</h3>
      {report.ranked.length === 0 ? (
        <p className="muted">Nobody is ranked in this window.</p>
      ) : (
        <table className="smart-ranked" aria-label="Ranked wallets">
          <thead>
            <tr>
              <th scope="col" className="num">#</th>
              <th scope="col">Wallet</th>
              <th scope="col" className="num">Realised</th>
              <th scope="col" className="num">Return on cost</th>
              <th scope="col" className="num">Closed tokens</th>
              <th scope="col">Hit rate</th>
              <th scope="col" className="num">Trades</th>
            </tr>
          </thead>
          <tbody>
            {report.ranked.map((w) => (
              <tr key={w.address}>
                <td className="num">{w.rank}</td>
                <th scope="row"><WalletButton address={w.address} onOpen={onOpenWallet} /></th>
                <td className="num"><Money raw={w.realised} quote={quote} /></td>
                <td className="num">{formatSignedPercent(w.roi)}</td>
                <td className="num">{w.closedTokens}</td>
                <td>
                  {w.hitRate === null ? (
                    DASH
                  ) : (
                    <>
                      <strong>{formatPercent(w.hitRate)}</strong>{" "}
                      <span className="muted">
                        {w.wins} of {w.closedTokens} · supports at least {formatPercent(w.hitRateLow)}
                      </span>
                    </>
                  )}
                </td>
                <td className="num">{w.trades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {report.unranked.length === 0 ? null : (
        <>
          <h3>Not ranked</h3>
          <table className="smart-unranked" aria-label="Not ranked">
            <thead>
              <tr>
                <th scope="col">Wallet</th>
                <th scope="col">Why</th>
                <th scope="col" className="num">Realised</th>
                <th scope="col" className="num">Closed tokens</th>
                <th scope="col" className="num">Trades</th>
              </tr>
            </thead>
            <tbody>
              {report.unranked.map((w) => (
                <tr key={w.address}>
                  <th scope="row"><WalletButton address={w.address} onOpen={onOpenWallet} /></th>
                  <td>{(REASONS[w.reason] ?? (() => w.reason))(minClosed)}</td>
                  <td className="num"><Money raw={w.realised} quote={quote} /></td>
                  <td className="num">{w.closedTokens}</td>
                  <td className="num">{w.trades}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function metaFor(tokens: TokenMetaMap, token: string): TokenMeta {
  return Object.hasOwn(tokens, token) ? tokens[token]! : { symbol: null, decimals: 0 };
}

export function WalletPanel({
  detail,
  quote,
  tokens,
  onOpenToken,
}: {
  detail: WalletData;
  quote: Quote;
  tokens: TokenMetaMap;
  onOpenToken: (token: string) => void;
}): ReactElement {
  const { totals } = detail.pnl;
  const unmarked = totals.unmarkedTokens.length;
  return (
    <section className="wallet-panel" aria-label="Wallet detail" data-wallet={detail.wallet}>
      <h2><code className="addr">{detail.wallet}</code></h2>
      <p className="muted">{detail.trades} trades · as of <time>{formatTime(detail.asOf)}</time></p>

      {detail.pnl.tokens.length === 0 ? (
        <p className="muted">No trades at or before this time.</p>
      ) : (
        <>
          <dl className="totals">
            <div className="total"><dt>Realised</dt><dd><Money raw={totals.realised} quote={quote} /></dd></div>
            <div className="total"><dt>Unrealised</dt><dd><Money raw={totals.unrealised} quote={quote} /></dd></div>
            <div className="total"><dt>Sells with no known buy</dt><dd>{`${formatUnits(totals.unmatchedProceeds, quote.decimals)} ${quote.symbol}`}</dd></div>
          </dl>
          {unmarked === 0 ? null : (
            <p className="muted">
              {unmarked === 1 ? "1 token without a price is not in the unrealised total." : `${unmarked} tokens without a price are not in the unrealised total.`}
            </p>
          )}
          <p className="muted">Unrealised comes from the last trade of each token only: indicative, not a market price.</p>
          {totals.unmatchedProceeds === "0" ? null : (
            <p className="muted">Sells with no known buy are not counted as profit or loss: their cost is unknown.</p>
          )}

          <h3>Positions by token</h3>
          <table className="positions" aria-label="Positions by token">
            <thead>
              <tr>
                <th scope="col">Token</th>
                <th scope="col" className="num">Bought</th>
                <th scope="col" className="num">Sold</th>
                <th scope="col" className="num">Realised ({quote.symbol})</th>
                <th scope="col" className="num">Still held</th>
                <th scope="col" className="num">Unrealised ({quote.symbol})</th>
                <th scope="col" className="num">Sold without a known buy</th>
              </tr>
            </thead>
            <tbody>
              {detail.pnl.tokens.map((t) => {
                const meta = metaFor(tokens, t.token);
                const amount = (raw: string): string => formatUnits(raw, meta.decimals);
                return (
                  <tr key={t.token}>
                    <th scope="row">
                      <button type="button" className="link" onClick={() => onOpenToken(t.token)}>
                        {meta.symbol ?? shortAddress(t.token)}
                      </button>
                      <span className="addr" title={t.token}>{shortAddress(t.token)}</span>
                    </th>
                    <td className="num">{amount(t.boughtAmount)}</td>
                    <td className="num">{amount(t.soldAmount)}</td>
                    <td className="num"><Money raw={t.realised} quote={{ ...quote, symbol: "" }} /></td>
                    <td className="num">{amount(t.openAmount)}</td>
                    <td className="num">{t.unrealised === null ? "no price" : <Money raw={t.unrealised} quote={{ ...quote, symbol: "" }} />}</td>
                    <td className="num">{amount(t.unmatchedSoldAmount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** The mark of the app: a lens (a ring with a cross-hair and a glint). */
export function Brand(): ReactElement {
  return (
    <svg className="brand" viewBox="0 0 32 32" width="30" height="30" role="img" aria-label="MemeLens" focusable="false">
      <circle cx="16" cy="16" r="11" fill="none" strokeWidth="2.4" />
      <path d="M16 2.5v6M16 23.5v6M2.5 16h6M23.5 16h6" strokeWidth="2" strokeLinecap="round" fill="none" />
      <circle className="brand-pupil" cx="16" cy="16" r="3.6" stroke="none" />
      <path d="M10.2 12.4a7.2 7.2 0 0 1 3.4-3.2" strokeWidth="1.8" strokeLinecap="round" fill="none" className="brand-glint" />
    </svg>
  );
}

const ICONS: Record<Screen, ReactElement> = {
  feed: <path d="M4 6h16M4 12h16M4 18h10" />,
  smart: <path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" />,
  wallet: <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H19v4H6.5M4 7.5V17a2 2 0 0 0 2 2h13V9H6.5M16 14h1" />,
};

const ITEMS: readonly { screen: Screen; label: string }[] = [
  { screen: "feed", label: "Feed" },
  { screen: "smart", label: "Smart money" },
  { screen: "wallet", label: "Wallet" },
];

export function Rail({ current, onGo }: { current: Screen; onGo: (screen: Exclude<Screen, "wallet">) => void }): ReactElement {
  return (
    <nav className="rail" aria-label="Main">
      <Brand />
      {ITEMS.filter((i) => i.screen !== "wallet" || current === "wallet").map((i) => (
        <button
          key={i.screen}
          type="button"
          className="rail-item"
          aria-current={i.screen === current ? "page" : undefined}
          onClick={() => (i.screen === "wallet" ? undefined : onGo(i.screen))}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            {ICONS[i.screen]}
          </svg>
          <span className="rail-label">{i.label}</span>
        </button>
      ))}
    </nav>
  );
}


