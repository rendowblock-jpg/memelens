import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import type { Api } from "@memelens/service";
import { loadFeed, loadOverview, loadSmart, loadToken, loadWallet, MIN_CLOSED_TOKENS, pickChain, type Loaded } from "./controller";
import { formatTime } from "./format";
import type { SmartSpan } from "./model";
import { quoteFor } from "./quote";
import { Rail, SmartTable, WalletPanel, type Screen, type TokenMetaMap } from "./screens";
import { DataNotice, FeedTable, TokenPanel } from "./views";

// The stateful shell: which screen is open, which token or wallet is selected, and what is loading. The decisions
// (what to ask for, how a reply becomes a value) live in controller.ts and model.ts, which are tested; this file
// only connects them to React.

type Async<T> = { state: "idle" } | { state: "loading" } | Loaded<T>;

function useAsync<T>(load: (() => Promise<Loaded<T>>) | null, deps: readonly unknown[]): Async<T> {
  const [value, setValue] = useState<Async<T>>({ state: "idle" });
  useEffect(() => {
    if (load === null) {
      setValue({ state: "idle" });
      return;
    }
    let cancelled = false; // a slow answer to an old question must not replace the answer to the new one
    setValue({ state: "loading" });
    void load().then((r) => {
      if (!cancelled) setValue(r);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** Views throw FormatError on a malformed number rather than print a wrong one; this shows that as a message. */
class Boundary extends Component<{ children: ReactNode; resetKey: string }, { error: string | null; key: string }> {
  override state = { error: null as string | null, key: this.props.resetKey };
  static getDerivedStateFromError(e: unknown): { error: string } {
    return { error: e instanceof Error ? e.message : "something went wrong" };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: string | null; key: string }): { error: string | null; key: string } | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  override componentDidCatch(_e: Error, _info: ErrorInfo): void {}
  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <p className="error" role="alert">
          This could not be shown: {this.state.error}
        </p>
      );
    }
    return this.props.children;
  }
}

function Status<T>({ value, what, children }: { value: Async<T>; what: string; children: (data: T) => ReactNode }): ReactElement {
  if (value.state === "error") return <p className="error" role="alert">Could not load {what}: {value.message}</p>;
  if (value.state !== "ok") return <p className="muted" role="status">Loading {what}…</p>;
  return <>{children(value.data)}</>;
}

type Route =
  | { screen: "feed"; token: string | null }
  | { screen: "smart" }
  | { screen: "wallet"; wallet: string; back: "feed" | "smart" };

const SPANS: readonly { span: SmartSpan; label: string }[] = [
  { span: "1d", label: "24 hours" },
  { span: "7d", label: "7 days" },
  { span: "30d", label: "30 days" },
  { span: "all", label: "All data" },
];

export function App({ api }: { api: Api }): ReactElement {
  const [route, setRoute] = useState<Route>({ screen: "feed", token: null });
  const [chainChoice, setChainChoice] = useState<string | null>(null);
  const [span, setSpan] = useState<SmartSpan>("30d");

  const overview = useAsync(() => loadOverview(api), [api]);
  const chains = overview.state === "ok" ? overview.data.chains : [];
  const chain = chainChoice ?? pickChain(chains);
  const latest = chains.find((c) => c.chain === chain)?.latestTime ?? null;
  const quote = quoteFor(chain ?? "");

  const feed = useAsync(chain === null ? null : () => loadFeed(api, chain), [api, chain]);
  const rows = feed.state === "ok" ? feed.data.rows : [];
  const tokens: TokenMetaMap = useMemo(() => Object.fromEntries(rows.map((r) => [r.token, { symbol: r.symbol, decimals: r.decimals }])), [feed]);

  const selected = route.screen === "feed" ? (route.token ?? rows[0]?.token ?? null) : null;
  const token = useAsync(chain === null || selected === null ? null : () => loadToken(api, chain, selected), [api, chain, selected]);
  const smart = useAsync(route.screen === "smart" && chain !== null && latest !== null ? () => loadSmart(api, chain, latest, span) : null, [api, chain, latest, span, route.screen]);
  const walletId = route.screen === "wallet" ? route.wallet : null;
  const wallet = useAsync(chain === null || walletId === null ? null : () => loadWallet(api, chain, walletId), [api, chain, walletId]);

  // Tells the test harness (and nothing else) that the first screen has finished loading.
  const settled = overview.state === "error" || (overview.state === "ok" && (chain === null || feed.state === "ok" || feed.state === "error"));
  useEffect(() => {
    if (!settled) return;
    document.body.dataset["state"] = overview.state === "error" || feed.state === "error" ? "error" : chain === null ? "empty" : "done";
  }, [settled, overview.state, feed.state, chain]);

  const openWallet = (address: string): void => setRoute({ screen: "wallet", wallet: address, back: route.screen === "smart" ? "smart" : "feed" });
  const openToken = (t: string): void => setRoute({ screen: "feed", token: t });
  const go = (screen: Exclude<Screen, "wallet">): void => setRoute(screen === "feed" ? { screen: "feed", token: null } : { screen: "smart" });

  const title = route.screen === "feed" ? "Token feed" : route.screen === "smart" ? "Smart money" : "Wallet";

  return (
    <div className="app">
      <Rail current={route.screen} onGo={go} />
      <div className="main">
        <header className="topbar">
          <h1>
            {route.screen === "wallet" ? (
              <button type="button" className="back" onClick={() => go(route.back)}>
                ← {route.back === "smart" ? "Smart money" : "Token feed"}
              </button>
            ) : null}
            {title}
          </h1>
          {chains.length > 1 ? (
            <label className="chain-pick">
              Chain
              <select value={chain ?? ""} onChange={(e) => setChainChoice(e.target.value)}>
                {chains.map((c) => (
                  <option key={c.chain} value={c.chain}>{c.chain}</option>
                ))}
              </select>
            </label>
          ) : null}
        </header>

        {chain !== null && latest !== null ? <DataNotice chain={chain} asOf={latest} /> : null}

        <div className="content">
          <Boundary resetKey={`${route.screen}|${selected}|${walletId}|${chain}|${span}`}>
            {overview.state === "error" ? (
              <p className="error" role="alert">Could not read the database: {overview.message}</p>
            ) : overview.state !== "ok" ? (
              <p className="muted" role="status">Opening the database…</p>
            ) : chain === null ? (
              <div className="empty">
                <h2>No data yet</h2>
                <p className="muted">The database is empty. Until live data arrives, load a recorded file with the command line:</p>
                <pre>npm run memelens -- ingest packages/data/fixtures/sample.json --db &lt;your database&gt;</pre>
              </div>
            ) : route.screen === "feed" ? (
              <div className="split">
                <div className="pane list">
                  <Status value={feed} what="the token feed">
                    {(data) => <FeedTable feed={data} quote={quote} selected={selected} onSelect={openToken} />}
                  </Status>
                </div>
                <aside className="pane detail">
                  {selected === null ? (
                    <p className="muted">Select a token to see its risk, holders and trades.</p>
                  ) : (
                    <Status value={token} what="the token">
                      {(data) =>
                        data === null ? (
                          <p className="muted">This token did not exist yet at this time.</p>
                        ) : (
                          <TokenPanel detail={data} quote={quote} onOpenWallet={openWallet} />
                        )
                      }
                    </Status>
                  )}
                </aside>
              </div>
            ) : route.screen === "smart" ? (
              <div className="single">
                <div className="toolbar">
                  <div className="segmented" role="group" aria-label="Window">
                    {SPANS.map((s) => (
                      <button key={s.span} type="button" aria-pressed={s.span === span} onClick={() => setSpan(s.span)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                  {smart.state === "ok" ? (
                    <p className="muted">
                      <time>{formatTime(smart.data.from)}</time> → <time>{formatTime(smart.data.to)}</time> · wallets ranked by realised profit; hit rate is shown with what its sample size supports
                    </p>
                  ) : null}
                </div>
                <Status value={smart} what="the ranking">
                  {(data) => <SmartTable report={data.report} quote={quote} minClosed={MIN_CLOSED_TOKENS} onOpenWallet={openWallet} />}
                </Status>
              </div>
            ) : (
              <div className="single">
                <Status value={wallet} what="the wallet">
                  {(data) => <WalletPanel detail={data} quote={quote} tokens={tokens} onOpenToken={openToken} />}
                </Status>
              </div>
            )}
          </Boundary>
        </div>
      </div>
    </div>
  );
}
