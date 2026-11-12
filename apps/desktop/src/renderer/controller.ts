import type { Api, ApiRequests, ApiResponses, Channel } from "@memelens/service";
import { FormatError } from "./format";
import { smartWindow, type SmartSpan } from "./model";

// Loads the data for each screen through window.memelens and turns every outcome into a value the screen can show.
// Nothing here throws: a failed or malformed reply becomes { state: "error" } with a message.

export type Loaded<T> = { state: "ok"; data: T } | { state: "error"; message: string };

/** The smart-money screen asks for this explicitly, so the screen and the engine agree on it by construction. */
export const MIN_CLOSED_TOKENS = 5;

const FAILED = "request failed";
const UNEXPECTED = "the app gave an unexpected reply";

const fail = (message: string): { state: "error"; message: string } => ({ state: "error", message });

/** The first chain that has any data (time 0 counts), or null. */
export function pickChain(chains: readonly { chain: string; latestTime: number | null }[]): string | null {
  return chains.find((c) => c.latestTime !== null)?.chain ?? null;
}

async function call<C extends Channel>(api: Api, channel: C, request: ApiRequests[C]): Promise<Loaded<ApiResponses[C]>> {
  let reply: unknown;
  try {
    reply = await api[channel](request);
  } catch {
    // The reason is not shown: it could name paths or internals.
    return fail(FAILED);
  }
  if (typeof reply !== "object" || reply === null || typeof (reply as { ok?: unknown }).ok !== "boolean") return fail(UNEXPECTED);
  const r = reply as { ok: boolean; data?: unknown; error?: unknown };
  if (r.ok) return { state: "ok", data: r.data as ApiResponses[C] };
  return fail(typeof r.error === "string" && r.error !== "" ? r.error : FAILED);
}

export const loadOverview = (api: Api): Promise<Loaded<ApiResponses["overview"]>> => call(api, "overview", {});

export const loadFeed = (api: Api, chain: string, asOf?: number): Promise<Loaded<ApiResponses["feed"]>> =>
  call(api, "feed", asOf === undefined ? { chain } : { chain, asOf });

export const loadToken = (api: Api, chain: string, token: string, asOf?: number): Promise<Loaded<ApiResponses["token"]>> =>
  call(api, "token", asOf === undefined ? { chain, token } : { chain, token, asOf });

export const loadWallet = (api: Api, chain: string, wallet: string, asOf?: number): Promise<Loaded<ApiResponses["wallet"]>> =>
  call(api, "wallet", asOf === undefined ? { chain, wallet } : { chain, wallet, asOf });

export async function loadSmart(api: Api, chain: string, latest: number, span: SmartSpan): Promise<Loaded<ApiResponses["smart"]>> {
  let window: { from: number; to: number };
  try {
    window = smartWindow(latest, span);
  } catch (e) {
    return fail(e instanceof FormatError ? e.message : FAILED);
  }
  return call(api, "smart", { chain, ...window, minClosed: MIN_CLOSED_TOKENS });
}
