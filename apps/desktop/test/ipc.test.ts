import { Store } from "@memelens/data";
import { CHANNELS, ENGINE_CHANNELS, SAMPLE_CHANNELS, STORE_CHANNELS, type EngineService, type SampleService } from "@memelens/service";
import { afterEach, describe, expect, it } from "vitest";
import { registerEngineIpc, registerIpc, registerSampleIpc, UNTRUSTED_SENDER, type IpcEventLike } from "../src/main/ipc";

type Listener = (event: IpcEventLike, payload: unknown) => unknown;

function fakeIpcMain() {
  const listeners = new Map<string, Listener>();
  const order: string[] = [];
  return {
    listeners,
    order,
    handle(channel: string, listener: Listener) {
      if (listeners.has(channel)) throw new Error(`second handler for ${channel}`);
      listeners.set(channel, listener);
      order.push(channel);
    },
  };
}

const app: IpcEventLike = { senderFrame: { url: "app://memelens/index.html" } };
const stores: Store[] = [];
function freshStore(): Store {
  const s = Store.open(":memory:");
  stores.push(s);
  return s;
}
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

describe("registerIpc", () => {
  it("registers each API channel exactly once and nothing else", () => {
    const ipc = fakeIpcMain();
    registerIpc(ipc, freshStore());
    expect([...ipc.order].sort()).toEqual([...STORE_CHANNELS].sort());
  });

  it("answers a frame on the app origin through the request handler", async () => {
    const ipc = fakeIpcMain();
    registerIpc(ipc, freshStore());
    const reply = await ipc.listeners.get("overview")!(app, {});
    expect(reply).toMatchObject({ ok: true });
  });

  it("passes the payload to the handler for the channel it was registered for", async () => {
    const ipc = fakeIpcMain();
    registerIpc(ipc, freshStore());
    // The overview channel takes no payload, so the handler's own check answers.
    expect(await ipc.listeners.get("overview")!(app, { chain: "x" })).toEqual({
      ok: false,
      error: 'overview: unknown field "chain"',
    });
    // A payload cannot choose another channel: the channel comes from the registration, not from the page.
    expect(await ipc.listeners.get("feed")!(app, { channel: "overview" })).toEqual({
      ok: false,
      error: 'feed: unknown field "channel"',
    });
  });

  it("refuses frames from any other origin without touching the store", async () => {
    let touched = 0;
    const store = new Proxy(freshStore(), {
      get(target, prop, receiver) {
        touched++;
        return Reflect.get(target, prop, receiver);
      },
    });
    const errors: unknown[] = [];
    const ipc = fakeIpcMain();
    registerIpc(ipc, store, (e) => errors.push(e));

    const senders: unknown[] = [
      { senderFrame: null },
      { senderFrame: { url: "" } },
      { senderFrame: { url: "https://evil.example/" } },
      { senderFrame: { url: "file:///C:/x.html" } },
      { senderFrame: { url: "app://memelens.evil.example/" } },
      { senderFrame: { url: "app://u:p@memelens/" } },
      { senderFrame: { url: "about:blank" } },
      { senderFrame: {} },
      { senderFrame: { url: 42 } },
      { senderFrame: { url: { toString: () => "app://memelens/index.html" } } },
      { senderFrame: { url: new URL("app://memelens/index.html") } },
      {},
      null,
      undefined,
    ];
    for (const channel of STORE_CHANNELS) {
      for (const sender of senders) {
        const reply = await ipc.listeners.get(channel)!(sender as IpcEventLike, {});
        expect(reply, `${channel} ${JSON.stringify(sender)}`).toEqual({ ok: false, error: UNTRUSTED_SENDER });
      }
    }
    expect(touched).toBe(0);
    expect(errors).toEqual([]);
  });

  it("never throws, even when the store fails: the page sees only 'internal error'", async () => {
    const store = freshStore();
    store.close();
    stores.pop();
    const errors: unknown[] = [];
    const ipc = fakeIpcMain();
    registerIpc(ipc, store, (e) => errors.push(e));
    const reply = await ipc.listeners.get("overview")!(app, {});
    expect(reply).toEqual({ ok: false, error: "internal error" });
    expect(errors).toHaveLength(1);
  });

  it("uses no error sink when none is given", async () => {
    const store = freshStore();
    store.close();
    stores.pop();
    const ipc = fakeIpcMain();
    registerIpc(ipc, store);
    expect(await ipc.listeners.get("overview")!(app, {})).toEqual({ ok: false, error: "internal error" });
  });
});

