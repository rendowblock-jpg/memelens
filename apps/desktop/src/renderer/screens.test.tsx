import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplayAdapter, Store, ingest, parseFixture } from "@memelens/data";
import { handle } from "@memelens/service";
import { quoteFor } from "./quote";
import { Rail, SmartTable, WalletPanel, type SmartData, type TokenMetaMap, type WalletData } from "./screens";
import { RiskBar, RiskGauge } from "./lens";
import { TokenPanel, type TokenData } from "./views";

// Real pipeline again. The expected values were worked out by hand from packages/data/fixtures/sample.json with an
// independent FIFO calculation (alice: 5 closed tokens, +1,000,000 lamports each on a 1,000,000 cost; bob: -500,000 each;
// carol: +100,000 on TOK1 and -100,000 on TOK2; dave: bought 500 of TOK5 for 500,000, last price 0.5 per 1000 raw units).

const FIXTURE = fileURLToPath(new URL("../../../../packages/data/fixtures/sample.json", import.meta.url));
const SOL = quoteFor("synthetic");
const store = Store.open(":memory:");
await ingest(store, new ReplayAdapter(parseFixture(JSON.parse(readFileSync(FIXTURE, "utf8")))));
afterAll(() => store.close());

function ask<T>(channel: string, payload: unknown): T {
  const r = handle(store, channel, payload);
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}
const smart = (): SmartData => ask<SmartData>("smart", { chain: "synthetic", from: 0, to: 1_700_020_700_000, minClosed: 5 });
const wallet = (w: string): WalletData => ask<WalletData>("wallet", { chain: "synthetic", wallet: w });
const token = (t: string): TokenData => ask<TokenData>("token", { chain: "synthetic", token: t });
const META: TokenMetaMap = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`TOK${n}`, { symbol: `SYN${n}`, decimals: 6 }]));
const noop = (): void => {};

