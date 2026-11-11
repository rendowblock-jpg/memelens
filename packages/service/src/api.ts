import type { Store } from "@memelens/data";
import {
  feed,
  overview,
  ServiceError,
  smartDetail,
  tokenDetail,
  walletDetail,
  type Feed,
  type Overview,
  type SmartDetail,
  type TokenDetail,
  type WalletDetail,
} from "./service";
import { toWire, type Wire } from "./wire";

/** Every message the app window can send to the main process. */
export const CHANNELS = ["overview", "feed", "token", "wallet", "smart"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ApiRequests {
  overview: Record<string, never>;
  feed: { chain: string; asOf?: number };
  token: { chain: string; token: string; asOf?: number };
  wallet: { chain: string; wallet: string; asOf?: number };
  smart: { chain: string; from: number; to: number; minClosed?: number };
}

export interface ApiResponses {
  overview: Wire<Overview>;
  feed: Wire<Feed>;
  /** null when the token is unknown or did not exist yet at the as-of time. */
  token: Wire<TokenDetail> | null;
  wallet: Wire<WalletDetail>;
  smart: Wire<SmartDetail>;
}

export type Reply<C extends Channel = Channel> = { ok: true; data: ApiResponses[C] } | { ok: false; error: string };

/** What the window sees: one async function per channel. */
export type Api = { [C in Channel]: (request: ApiRequests[C]) => Promise<Reply<C>> };

export type ErrorSink = (error: unknown) => void;

/**
 * Handles one message from the window. The window is not trusted: the channel and payload are checked, and this
 * function never throws. Expected problems come back as `{ ok: false, error }` with a readable message;
 * anything unexpected comes back as "internal error" (the details go to `onError`, not to the window).
 */
export function handle(store: Store, channel: unknown, payload: unknown, onError?: ErrorSink): Reply {
  try {
    if (typeof channel !== "string" || !(CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequest("unknown channel");
    }
    const ch = channel as Channel;
    const v = check(ch, payload);
    const text = (name: string): string => v[name] as string;
    const time = (name: string): number | undefined => v[name] as number | undefined;

    let data: unknown;
    switch (ch) {
      case "overview":
        data = overview(store);
        break;
      case "feed":
        data = feed(store, text("chain"), time("asOf"));
        break;
      case "token":
        data = tokenDetail(store, text("chain"), text("token"), time("asOf"));
        break;
      case "wallet":
        data = walletDetail(store, text("chain"), text("wallet"), time("asOf"));
        break;
      case "smart": {
        const minClosed = time("minClosed");
        data = smartDetail(store, text("chain"), {
          from: time("from")!,
          to: time("to")!,
          ...(minClosed === undefined ? {} : { minClosed }),
        });
        break;
      }
    }
    return { ok: true, data: toWire(data) as ApiResponses[Channel] };
  } catch (e) {
    if (e instanceof BadRequest || e instanceof ServiceError) return { ok: false, error: e.message };
    try {
      onError?.(e);
    } catch {
      // A broken sink must not turn into a thrown error in the main process.
    }
    return { ok: false, error: "internal error" };
  }
}

// --------------------------------------------------------------------------------------------- checking

class BadRequest extends Error {}

type Kind = "text" | "time" | "count";
interface Field {
  kind: Kind;
  required: boolean;
}

const text = (required = true): Field => ({ kind: "text", required });
const time = (required = false): Field => ({ kind: "time", required });

const FIELDS: Record<Channel, Record<string, Field>> = {
  overview: {},
  feed: { chain: text(), asOf: time() },
  token: { chain: text(), token: text(), asOf: time() },
  wallet: { chain: text(), wallet: text(), asOf: time() },
  smart: { chain: text(), from: time(true), to: time(true), minClosed: { kind: "count", required: false } },
};

// Addresses and chain ids never contain spaces or control characters.
const TEXT = /^[^\s\u0000-\u001f\u007f]{1,200}$/u;

const MESSAGE: Record<Kind, string> = {
  text: "must be text of 1 to 200 characters with no spaces",
  time: "must be a whole number of milliseconds, 0 or more",
  count: "must be a whole number of at least 1",
};

function valid(kind: Kind, value: unknown): boolean {
  if (kind === "text") return typeof value === "string" && TEXT.test(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  return kind === "time" ? value >= 0 : value >= 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Returns the checked fields of the payload; throws BadRequest naming the first problem. */
function check(channel: Channel, payload: unknown): Record<string, unknown> {
  const spec = FIELDS[channel];
  if (channel === "overview" && payload === undefined) return {};
  if (!isPlainObject(payload)) {
    throw new BadRequest(channel === "overview" ? "overview: takes no payload" : `${channel}: payload must be an object`);
  }
  const unknown = Object.keys(payload).filter((k) => !Object.hasOwn(spec, k));
  if (unknown.length > 0) {
    throw new BadRequest(`${channel}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => JSON.stringify(k)).join(", ")}`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec)) {
    const value = payload[name];
    if (value === undefined) {
      if (field.required) throw new BadRequest(`${channel}: ${name} is required`);
      continue;
    }
    if (!valid(field.kind, value)) throw new BadRequest(`${channel}: ${name} ${MESSAGE[field.kind]}`);
    out[name] = value;
  }
  return out;
}