function fakeEngine(): { engine: EngineService; touched: () => number } {
  let touched = 0;
  const note = <T>(v: T) => (): T => (touched++, v);
  const engine: EngineService = {
    status: note({ installed: null, running: false, busy: false, problem: null, canUpdate: false, offered: null }),
    run: async () => (touched++, { engineVersion: "1.0.0", specHash: "h", dataAsOf: null, positions: [], summary: {} } as never),
    cancel: note(false),
    check: async () => (touched++, { kind: "up-to-date" as const, version: "1.0.0" }),
    install: async () => (touched++, { version: "1.0.0" }),
  };
  return { engine, touched: () => touched };
}

describe("registerEngineIpc", () => {
  it("registers each engine channel exactly once and nothing else", () => {
    const ipc = fakeIpcMain();
    registerEngineIpc(ipc, fakeEngine().engine);
    expect([...ipc.order].sort()).toEqual([...ENGINE_CHANNELS].sort());
  });

  it("registers together with the data and sample channels without a clash, and the three make up every channel", () => {
    const ipc = fakeIpcMain();
    registerIpc(ipc, freshStore());
    registerEngineIpc(ipc, fakeEngine().engine);
    registerSampleIpc(ipc, fakeSample().service);
    expect([...ipc.order].sort()).toEqual([...CHANNELS].sort());
  });

  it("answers a frame on the app origin through the engine", async () => {
    const ipc = fakeIpcMain();
    const { engine, touched } = fakeEngine();
    registerEngineIpc(ipc, engine);
    expect(await ipc.listeners.get("engineStatus")!(app, undefined)).toEqual({ ok: true, data: { installed: null, running: false, busy: false, problem: null, canUpdate: false, offered: null } });
    expect(await ipc.listeners.get("engineCheck")!(app, {})).toEqual({ ok: true, data: { kind: "up-to-date", version: "1.0.0" } });
    expect(touched()).toBe(2);
  });

  it("takes the channel from the registration, never from the payload", async () => {
    const ipc = fakeIpcMain();
    const { engine, touched } = fakeEngine();
    registerEngineIpc(ipc, engine);
    expect(await ipc.listeners.get("engineStatus")!(app, { channel: "engineInstall" })).toEqual({ ok: false, error: "engineStatus: takes no payload" });
    expect(await ipc.listeners.get("engineRun")!(app, { spec: {}, channel: "engineInstall" })).toEqual({ ok: false, error: 'engineRun: unknown field "channel"' });
    expect(touched()).toBe(0);
  });

  it("refuses frames from any other origin without touching the engine", async () => {
    const errors: unknown[] = [];
    let touched = 0;
    const real = fakeEngine().engine;
    const engine = new Proxy(real, { get: (t, p, r) => (touched++, Reflect.get(t, p, r)) });
    const ipc = fakeIpcMain();
    registerEngineIpc(ipc, engine, (e) => errors.push(e));
    const senders: unknown[] = [
      { senderFrame: null }, { senderFrame: { url: "" } }, { senderFrame: { url: "https://evil.example/" } }, { senderFrame: { url: "file:///C:/x.html" } },
      { senderFrame: { url: "app://memelens.evil.example/" } }, { senderFrame: { url: "app://u:p@memelens/" } }, { senderFrame: { url: "about:blank" } },
      { senderFrame: {} }, { senderFrame: { url: 42 } }, { senderFrame: { url: new URL("app://memelens/index.html") } }, {}, null, undefined,
    ];
    for (const channel of ENGINE_CHANNELS) {
      for (const sender of senders) {
        const reply = await ipc.listeners.get(channel)!(sender as IpcEventLike, channel === "engineRun" ? { spec: {} } : {});
        expect(reply, `${channel} ${JSON.stringify(sender)}`).toEqual({ ok: false, error: UNTRUSTED_SENDER });
      }
    }
    expect(touched).toBe(0);
    expect(errors).toEqual([]);
  });

  it("never throws: an engine failure reaches the page only as 'internal error' and reaches the sink in full", async () => {
    const errors: unknown[] = [];
    const boom = new Error("C:\\secret\\path");
    const ipc = fakeIpcMain();
    registerEngineIpc(ipc, { ...fakeEngine().engine, status: () => { throw boom; } }, (e) => errors.push(e));
    expect(await ipc.listeners.get("engineStatus")!(app, {})).toEqual({ ok: false, error: "internal error" });
    expect(errors).toEqual([boom]);
  });

  it("uses no error sink when none is given", async () => {
    const ipc = fakeIpcMain();
    registerEngineIpc(ipc, { ...fakeEngine().engine, status: () => { throw new Error("x"); } });
    expect(await ipc.listeners.get("engineStatus")!(app, {})).toEqual({ ok: false, error: "internal error" });
  });
});

