import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReplayAdapter, Store, ingest, parseFixture } from "@memelens/data";
import { SampleUserError } from "@memelens/service";
import { afterEach, describe, expect, it } from "vitest";
import { createSampleService } from "../src/main/sample";

const FIXTURE_PATH = fileURLToPath(new URL("../../../packages/data/fixtures/sample.json", import.meta.url));
const SAMPLE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { chain: string; tokens: unknown[]; trades: unknown[] };

const stores: Store[] = [];
function freshStore(): Store {
  const s = Store.open(":memory:");
  stores.push(s);
  return s;
}
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});
function setup(over: { store?: Store; sample?: unknown } = {}) {
  const store = over.store ?? freshStore();
  const logs: string[] = [];
  const service = createSampleService({ store, sample: over.sample ?? SAMPLE, log: (l) => logs.push(l) });
  return { store, logs, service };
}
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SampleUserError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal, but it resolved");
}

describe("the bundled sample", () => {
  it("is a valid fixture that ingests with nothing rejected: if this fails, the first-run button would hand people a broken sample", async () => {
    const store = freshStore();
    const report = await ingest(store, new ReplayAdapter(parseFixture(SAMPLE)));
    expect(report.tokens.rejected + report.trades.rejected + report.snapshots.rejected).toBe(0);
    expect(report.tokens.inserted).toBe(SAMPLE.tokens.length);
    expect(report.trades.inserted).toBe(SAMPLE.trades.length);
  });
});

describe("createSampleService: loading into an empty database", () => {
  it("loads the whole sample and says what it loaded", async () => {
    const { store, service } = setup();
    expect(store.chains()).toEqual([]);
    const loaded = await service.load();
    expect(loaded).toEqual({ chain: SAMPLE.chain, tokens: SAMPLE.tokens.length, trades: SAMPLE.trades.length });
    expect(store.chains()).toEqual([SAMPLE.chain]);
    expect(store.counts(SAMPLE.chain)).toMatchObject({ tokens: SAMPLE.tokens.length, trades: SAMPLE.trades.length, rejects: 0 });
  });
  it("loads the same data the command line loads (nothing added, nothing dropped)", async () => {
    const viaButton = setup();
    await viaButton.service.load();
    const viaCli = freshStore();
    await ingest(viaCli, new ReplayAdapter(parseFixture(SAMPLE)));
    expect(viaButton.store.counts()).toEqual(viaCli.counts());
    expect(viaButton.store.chains()).toEqual(viaCli.chains());
  });
  it("writes a line to the log", async () => {
    const { service, logs } = setup();
    await service.load();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(SAMPLE.chain);
    expect(logs[0]).toContain(String(SAMPLE.trades.length));
  });
});

describe("createSampleService: it never adds to data that is already there", () => {
  it("refuses a database that holds a different chain's data, and writes nothing", async () => {
    const store = freshStore();
    const other = { ...SAMPLE, chain: "someother" };
    await ingest(store, new ReplayAdapter(parseFixture(other)));
    const before = store.counts();
    const { service } = setup({ store });
    expect(await refusal(service.load())).toBe("this database already holds data; the sample is only loaded into an empty one");
    expect(store.counts()).toEqual(before);
    expect(store.chains()).toEqual(["someother"]);
  });
  it("refuses a second load after a first", async () => {
    const { store, service } = setup();
    await service.load();
    const after = store.counts();
    expect(await refusal(service.load())).toBe("this database already holds data; the sample is only loaded into an empty one");
    expect(store.counts()).toEqual(after);
  });
  it("counts a database with only tokens, or only trades, as not empty", async () => {
    const onlyTokens = freshStore();
    const tokensOnly = { ...SAMPLE, trades: [], snapshots: [] };
    await ingest(onlyTokens, new ReplayAdapter(parseFixture(tokensOnly)));
    expect(await refusal(setup({ store: onlyTokens }).service.load())).toMatch(/already holds data/);
  });
});

describe("createSampleService: two clicks at once", () => {
  it("lets the first through and refuses the second while the first is still loading", async () => {
    const { store, service } = setup();
    const first = service.load();
    const second = service.load();
    expect(await refusal(second)).toBe("the sample is already loading");
    expect(await first).toEqual({ chain: SAMPLE.chain, tokens: SAMPLE.tokens.length, trades: SAMPLE.trades.length });
    expect(store.counts(SAMPLE.chain).trades).toBe(SAMPLE.trades.length); // loaded once, not twice
  });
  it("is usable again after a failure, because the 'loading' flag is released", async () => {
    const real = freshStore();
    let failures = 1;
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "chains" && failures-- > 0) return () => { throw new Error("disk hiccup"); };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const { service } = setup({ store: flaky });
    await expect(service.load()).rejects.toThrow("disk hiccup");
    expect((await service.load()).chain).toBe(SAMPLE.chain);
  });
});

describe("createSampleService: a sample that cannot be used", () => {
  it("passes a malformed sample on as an ordinary error (not a message for the window) and writes nothing", async () => {
    const { store, service } = setup({ sample: { format: "memelens-fixture", version: 1 } });
    const e = await service.load().catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(SampleUserError);
    expect(store.chains()).toEqual([]);
  });
  it("calls it an ordinary error if the sample had rejected items, rather than reporting success", async () => {
    // the same holder twice in one snapshot passes the fixture's shape check and is rejected by the ingest validator
    // ("holding-address-duplicate")
    const first = (SAMPLE as unknown as { snapshots: { token: string; time: number; holdings: { address: string; amount: string }[] }[] }).snapshots[0]!;
    const dup = { ...first, token: "TOKDUP", holdings: [...first.holdings, first.holdings[0]!] };
    const bad = { ...SAMPLE, snapshots: [...(SAMPLE as unknown as { snapshots: unknown[] }).snapshots, dup] };
    const e = await setup({ sample: bad }).service.load().catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(SampleUserError);
    expect((e as Error).message).toMatch(/rejected/);
  });
});
