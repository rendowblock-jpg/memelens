#!/usr/bin/env node
// The process that runs on the build host: `memelens-collector run --state FILE` and `memelens-collector status --state FILE`.
// Glue only; what it does is tested in packages/collector/test (the network is replaced there by recorded replies).
import { writeFileSync } from "node:fs";
import { formatExportSummary, formatLabelSummary, formatStats, parseCliArgs, UsageError } from "./cli";
import { exportFromStored } from "./export";
import { labelStored, summarizeLabels, type LabelRow } from "./load";
import { PoliteClient } from "./http";
import { Collector } from "./runner";
import { CollectorStore } from "./store";

const USER_AGENT = "memelens-calibration/0.1 (research, read-only; https://github.com/rendowblock-jpg/memelens)";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === "export") {
    const store = CollectorStore.openReadOnly(args.state);
    const result = exportFromStored(store.doneSnapshots(), { minCensus: args.minCensus });
    store.close();
    writeFileSync(args.out, JSON.stringify(result.fixture));
    console.log(formatExportSummary(result.summary));
    for (const u of result.unreadable.slice(0, 10)) console.log(`unreadable ${u.mint}: ${u.why}`);
    console.log(`wrote ${result.fixture.tokens.length} tokens to ${args.out}`);
    return;
  }
  if (args.command === "label") {
    const store = CollectorStore.openReadOnly(args.state);
    const rows: LabelRow[] = [];
    for (const token of store.storedTokens()) {
      const r = labelStored(token);
      rows.push({ mint: token.mint, createdAt: token.createdAt, label: r.label, reason: r.reason });
    }
    store.close();
    writeFileSync(args.out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""));
    console.log(formatLabelSummary(summarizeLabels(rows)));
    console.log(`wrote ${rows.length} labels to ${args.out}`);
    return;
  }
  const store = new CollectorStore(args.state);
  if (args.command === "status") {
    console.log(formatStats(store.stats()));
    console.log(`discovery started: ${store.getMeta("discovery_started_at") === null ? "not yet" : new Date(Number(store.getMeta("discovery_started_at"))).toISOString()}`);
    store.close();
    return;
  }

  const client = new PoliteClient({
    fetch: (url, init) => fetch(url, { headers: init.headers, signal: AbortSignal.timeout(30_000) }),
    sleep,
    now: Date.now,
    userAgent: USER_AGENT,
    // GeckoTerminal's public limit is 30 calls a minute; this stays at 24. RugCheck publishes none; 40 a minute is polite.
    minIntervalMs: { "api.geckoterminal.com": 2500, "api.rugcheck.xyz": 1500 },
  });
  const collector = new Collector({ store, client, now: Date.now, rate: args.rate, windowMs: args.windowHours * 3_600_000, log: stamp });
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => ((stopping = true), stamp(`${signal}: finishing the current step, then stopping`)));

  stamp(`collector started: state ${args.state}, rate ${args.rate}, window ${args.windowHours} h`);
  let nextDiscovery = 0;
  let nextStats = Date.now() + 600_000;
  while (!stopping) {
    try {
      const now = Date.now();
      let windowClosed = false;
      if (now >= nextDiscovery) {
        const found = await collector.discover();
        nextDiscovery = Date.now() + args.discoverEverySeconds * 1000;
        windowClosed = found.windowClosed;
        if (found.error !== undefined) stamp(`discover failed: ${found.error}`);
      }
      const work = await collector.workOne();
      if (Date.now() >= nextStats) {
        stamp(`stats\n${formatStats(store.stats())}`);
        nextStats = Date.now() + 600_000;
      }
      if (work.status === "idle") {
        const pending = Object.values(store.stats().tasks).reduce((n, byStatus) => n + (byStatus["pending"] ?? 0), 0);
        if (windowClosed && pending === 0) {
          stamp("discovery is over and no task is pending: finished");
          break;
        }
        await sleep(1000);
      }
    } catch (error) {
      stamp(`unexpected: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      await sleep(5000);
    }
  }
  stamp(`stopped\n${formatStats(store.stats())}`);
  store.close();
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\nusage: memelens-collector run --state FILE [--rate 0.1] [--window-hours 72] [--discover-every 20]\n       memelens-collector status --state FILE\n       memelens-collector export --state FILE --out FIXTURE.json [--min-census 100]\n       memelens-collector label --state FILE --out LABELS.jsonl`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
