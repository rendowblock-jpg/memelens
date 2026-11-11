import type { Api, Channel } from "@memelens/service";

/**
 * The preload script runs sandboxed and can load almost nothing, so it cannot import the channel list from the
 * service package (which pulls in the database). The list is repeated here; a test keeps the two equal.
 */
export const PRELOAD_CHANNELS = ["overview", "feed", "token", "wallet", "smart"] as const satisfies readonly Channel[];

export type Invoke = (channel: string, payload: unknown) => Promise<unknown>;

/** The object the page sees as `window.memelens`. Its functions never reject. */
export function createApi(invoke: Invoke): Api {
  const api: Record<string, (request: unknown) => Promise<unknown>> = {};
  for (const channel of PRELOAD_CHANNELS) {
    api[channel] = async (request) => {
      try {
        return await invoke(channel, request);
      } catch {
        // The reason is not passed on: it could name paths or internals the page has no business seeing.
        return { ok: false, error: "request failed" };
      }
    };
  }
  return Object.freeze(api) as unknown as Api;
}
