// Builds apps/desktop/dist/preview: the built renderer plus a stand-in for window.memelens whose answers were
// produced by the real handler over the sample fixture. For inspecting the design with browser tools only; it is
// never shipped, and it is not the app (no Electron, no CSP). usage: node --import tsx scripts/preview-build.ts
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplayAdapter, Store, ingest, parseFixture } from "@memelens/data";
import { handle } from "@memelens/service";
import { MIN_CLOSED_TOKENS } from "../apps/desktop/src/renderer/controller";
import { smartWindow, type SmartSpan } from "../apps/desktop/src/renderer/model";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "apps/desktop/dist/preview");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "apps/desktop/dist/renderer"), out, { recursive: true });

const fixture = JSON.parse(readFileSync(join(root, "packages/data/fixtures/sample.json"), "utf8"));
const store = Store.open(":memory:");
await ingest(store, new ReplayAdapter(parseFixture(fixture)));
const chain: string = fixture.chain;
const latest = store.latestTime(chain)!;

const replies: Record<string, unknown> = {};
const key = (channel: string, request: object): string => `${channel}|${JSON.stringify(request)}`;
const ask = (channel: string, request: object): void => {
  replies[key(channel, request)] = handle(store, channel, request);
};
ask("overview", {});
ask("feed", { chain });
for (const t of fixture.tokens) ask("token", { chain, token: t.token });
for (const w of new Set<string>(fixture.trades.map((t: { wallet: string }) => t.wallet))) ask("wallet", { chain, wallet: w });
for (const span of ["1d", "7d", "30d", "all"] as SmartSpan[]) ask("smart", { chain, ...smartWindow(latest, span), minClosed: MIN_CLOSED_TOKENS });
store.close();

const shim = `// PREVIEW ONLY. Answers were produced by the real handler over the sample fixture.
const replies = ${JSON.stringify(replies)};
const sorted = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
const ask = (channel) => async (request) => replies[channel + "|" + JSON.stringify(request)] ?? { ok: false, error: "not in the preview data" };
const go = new URLSearchParams(location.search).get("go");
const when = (sel, then) => { const t = setInterval(() => { const el = document.querySelector(sel); if (el) { clearInterval(t); then(el); } }, 50); };
if (go) when(".token-panel .gauge", () => {
  const rail = (name) => [...document.querySelectorAll(".rail-item")].find((b) => b.textContent.includes(name));
  if (go === "tok1") document.querySelector('tr[data-token="TOK1"] button').click();
  if (go.startsWith("wallet-") || go === "smart") { rail("Smart").click(); }
  if (go.startsWith("wallet-")) when("table.smart-ranked", () => {
    const who = go.slice(7);
    const b = [...document.querySelectorAll("button.wallet")].find((x) => x.textContent === who);
    b.click();
  });
});
window.memelens = Object.freeze({ overview: ask("overview"), feed: ask("feed"), token: ask("token"), wallet: ask("wallet"), smart: ask("smart") });
`;
writeFileSync(join(out, "preview-data.js"), shim);
const html = readFileSync(join(out, "index.html"), "utf8").replace('<script type="module" src="main.js">', '<script src="preview-data.js"></script>\n    <script type="module" src="main.js">');
writeFileSync(join(out, "index.html"), html);
console.log("preview built:", out, Object.keys(replies).length, "replies");
