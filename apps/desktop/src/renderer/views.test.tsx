import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { ReplayAdapter, Store, ingest, parseFixture } from "@memelens/data";
import { handle } from "@memelens/service";
import { FormatError } from "./format";
import { quoteFor, RAW_QUOTE } from "./quote";
import { DataNotice, FeedTable, RiskBadge, TokenPanel, type FeedData, type TokenData } from "./views";

// The data below goes through the real pipeline (fixture -> store -> handle), so these are the exact shapes the
// window receives. Expected strings were worked out by hand from the fixture (see the comments), not copied from output.

const FIXTURE = fileURLToPath(new URL("../../../../packages/data/fixtures/sample.json", import.meta.url));
const SOL = quoteFor("synthetic");

// Top-level await: the describe blocks below read the data while they are being collected.
const store = Store.open(":memory:");
await ingest(store, new ReplayAdapter(parseFixture(JSON.parse(readFileSync(FIXTURE, "utf8")))));
afterAll(() => store.close());

function feedData(): FeedData {
  const r = handle(store, "feed", { chain: "synthetic" });
  if (!r.ok) throw new Error(r.error);
  return r.data as FeedData;
}

function tokenData(token: string): TokenData {
  const r = handle(store, "token", { chain: "synthetic", token });
  if (!r.ok || r.data === null) throw new Error(`no data for ${token}`);
  return r.data as TokenData;
}

const noop = (): void => {};

