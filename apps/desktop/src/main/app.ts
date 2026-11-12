import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { app, BrowserWindow, ipcMain, protocol, screen, session } from "electron";
import { Store } from "@memelens/data";
import { SidecarManager, trustedSidecarKeys } from "@memelens/sidecar";
import { createEngineService, unavailableEngine, type SidecarSetup } from "./engine";
import { registerEngineIpc, registerIpc, registerSampleIpc } from "./ipc";
import { createSampleService } from "./sample";
// The small made-up data set the command line also loads. esbuild bundles it into main.cjs, so the package gains no file.
import sampleFixture from "../../../../packages/data/fixtures/sample.json";
import { APP_ORIGIN } from "./security";
import { planResponse } from "./serve";
import { allowNavigation, allowPermission, webPreferences, windowOpenDecision, windowSize } from "./window-policy";

export interface LaunchOptions {
  /** The SQLite file the app reads. Created (empty) if it does not exist. */
  dbPath: string;
  /** Folder the app:// origin is served from. */
  rendererRoot: string;
  /** Absolute path of the bundled preload script. */
  preloadPath: string;
  devTools: boolean;
  log: (line: string) => void;
  /** Where the backtest engine lives, or why it cannot be used. The app works without an engine either way. */
  sidecar: SidecarSetup;
  /** Where engine releases are published. Absent until a release host exists; then the window says so instead of guessing. */
  engineRelease?: { baseUrl: string; allowedHosts: string[] };
}

export interface Launched {
  window: BrowserWindow;
  store: Store;
  /** Stops the engine process, if one is running. Called on quit. */
  stopEngine(): Promise<void>;
}

// Solana first (docs/DESIGN.md); the window can name another chain per run.
const DEFAULT_CHAIN = "solana";

function describe(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Opens the database, serves the renderer on app://memelens, registers the data channels and opens the window.
 * All the decisions live in the tested modules this file calls; this file only connects them to Electron.
 */
export async function launch(opts: LaunchOptions): Promise<Launched> {
  // Has to happen before the app is ready.
  protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true } }]);
  await app.whenReady();

  const store = Store.open(opts.dbPath);

  protocol.handle("app", async (request) => {
    try {
      const plan = planResponse(opts.rendererRoot, request.method, request.url, isFile);
      if (plan.status !== 200) return new Response(null, { status: plan.status });
      if (request.method === "HEAD") return new Response(null, { status: 200, headers: plan.headers });
      return new Response(new Uint8Array(await readFile(plan.file)), { status: 200, headers: plan.headers });
    } catch (e) {
      opts.log(`serve error: ${describe(e)}`);
      return new Response(null, { status: 500 });
    }
  });

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(allowPermission()));
  session.defaultSession.setPermissionCheckHandler(() => allowPermission());

  registerIpc(ipcMain, store, (e) => opts.log(`ipc error: ${describe(e)}`));
  // The one write the window can ask for: fill an EMPTY database with the bundled synthetic sample (first-run button).
  registerSampleIpc(ipcMain, createSampleService({ store, sample: sampleFixture, log: opts.log }), (e) => opts.log(`sample ipc error: ${describe(e)}`));

  let stopEngine = async (): Promise<void> => {};
  if ("root" in opts.sidecar) {
    const root = opts.sidecar.root;
    const manager = new SidecarManager({ root, dbPath: opts.dbPath, chain: DEFAULT_CHAIN, onLog: opts.log });
    stopEngine = () => manager.shutdown();
    registerEngineIpc(
      ipcMain,
      createEngineService({
        manager,
        ...(opts.engineRelease === undefined
          ? {}
          : { update: { config: { root, baseUrl: opts.engineRelease.baseUrl, allowedHosts: opts.engineRelease.allowedHosts, publicKeys: trustedSidecarKeys() } } }),
        log: opts.log,
      }),
      (e) => opts.log(`engine ipc error: ${describe(e)}`),
    );
  } else {
    opts.log(`engine unavailable: ${opts.sidecar.unavailable}`);
    registerEngineIpc(ipcMain, unavailableEngine(opts.sidecar.unavailable), (e) => opts.log(`engine ipc error: ${describe(e)}`));
  }

  // The engine is a separate process: it must not outlive the app, and the app must not wait for it for long.
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void stopEngine()
      .catch((e: unknown) => opts.log(`engine stop failed: ${describe(e)}`))
      .finally(() => app.quit());
  });

  // Fit the usable screen (a 1366x768 laptop has about 728 rows once the taskbar is counted).
  const size = windowSize(screen.getPrimaryDisplay().workAreaSize);
  const window = new BrowserWindow({
    ...size,
    show: false,
    backgroundColor: "#0b0e13",
    title: "MemeLens",
    webPreferences: webPreferences(opts.preloadPath, opts.devTools),
  });
  const contents = window.webContents;
  contents.on("will-navigate", (event, url) => {
    if (!allowNavigation(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!allowNavigation(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => windowOpenDecision());
  contents.on("did-fail-load", (_event, code, text, url) => opts.log(`load failed: ${code} ${text} ${url}`));
  contents.on("render-process-gone", (_event, details) => opts.log(`renderer gone: ${details.reason}`));
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => store.close());

  await window.loadURL(`${APP_ORIGIN}/index.html`);
  return { window, store, stopEngine: () => stopEngine() };
}
