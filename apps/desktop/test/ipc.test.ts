import { Store } from "@memelens/data";
import { CHANNELS } from "@memelens/service";
import { afterEach, describe, expect, it } from "vitest";
import { registerIpc, UNTRUSTED_SENDER, type IpcEventLike } from "../src/main/ipc";

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
    expect([...ipc.order].sort()).toEqual([...CHANNELS].sort());
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
    for (const channel of CHANNELS) {
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