function plain(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function cellsOf(rowHtml: string): string[] {
  return rowHtml
    .split(/<\/t[dh]>/)
    .filter((c) => c.trim() !== "")
    .map(plain);
}

function feedRow(markup: string, token: string): string[] {
  const m = new RegExp(`<tr[^>]*data-token="${token}"[^>]*>(.*?)</tr>`, "s").exec(markup);
  if (m === null) throw new Error(`no feed row for ${token}`);
  return cellsOf(m[1]!);
}

function tableRows(markup: string, label: string): string[][] {
  const t = new RegExp(`<table[^>]*aria-label="${label}"[^>]*>(.*?)</table>`, "s").exec(markup);
  if (t === null) throw new Error(`no table "${label}"`);
  const body = /<tbody>(.*?)<\/tbody>/s.exec(t[1]!);
  if (body === null) throw new Error(`table "${label}" has no body`);
  return [...body[1]!.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((m) => cellsOf(m[1]!));
}

describe("FeedTable", () => {
  const html = renderToStaticMarkup(<FeedTable feed={feedData()} quote={SOL} selected={null} onSelect={noop} />);

  it("lists the tokens newest first", () => {
    expect([...html.matchAll(/data-token="(\w+)"/g)].map((m) => m[1])).toEqual(["TOK5", "TOK4", "TOK3", "TOK2", "TOK1"]);
  });

  // Hand-worked from the fixture. as-of = newest data = 1700020700000.
  //  age = as-of - createdAt: TOK5 45m, TOK4 1h 45m, TOK3 2h 45m, TOK2 3h 45m, TOK1 4h 45m.
  //  price = last non-zero trade, quote/amount, token 6 decimals, SOL 9: 500000 lamports for 1000 raw = 0.5 SOL per token;
  //          300000 for 400 = 0.75; 500000 for 400 = 1.25.
  //  volume = sum of the quote side: 5,000,000 / 4,500,000 / 4,500,000 / 5,200,000 / 5,400,000 lamports (summed from the fixture).
  it.each([
    ["TOK5", ["SYN5 TOK5", "45m", "0.5 SOL", "0.005 SOL", "5", "4", "100.0%", "critical 93 ⚑ mintAuthority 57% of signals known"]],
    ["TOK4", ["SYN4 TOK4", "1h 45m", "0.5 SOL", "0.0045 SOL", "4", "—", "—", "unknown 17% of signals known"]],
    ["TOK3", ["SYN3 TOK3", "2h 45m", "0.5 SOL", "0.0045 SOL", "4", "—", "—", "unknown 17% of signals known"]],
    ["TOK2", ["SYN2 TOK2", "3h 45m", "0.75 SOL", "0.0052 SOL", "6", "—", "—", "unknown 17% of signals known"]],
    ["TOK1", ["SYN1 TOK1", "4h 45m", "1.25 SOL", "0.0054 SOL", "6", "3", "100.0%", "unknown 45% of signals known"]],
  ])("shows the row for %s", (token, expected) => {
    expect(feedRow(html, token!)).toEqual(expected);
  });

  it("marks only the selected row, for the eye and for assistive technology", () => {
    const sel = renderToStaticMarkup(<FeedTable feed={feedData()} quote={SOL} selected="TOK2" onSelect={noop} />);
    expect([...sel.matchAll(/<tr class="selected"[^>]*data-token="(\w+)"/g)].map((m) => m[1])).toEqual(["TOK2"]);
    expect([...sel.matchAll(/aria-pressed="true"/g)]).toHaveLength(1);
    expect([...sel.matchAll(/aria-pressed="false"/g)]).toHaveLength(4);
    expect(html).not.toContain('class="selected"');
  });

  it("shows the address in place of a missing symbol, and the full address on hover", () => {
    const feed = feedData();
    const row = { ...feed.rows[0]!, symbol: null, token: "ABCDEFGHIJKLMNOP" };
    const out = renderToStaticMarkup(<FeedTable feed={{ ...feed, rows: [row] }} quote={SOL} selected={null} onSelect={noop} />);
    expect(feedRow(out, "ABCDEFGHIJKLMNOP")[0]).toBe("ABCD…MNOP ABCD…MNOP");
    expect(out).toContain('title="ABCDEFGHIJKLMNOP"');
  });

  it("shows raw units on a chain whose currency is not known", () => {
    const out = renderToStaticMarkup(<FeedTable feed={feedData()} quote={RAW_QUOTE} selected={null} onSelect={noop} />);
    // price = 500000 raw quote per (1000 raw / 10^6) token = 500,000,000 ; volume 5,000,000
    expect(feedRow(out, "TOK5").slice(2, 4)).toEqual(["500,000,000 raw units", "5,000,000 raw units"]);
  });

  it("says so when there are no tokens", () => {
    const out = renderToStaticMarkup(<FeedTable feed={{ ...feedData(), rows: [] }} quote={SOL} selected={null} onSelect={noop} />);
    expect(plain(out)).toBe("No tokens at or before this time.");
  });

  it("fails loudly on a malformed number instead of printing a wrong one", () => {
    const feed = feedData();
    const bad = { ...feed, rows: [{ ...feed.rows[0]!, volumeQuote: "1.5" }] };
    expect(() => renderToStaticMarkup(<FeedTable feed={bad} quote={SOL} selected={null} onSelect={noop} />)).toThrow(FormatError);
  });
});

describe("RiskBadge", () => {
  const base = { score: 12.4, level: "low" as const, coverage: 0.9, hardFlags: [] };

  it("shows a known level with its rounded score", () => {
    expect(plain(renderToStaticMarkup(<RiskBadge risk={base} />))).toBe("low 12 90% of signals known");
    expect(renderToStaticMarkup(<RiskBadge risk={base} />)).toContain('class="badge risk-low"');
  });

  it("never shows a number for an unknown level", () => {
    const out = renderToStaticMarkup(<RiskBadge risk={{ ...base, level: "unknown", score: 66.4, coverage: 0.45 }} />);
    expect(plain(out)).toBe("unknown 45% of signals known");
    expect(out).toContain("risk-unknown");
  });

  it("lists every hard flag", () => {
    const out = renderToStaticMarkup(<RiskBadge risk={{ ...base, level: "high", score: 80, hardFlags: ["mintAuthority", "freezeAuthority"] }} />);
    expect(plain(out)).toBe("high 80 ⚑ mintAuthority, freezeAuthority 90% of signals known");
  });
});

describe("DataNotice", () => {
  it("prints the as-of time in UTC and warns loudly that synthetic data is not real", () => {
    const out = renderToStaticMarkup(<DataNotice chain="synthetic" asOf={1_700_020_700_000} />);
    expect(plain(out)).toBe("Chain synthetic · as of 2023-11-15 03:58 UTC (newest data in the database) SYNTHETIC DATA: made up for tests and demos, not real chain data.");
  });

  it("has no synthetic warning on a real chain", () => {
    const out = renderToStaticMarkup(<DataNotice chain="solana" asOf={1_700_020_700_000} />);
    expect(plain(out)).toBe("Chain solana · as of 2023-11-15 03:58 UTC (newest data in the database)");
  });
});

describe("TokenPanel for TOK5 (critical, mint authority active)", () => {
  const detail = tokenData("TOK5");
  const html = renderToStaticMarkup(<TokenPanel detail={detail} quote={SOL} />);
  const text = plain(html);

  it("shows the header and basic facts", () => {
    // created 1700018000000 = 2023-11-15 03:13 UTC, as-of is 2,700,000 ms later = 45m
    expect(text).toContain("SYN5 TOK5");
    expect(text).toContain("Created 2023-11-15 03:13 UTC · 45m old · 5 trades · creator creator5 · mint authority yes · freeze authority no");
    expect(text).toContain("Last price 0.5 SOL (from the last trade only: indicative, not a market price)");
  });

  it("shows every risk signal with its value or the reason it is unknown, and what it adds", () => {
    expect(tableRows(html, "Risk signals")).toEqual([
      ["Top-10 holders' share of supply", "100.0%", "26.3"],
      ["Holder concentration (HHI)", "0.345", "17.5"],
      ["Creator's share of supply", "50.0%", "26.3"],
      ["Creator's earlier dumps", "no data source for the creator's history yet", "—"],
      ["Liquidity pool vs. market cap", "no liquidity data yet", "—"],
      ["Mint authority still active", "yes", "14.0"],
      ["Freeze authority still active", "no", "0.0"],
      ["Supply held by wallets with a shared funder", "no wallet-funding data yet", "—"],
      ["Share of volume that looks like wash trading", "no wash-trade detector yet", "—"],
      ["Token age", "45m", "8.8"],
    ]);
    expect(text).toContain("critical 93 ⚑ mintAuthority 57% of signals known");
    expect(text).not.toContain("Not enough of the signals");
  });

  it("shows the holder statistics and the top holders (6 decimals: 1000 raw = 0.001)", () => {
    expect(text).toContain("4 holders · snapshot 0s old · top 1 50.0% · top 5 100.0% · top 10 100.0% · top 20 100.0% · HHI 0.345 · Gini 0.325");
    expect(tableRows(html, "Top holders")).toEqual([
      ["creator5", "0.001", "50.0%"],
      ["dave", "0.0005", "25.0%"],
      ["x1", "0.0003", "15.0%"],
      ["x2", "0.0002", "10.0%"],
    ]);
  });

  it("shows the newest trades first (6 token decimals, 9 SOL decimals)", () => {
    const rows = tableRows(html, "Recent trades");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual(["2023-11-15 03:48 UTC", "sell", "0.001", "0.0005", "bob"]);
    expect(rows[1]).toEqual(["2023-11-15 03:43 UTC", "sell", "0.001", "0.002", "alice"]);
    expect(rows[2]).toEqual(["2023-11-15 03:33 UTC", "buy", "0.0005", "0.0005", "dave"]);
  });

  it("carries the token address so a test or screenshot can tell which panel it is", () => {
    expect(html).toContain('data-token="TOK5"');
  });
});

describe("TokenPanel for TOK1 (level unknown, authorities not known)", () => {
  const detail = tokenData("TOK1");
  const html = renderToStaticMarkup(<TokenPanel detail={detail} quote={SOL} />);
  const text = plain(html);

  it("explains why there is no level, and shows the unknown authorities as unknown", () => {
    expect(text).toContain("unknown 45% of signals known");
    expect(text).toContain("Not enough of the signals are known to give a level. The score below covers only what is known.");
    expect(text).toContain("mint authority unknown · freeze authority unknown");
    expect(text).toContain("Last price 1.25 SOL");
  });

  it("shows the reason for each unknown signal, and the known ones", () => {
    const rows = tableRows(html, "Risk signals");
    expect(rows[0]).toEqual(["Top-10 holders' share of supply", "100.0%", "33.3"]);
    expect(rows[1]).toEqual(["Holder concentration (HHI)", "0.3333", "22.2"]);
    expect(rows[2]).toEqual(["Creator's share of supply", "0.0%", "0.0"]);
    expect(rows[5]).toEqual(["Mint authority still active", "mint authority status is not known", "—"]);
    expect(rows[9]).toEqual(["Token age", "4h 45m", "10.9"]);
  });

  it("shows how old the holder snapshot is (4 hours)", () => {
    expect(text).toContain("3 holders · snapshot 4h old · top 1 33.3% · top 5 100.0% · top 10 100.0% · top 20 100.0% · HHI 0.3333 · Gini 0");
  });
});

describe("TokenPanel signal values that are not in the expected range", () => {
  function withSignal(d: TokenData, id: string, value: number): TokenData {
    const signals = d.risk.report.signals.map((s) => (s.id === id ? { ...s, value } : s));
    return { ...d, risk: { ...d.risk, report: { ...d.risk.report, signals } } };
  }
  function valueOf(d: TokenData, label: string): string {
    const row = tableRows(renderToStaticMarkup(<TokenPanel detail={d} quote={SOL} />), "Risk signals").find((r) => r[0] === label);
    if (row === undefined) throw new Error(`no signal row "${label}"`);
    return row[1]!;
  }
  const d = tokenData("TOK5");

  it("falls back to a plain number instead of crashing or printing a wrong percentage or age", () => {
    expect(valueOf(withSignal(d, "top10Share", 2), "Top-10 holders' share of supply")).toBe("2");
    expect(valueOf(withSignal(d, "top10Share", -0.5), "Top-10 holders' share of supply")).toBe("-0.5");
    expect(valueOf(withSignal(d, "creatorShare", 1.5), "Creator's share of supply")).toBe("1.5");
    expect(valueOf(withSignal(d, "age", -5), "Token age")).toBe("-5");
    expect(valueOf(withSignal(d, "age", 1.5), "Token age")).toBe("1.5");
  });

  it("still prints the edges of the range as percentages", () => {
    expect(valueOf(withSignal(d, "top10Share", 0), "Top-10 holders' share of supply")).toBe("0.0%");
    expect(valueOf(withSignal(d, "top10Share", 1), "Top-10 holders' share of supply")).toBe("100.0%");
    expect(valueOf(withSignal(d, "age", 0), "Token age")).toBe("0s");
  });

  it("does not turn other signals into percentages or ages", () => {
    expect(valueOf(withSignal(d, "hhi", 0.5), "Holder concentration (HHI)")).toBe("0.5");
    expect(valueOf(withSignal(d, "hhi", 86_400_000), "Holder concentration (HHI)")).toBe("86,400,000");
  });

  it("greys out the rows whose value is unknown, and only those", () => {
    const html = renderToStaticMarkup(<TokenPanel detail={d} quote={SOL} />);
    const body = /<table[^>]*aria-label="Risk signals"[^>]*>.*?<tbody>(.*?)<\/tbody>/s.exec(html)![1]!;
    expect([...body.matchAll(/<tr class="muted">/g)]).toHaveLength(4); // creatorDumps, liquidity, clustering, washTrading
    expect([...body.matchAll(/<tr>/g)]).toHaveLength(6);
  });
});

describe("TokenPanel with missing data", () => {
  it("says there is no holder snapshot instead of showing empty tables", () => {
    const out = renderToStaticMarkup(<TokenPanel detail={{ ...tokenData("TOK5"), concentration: null }} quote={SOL} />);
    expect(plain(out)).toContain("No holder snapshot at or before this time.");
    expect(out).not.toContain('aria-label="Top holders"');
  });

  it("says there are no trades instead of showing an empty table", () => {
    const out = renderToStaticMarkup(<TokenPanel detail={{ ...tokenData("TOK5"), recentTrades: [], lastPrice: null }} quote={SOL} />);
    expect(plain(out)).toContain("No trades at or before this time.");
    expect(plain(out)).toContain("Last price —");
    expect(out).not.toContain('aria-label="Recent trades"');
  });

  it("shows the address in place of a missing symbol and an unknown creator", () => {
    const d = tokenData("TOK5");
    const out = renderToStaticMarkup(<TokenPanel detail={{ ...d, info: { ...d.info, symbol: null, creator: null } }} quote={SOL} />);
    expect(plain(out)).toContain("TOK5 TOK5");
    expect(plain(out)).toContain("creator unknown");
  });
});
