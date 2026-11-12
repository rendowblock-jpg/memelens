import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { app, BrowserWindow, ipcMain, protocol, screen, session } from "electron";
import { Store } from "@memelens/data";
import { registerIpc } from "./ipc";
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
}

export interface Launched {
  window: BrowserWindow;
  store: Store;
}

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
  return { window, store };
}