function fakeSample(): { service: SampleService; touched: () => number } {
  let touched = 0;
  return { service: { load: async () => (touched++, { chain: "synthetic", tokens: 5, trades: 40 }) }, touched: () => touched };
}

describe("registerSampleIpc", () => {
  it("registers the sample channel exactly once and nothing else", () => {
    const ipc = fakeIpcMain();
    registerSampleIpc(ipc, fakeSample().service);
    expect([...ipc.order]).toEqual([...SAMPLE_CHANNELS]);
  });

  it("answers a frame on the app origin", async () => {
    const ipc = fakeIpcMain();
    const { service, touched } = fakeSample();
    registerSampleIpc(ipc, service);
    expect(await ipc.listeners.get("loadSample")!(app, undefined)).toEqual({ ok: true, data: { chain: "synthetic", tokens: 5, trades: 40 } });
    expect(touched()).toBe(1);
  });

  it("refuses a payload, and takes the channel from the registration, never from the page", async () => {
    const ipc = fakeIpcMain();
    const { service, touched } = fakeSample();
    registerSampleIpc(ipc, service);
    expect(await ipc.listeners.get("loadSample")!(app, { channel: "engineInstall", path: "C:\\x" })).toEqual({ ok: false, error: "loadSample: takes no payload" });
    expect(touched()).toBe(0);
  });

  it("refuses frames from any other origin without touching the service: this is the one channel that writes", async () => {
    const errors: unknown[] = [];
    const { service, touched } = fakeSample();
    const ipc = fakeIpcMain();
    registerSampleIpc(ipc, service, (e) => errors.push(e));
    const senders: unknown[] = [
      { senderFrame: null }, { senderFrame: { url: "" } }, { senderFrame: { url: "https://evil.example/" } }, { senderFrame: { url: "file:///C:/x.html" } },
      { senderFrame: { url: "app://memelens.evil.example/" } }, { senderFrame: { url: "app://u:p@memelens/" } }, { senderFrame: { url: "about:blank" } },
      { senderFrame: {} }, { senderFrame: { url: 42 } }, { senderFrame: { url: new URL("app://memelens/index.html") } }, {}, null, undefined,
    ];
    for (const sender of senders) {
      expect(await ipc.listeners.get("loadSample")!(sender as IpcEventLike, {}), JSON.stringify(sender)).toEqual({ ok: false, error: UNTRUSTED_SENDER });
    }
    expect(touched()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("never throws: a failure reaches the page only as 'internal error' and reaches the sink in full", async () => {
    const errors: unknown[] = [];
    const boom = new Error("C:\\secret\\path");
    const ipc = fakeIpcMain();
    registerSampleIpc(ipc, { load: async () => { throw boom; } }, (e) => errors.push(e));
    expect(await ipc.listeners.get("loadSample")!(app, {})).toEqual({ ok: false, error: "internal error" });
    expect(errors).toEqual([boom]);
  });
});

