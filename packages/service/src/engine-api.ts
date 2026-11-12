import type { BacktestReport, BacktestSpec } from "@memelens/sidecar";
import { isPlainObject, TEXT } from "./checks";
import { toWire } from "./wire";

export const ENGINE_CHANNELS = ["engineStatus", "engineRun", "engineCancel", "engineCheck", "engineInstall"] as const;
export type EngineChannel = (typeof ENGINE_CHANNELS)[number];

export interface EngineStatusInfo {
  /** The installed engine's version, if it verifies right now. */
  installed: string | null;
  running: boolean;
  busy: boolean;
  /** Why the engine is not usable, or what went wrong last. Null when nothing is wrong. */
  problem: string | null;
  /** Whether this build knows where to look for engine releases. */
  canUpdate: boolean;
  /** The version a check found and an install would put in place, if any. */
  offered: string | null;
}

export type UpdateInfo =
  | { kind: "up-to-date"; version: string }
  | { kind: "older"; latest: string; current: string }
  | { kind: "available"; version: string };

/** What the main process offers the window. Every method may throw EngineUserError for a problem the user can read. */
export interface EngineService {
  status(): EngineStatusInfo;
  run(spec: unknown, options: { chain?: string }): Promise<BacktestReport>;
  /** True if a run was running and was told to stop. */
  cancel(): boolean;
  check(): Promise<UpdateInfo>;
  install(): Promise<{ version: string }>;
}

/** An expected problem whose message is safe to show in the window: no paths, no addresses of internal things. */
export class EngineUserError extends Error {}

export interface EngineRequests {
  engineStatus: Record<string, never>;
  engineRun: { spec: BacktestSpec; chain?: string };
  engineCancel: Record<string, never>;
  engineCheck: Record<string, never>;
  engineInstall: Record<string, never>;
}

export interface EngineResponses {
  engineStatus: EngineStatusInfo;
  engineRun: BacktestReport;
  engineCancel: { cancelled: boolean };
  engineCheck: UpdateInfo;
  engineInstall: { version: string };
}

export type EngineReply = { ok: true; data: EngineResponses[EngineChannel] } | { ok: false; error: string };

class BadRequest extends Error {}

const NO_PAYLOAD: readonly EngineChannel[] = ["engineStatus", "engineCancel", "engineCheck", "engineInstall"];
const RUN_FIELDS = ["spec", "chain"];

/** Returns the checked request of engineRun; throws BadRequest naming the first problem. */
function checkRun(payload: unknown): { spec: Record<string, unknown>; chain?: string } {
  if (!isPlainObject(payload)) throw new BadRequest("engineRun: payload must be an object");
  const unknown = Object.keys(payload).filter((k) => !RUN_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw new BadRequest(`engineRun: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => JSON.stringify(k)).join(", ")}`);
  }
  const { spec, chain } = payload;
  if (spec === undefined) throw new BadRequest("engineRun: spec is required");
  if (!isPlainObject(spec)) throw new BadRequest("engineRun: spec must be an object");
  if (chain === undefined) return { spec };
  if (typeof chain !== "string" || !TEXT.test(chain)) throw new BadRequest("engineRun: chain must be text of 1 to 200 characters with no spaces");
  return { spec, chain };
}

/**
 * Handles one engine message from the window. Like `handle`, it never throws: the window is not trusted, the channel and
 * payload are checked first, a problem the user can read comes back as its message, and anything else comes back as
 * "internal error" (the details go to `onError`).
 */
export async function handleEngine(engine: EngineService, channel: unknown, payload: unknown, onError?: (e: unknown) => void): Promise<EngineReply> {
  try {
    if (typeof channel !== "string" || !(ENGINE_CHANNELS as readonly string[]).includes(channel)) throw new BadRequest("unknown channel");
    const ch = channel as EngineChannel;
    let data: unknown;
    if (ch === "engineRun") {
      const request = checkRun(payload);
      data = await engine.run(request.spec, request.chain === undefined ? {} : { chain: request.chain });
    } else {
      if (!(payload === undefined || (isPlainObject(payload) && Object.keys(payload).length === 0))) throw new BadRequest(`${ch}: takes no payload`);
      if (!NO_PAYLOAD.includes(ch)) throw new BadRequest("unknown channel");
      switch (ch) {
        case "engineStatus":
          data = engine.status();
          break;
        case "engineCancel":
          data = { cancelled: engine.cancel() };
          break;
        case "engineCheck":
          data = await engine.check();
          break;
        case "engineInstall":
          data = await engine.install();
          break;
      }
    }
    return { ok: true, data: toWire(data) as EngineResponses[EngineChannel] };
  } catch (e) {
    if (e instanceof BadRequest || e instanceof EngineUserError) return { ok: false, error: e.message };
    try {
      onError?.(e);
    } catch {
      // A broken sink must not turn into a thrown error in the main process.
    }
    return { ok: false, error: "internal error" };
  }
}
