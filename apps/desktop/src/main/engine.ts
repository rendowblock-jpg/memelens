import { EngineUserError, type EngineService } from "@memelens/service";
import { checkForUpdate, installUpdate, LayoutError, ManagerError, resolveSidecarRoot, currentPlatform, type Platform, SidecarError, UpdateError, type BacktestReport, type CheckResult, type UpdateConfig, type UpdateOffer } from "@memelens/sidecar";

// The main process's side of the engine channels. It keeps the little state the window must not hold (the running backtest's
// cancel handle, the signed offer from the last check, "an install is under way") and turns every error into a fixed
// sentence: the engine, the updater and the operating system write messages with paths and addresses in them, and the
// window is told none of that. The original text goes to the log.

export interface EngineManager {
  status(): { installed: string | null; running: boolean; busy: boolean; problem: string | null };
  runBacktest(spec: unknown, options?: { chain?: string; signal?: AbortSignal }): Promise<BacktestReport>;
  stopIfIdle(): Promise<boolean>;
}

export interface EngineUpdater {
  config: UpdateConfig;
  /** Replaceable for tests. Default: the sidecar package's. */
  check?: (config: UpdateConfig) => Promise<CheckResult>;
  install?: (config: UpdateConfig, offer: UpdateOffer) => Promise<{ version: string }>;
}

export interface EngineDeps {
  manager: EngineManager;
  /** Absent when this build knows no place to fetch engine releases from. */
  update?: EngineUpdater;
  log: (line: string) => void;
}

const NO_SOURCE = "this build is not set up to fetch engine releases";
const UPDATING = "the engine is being updated; try again in a moment";
const BUSY_INSTALL = "a backtest is running; wait for it to finish, then install";

// What the engine may name as the place of a wrong field: "$.strategy.wallets[1]". Anything else is left out.
const FIELD_PATH = /^[A-Za-z0-9_$.[\]]{1,100}$/;

/** A message that is safe to show in the window for an error we expect, or null for one we do not. */
export function describeEngineError(e: unknown): string | null {
  if (e instanceof ManagerError) {
    switch (e.kind) {
      case "closed":
        return "the app is closing";
      case "busy":
        return "a backtest is already running";
      case "not-installed":
        return "the backtest engine is not installed";
      case "damaged":
        return "the installed engine failed its integrity check; install it again";
      case "start-failed":
        return "the engine could not be started";
      case "invalid-spec":
        return e.message; // names only a field of the request
    }
  }
  if (e instanceof SidecarError) {
    switch (e.kind) {
      case "cancelled":
        return "the backtest was cancelled";
      case "timeout":
        return "the backtest took too long and was stopped";
      case "remote":
        if (e.code === -32002) return "the engine could not read the trade database";
        if (e.code === -32003) return "the backtest needs more memory than the engine may use; try a shorter period or fewer wallets";
        if (e.code === -32602) {
          const path = (e.data as { path?: unknown } | null | undefined)?.path;
          return typeof path === "string" && FIELD_PATH.test(path) ? `the engine refused the request at ${path}` : "the engine refused the request";
        }
        return "the engine reported an error";
      case "exited":
      case "closed":
      case "protocol":
      case "spawn":
        return "the engine stopped unexpectedly";
    }
  }
  if (e instanceof UpdateError) {
    switch (e.kind) {
      case "config":
        return NO_SOURCE;
      case "download":
        return "could not download the engine; check the connection and try again";
      case "signature":
        return "the engine release is not signed by a trusted key; nothing was installed";
      case "manifest":
        return "the engine release information is not valid; nothing was installed";
      case "downgrade":
        return "that engine release is older than the installed one; nothing was installed";
      case "self-test":
        return "the new engine failed its self-test; nothing was installed";
      case "install":
        return "the engine could not be installed; the previous one is unchanged";
    }
  }
  return null;
}

export type SidecarSetup = { root: string } | { unavailable: string };

/**
 * Where the engine lives for this run: the per-user folder, or the folder MEMELENS_SIDECAR_DIR names. If that cannot be
 * worked out the app still starts (it works without an engine) and the engine says why it is unavailable. The reason never
 * contains the value of an environment variable.
 */
export function sidecarSetup(env: Record<string, string | undefined>, home: string, platform?: Platform): SidecarSetup {
  try {
    return { root: resolveSidecarRoot(platform ?? currentPlatform(), env, home) };
  } catch (e) {
    if (e instanceof LayoutError) return { unavailable: e.message };
    throw e;
  }
}

/** An engine that cannot be used at all, and says why. */
export function unavailableEngine(reason: string): EngineService {
  const refuse = async (): Promise<never> => {
    throw new EngineUserError(`the backtest engine is unavailable: ${reason}`);
  };
  return {
    status: () => ({ installed: null, running: false, busy: false, problem: reason, canUpdate: false, offered: null }),
    run: refuse,
    cancel: () => false,
    check: refuse,
    install: refuse,
  };
}

export function createEngineService(deps: EngineDeps): EngineService {
  const { manager, update, log } = deps;
  const check = update?.check ?? checkForUpdate;
  const install = update?.install ?? installUpdate;
  let running: AbortController | null = null;
  let installing = false;
  let offer: UpdateOffer | null = null;

  /** Throws the readable form of an expected error (the original goes to the log); rethrows anything else untouched. */
  function readable(e: unknown, what: string): never {
    const message = describeEngineError(e);
    if (message === null) throw e;
    log(`engine ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw new EngineUserError(message);
  }

  return {
    status() {
      const s = manager.status();
      return { installed: s.installed, running: s.running, busy: s.busy, problem: s.problem, canUpdate: update !== undefined, offered: offer?.manifest.engineVersion ?? null };
    },

    async run(spec, options) {
      if (installing) throw new EngineUserError(UPDATING);
      if (running !== null) throw new EngineUserError("a backtest is already running");
      const controller = new AbortController();
      running = controller;
      try {
        return await manager.runBacktest(spec, { ...(options.chain === undefined ? {} : { chain: options.chain }), signal: controller.signal });
      } catch (e) {
        return readable(e, "run");
      } finally {
        running = null;
      }
    },

    cancel() {
      if (running === null || running.signal.aborted) return false;
      running.abort();
      return true;
    },

    async check() {
      if (update === undefined) throw new EngineUserError(NO_SOURCE);
      let result: CheckResult;
      try {
        result = await check(update.config);
      } catch (e) {
        return readable(e, "update check");
      }
      if (result.kind === "available") {
        offer = result.offer;
        return { kind: "available", version: result.offer.manifest.engineVersion };
      }
      offer = null;
      return result.kind === "up-to-date" ? { kind: "up-to-date", version: result.version } : { kind: "older", latest: result.latest, current: result.current };
    },

    async install() {
      if (update === undefined) throw new EngineUserError(NO_SOURCE);
      if (installing) throw new EngineUserError(UPDATING);
      if (offer === null) throw new EngineUserError("check for an update first");
      if (running !== null) throw new EngineUserError(BUSY_INSTALL);
      installing = true;
      try {
        // The running engine holds its files open (Windows will not replace a program that is running).
        if (!(await manager.stopIfIdle())) throw new EngineUserError(BUSY_INSTALL);
        const info = await install(update.config, offer);
        offer = null;
        return { version: info.version };
      } catch (e) {
        return readable(e, "install");
      } finally {
        installing = false;
      }
    },
  };
}