function plain(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function cellsOf(rowHtml: string): string[] {
  return rowHtml.split(/<\/t[dh]>/).filter((c) => c.trim() !== "").map(plain);
}
function tableRows(markup: string, label: string): string[][] {
  const t = new RegExp(`<table[^>]*aria-label="${label}"[^>]*>(.*?)</table>`, "s").exec(markup);
  if (t === null) throw new Error(`no table "${label}"`);
  const body = /<tbody>(.*?)<\/tbody>/s.exec(t[1]!)!;
  return [...body[1]!.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((m) => cellsOf(m[1]!));
}

describe("SmartTable", () => {
  let html = "";
  beforeAll(() => {
    html = renderToStaticMarkup(<SmartTable report={smart().report} quote={SOL} minClosed={5} onOpenWallet={noop} />);
  });

  it("ranks alice first with her gain, her return on cost and what her hit rate supports (Wilson 95% lower bound for 5 of 5 = 1/1.76832 = 56.6%)", () => {
    expect(tableRows(html, "Ranked wallets")).toEqual([["1", "alice", "+0.005 SOL", "+100.0%", "5", "100.0% 5 of 5 · supports at least 56.6%", "10"]]);
  });

  it("lists everyone else with the reason in words, and drops nobody", () => {
    expect(tableRows(html, "Not ranked")).toEqual([
      ["bob", "Not profitable in this window", "-0.0025 SOL", "5", "10"],
      ["carol", "Fewer than 5 closed tokens", "0 SOL", "2", "4"],
      ["dave", "Fewer than 5 closed tokens", "0 SOL", "0", "1"],
    ]);
  });

  it("makes each wallet a button that opens it", () => {
    expect([...html.matchAll(/<button[^>]*class="link wallet"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(["alice", "bob", "carol", "dave"]);
  });

  it("says so when nobody is ranked, without an empty table", () => {
    const none = { ranked: [], unranked: smart().report.unranked };
    const out = renderToStaticMarkup(<SmartTable report={none} quote={SOL} minClosed={5} onOpenWallet={noop} />);
    expect(plain(out)).toContain("Nobody is ranked in this window.");
    expect(out).not.toContain('aria-label="Ranked wallets"');
  });

  it("uses the minimum it was given in the reason", () => {
    const out = renderToStaticMarkup(<SmartTable report={smart().report} quote={SOL} minClosed={3} onOpenWallet={noop} />);
    expect(plain(out)).toContain("Fewer than 3 closed tokens");
  });
});

describe("WalletPanel", () => {
  it("alice: her gain per token, nothing still held", () => {
    const html = renderToStaticMarkup(<WalletPanel detail={wallet("alice")} quote={SOL} tokens={META} onOpenToken={noop} />);
    expect(plain(html)).toContain("alice");
    expect(plain(html)).toContain("10 trades");
    expect(plain(html)).toContain("Realised +0.005 SOL");
    expect(plain(html)).toContain("Unrealised 0 SOL");
    const rows = tableRows(html, "Positions by token");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual(["SYN1 TOK1", "0.001", "0.001", "+0.001", "0", "0", "0"]);
  });

  it("dave: still holds TOK5 and is under water on the last price (500 raw units bought for 500,000 lamports; the last price values them at 250,000)", () => {
    const html = renderToStaticMarkup(<WalletPanel detail={wallet("dave")} quote={SOL} tokens={META} onOpenToken={noop} />);
    expect(plain(html)).toContain("Realised 0 SOL");
    expect(plain(html)).toContain("Unrealised -0.0003 SOL");
    expect(tableRows(html, "Positions by token")).toEqual([["SYN5 TOK5", "0.0005", "0", "0", "0.0005", "-0.0003", "0"]]);
  });

  it("says 'no price' for something held that has no last price, never 0", () => {
    const d = wallet("dave");
    const noMark = { ...d, pnl: { ...d.pnl, tokens: d.pnl.tokens.map((t) => ({ ...t, unrealised: null })), totals: { ...d.pnl.totals, unmarkedTokens: ["TOK5"] } } };
    const html = renderToStaticMarkup(<WalletPanel detail={noMark} quote={SOL} tokens={META} onOpenToken={noop} />);
    expect(tableRows(html, "Positions by token")[0]![5]).toBe("no price");
    expect(plain(html)).toContain("1 token without a price is not in the unrealised total");
  });

  it("shows raw units and the address when a token is not in the feed", () => {
    const html = renderToStaticMarkup(<WalletPanel detail={wallet("dave")} quote={SOL} tokens={{}} onOpenToken={noop} />);
    expect(tableRows(html, "Positions by token")[0]!.slice(0, 5)).toEqual(["TOK5 TOK5", "500", "0", "0", "500"]);
  });

  it("makes each token a button that opens it", () => {
    const html = renderToStaticMarkup(<WalletPanel detail={wallet("alice")} quote={SOL} tokens={META} onOpenToken={noop} />);
    expect([...html.matchAll(/<button[^>]*class="link"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(["SYN1", "SYN2", "SYN3", "SYN4", "SYN5"]);
  });

  it("says so for a wallet that has no trades", () => {
    const d = wallet("nobody");
    const html = renderToStaticMarkup(<WalletPanel detail={d} quote={SOL} tokens={META} onOpenToken={noop} />);
    expect(plain(html)).toContain("No trades at or before this time.");
    expect(html).not.toContain('aria-label="Positions by token"');
  });

  it("explains sells with no known buy, since they are left out of profit and loss", () => {
    const d = wallet("alice");
    const html = renderToStaticMarkup(<WalletPanel detail={{ ...d, pnl: { ...d.pnl, totals: { ...d.pnl.totals, unmatchedProceeds: "2500000" } } }} quote={SOL} tokens={META} onOpenToken={noop} />);
    expect(plain(html)).toContain("Sells with no known buy 0.0025 SOL");
    expect(plain(html)).toContain("not counted as profit or loss");
  });
});

describe("Rail", () => {
  const items = (html: string): string[] => [...html.matchAll(/<button[^>]*>.*?<span class="rail-label">([^<]*)<\/span>/gs)].map((m) => m[1]!);
  it("shows the two places, and marks the current one for assistive technology", () => {
    const html = renderToStaticMarkup(<Rail current="feed" onGo={noop} />);
    expect(items(html)).toEqual(["Feed", "Smart money"]);
    expect([...html.matchAll(/aria-current="page"/g)]).toHaveLength(1);
    expect(/<button[^>]*aria-current="page"[^>]*>.*?Feed/s.test(html)).toBe(true);
  });
  it("adds a Wallet item only while a wallet is open", () => {
    const html = renderToStaticMarkup(<Rail current="wallet" onGo={noop} />);
    expect(items(html)).toEqual(["Feed", "Smart money", "Wallet"]);
    expect(/<[a-z]+[^>]*aria-current="page"[^>]*>.*?Wallet/s.test(html)).toBe(true);
    expect([...html.matchAll(/aria-current="page"/g)]).toHaveLength(1);
  });
});

describe("RiskGauge", () => {
  const report = token("TOK5").risk.report;
  const circles = (html: string): string[] => [...html.matchAll(/<circle[^>]*class="([^"]*)"/g)].map((m) => m[1]!);

  it("draws a score ring and a coverage ring for a known level, and says both in words", () => {
    const r = { ...report, level: "high" as const, score: 62.4, coverage: 0.57 };
    const html = renderToStaticMarkup(<RiskGauge risk={r} />);
    expect(circles(html).filter((c) => c.includes("gauge-score"))).toEqual(["gauge-score risk-high"]);
    expect(html).toContain('aria-label="Risk score 62 of 100, high. 57% of the signals are measured."');
    expect(plain(html)).toBe("62");
  });

  it("draws no score for an unknown level: only what is measured", () => {
    const r = { ...report, level: "unknown" as const, score: 30, coverage: 0.17 };
    const html = renderToStaticMarkup(<RiskGauge risk={r} />);
    expect(circles(html).some((c) => c.includes("gauge-score"))).toBe(false);
    expect(html).toContain('aria-label="Risk unknown. 17% of the signals are measured."');
    expect(plain(html)).toBe("?");
  });

  it("sizes the coverage ring by coverage (radius 44: 2*pi*44 = 276.460; 50% = 138.230)", () => {
    const html = renderToStaticMarkup(<RiskGauge risk={{ ...report, coverage: 0.5 }} />);
    expect(html).toMatch(/class="gauge-coverage"[^>]*stroke-dasharray="138.23 138.23"/);
  });
});

describe("RiskBar", () => {
  const mk = (id: string, weight: number, risk: number, known: boolean) => ({ id: id as never, label: `L-${id}`, known, value: known ? 1 : null, weight, risk, contribution: 0 });
  const signals = [mk("a", 60, 0.5, true), mk("b", 20, 1, true), mk("c", 20, 0, false)];
  let html = "";
  beforeAll(() => {
    html = renderToStaticMarkup(<RiskBar signals={signals} />);
  });

  it("says in words how many signals are measured", () => {
    expect(html).toContain('aria-label="Risk by signal: 2 of 3 signals measured, 1 not measured."');
  });
  it("draws one track per signal, as wide as its weight, with a small gap between", () => {
    expect([...html.matchAll(/<rect[^>]*class="seg-track"[^>]*x="([\d.]+)"[^>]*width="([\d.]+)"/g)].map((m) => [m[1], m[2]])).toEqual([["0.2", "59.6"], ["60.2", "19.6"], ["80.2", "19.6"]]);
  });
  it("fills a known signal from the bottom by its risk (a viewBox 10 high: 0.5 -> 5 from y=5; 1 -> 10 from y=0)", () => {
    expect([...html.matchAll(/<rect[^>]*class="seg-fill"[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g)].map((m) => [m[1], m[2]])).toEqual([["5", "5"], ["0", "10"]]);
  });
  it("hatches an unknown signal and fills nothing for it", () => {
    expect([...html.matchAll(/class="seg-unknown"/g)]).toHaveLength(1);
    expect([...html.matchAll(/class="seg-fill"/g)]).toHaveLength(2);
  });
  it("is part of the token panel's risk section", () => {
    const panel = renderToStaticMarkup(<TokenPanel detail={token("TOK5")} quote={SOL} />);
    expect(panel).toContain('class="risk-lens"');
    expect(panel).toContain('aria-label="Risk by signal: ');
  });
});

describe("TokenPanel wallet links", () => {
  it("makes the holders and the traders buttons when the app can open a wallet", () => {
    const html = renderToStaticMarkup(<TokenPanel detail={token("TOK5")} quote={SOL} onOpenWallet={noop} />);
    const holders = /<table[^>]*aria-label="Top holders"[^>]*>(.*?)<\/table>/s.exec(html)![1]!;
    const trades = /<table[^>]*aria-label="Recent trades"[^>]*>(.*?)<\/table>/s.exec(html)![1]!;
    const label = (t: string): string[] => [...t.matchAll(/<button[^>]*class="link wallet"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);
    expect(label(holders).length).toBe(token("TOK5").concentration!.topHolders.length);
    expect(label(trades).length).toBe(token("TOK5").recentTrades.length);
    expect(label(trades)).toEqual(token("TOK5").recentTrades.map((t) => t.wallet));
  });
  it("keeps plain text when it cannot (the existing markup)", () => {
    const html = renderToStaticMarkup(<TokenPanel detail={token("TOK5")} quote={SOL} />);
    expect(html).not.toContain('class="link wallet"');
  });
});
