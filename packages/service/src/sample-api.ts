import { isPlainObject } from "./checks";
import { toWire } from "./wire";

export const SAMPLE_CHANNELS = ["loadSample"] as const;
export type SampleChannel = (typeof SAMPLE_CHANNELS)[number];

export interface SampleLoaded {
  chain: string;
  tokens: number;
  trades: number;
}

/** What the main process offers the window for the one action that writes to the database: loading the bundled sample. */
export interface SampleService {
  load(): Promise<SampleLoaded>;
}

/** An expected problem whose message is safe to show in the window. */
export class SampleUserError extends Error {}

export interface SampleRequests {
  loadSample: Record<string, never>;
}

export interface SampleResponses {
  loadSample: SampleLoaded;
}

export type SampleReply = { ok: true; data: SampleLoaded } | { ok: false; error: string };

class BadRequest extends Error {}

/**
 * Handles the one write the window may ask for. Like `handle` and `handleEngine` it never throws: the channel and payload are
 * checked first, a problem the user can read comes back as its message, and anything else comes back as "internal error".
 */
export async function handleSample(service: SampleService, channel: unknown, payload: unknown, onError?: (e: unknown) => void): Promise<SampleReply> {
  try {
    if (typeof channel !== "string" || !(SAMPLE_CHANNELS as readonly string[]).includes(channel)) throw new BadRequest("unknown channel");
    if (!(payload === undefined || (isPlainObject(payload) && Object.keys(payload).length === 0))) throw new BadRequest(`${channel}: takes no payload`);
    return { ok: true, data: toWire(await service.load()) };
  } catch (e) {
    if (e instanceof BadRequest || e instanceof SampleUserError) return { ok: false, error: e.message };
    try {
      onError?.(e);
    } catch {
      // A broken sink must not turn into a thrown error in the main process.
    }
    return { ok: false, error: "internal error" };
  }
}
