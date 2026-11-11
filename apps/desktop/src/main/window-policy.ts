import { isAbsolute } from "node:path";
import { isAppUrl } from "./security";

/** The web preferences for the app window. `preload` must be an absolute path. */
export function webPreferences(preload: string, devTools: boolean): Record<string, unknown> {
  if (!isAbsolute(preload)) throw new Error(`preload path must be absolute: ${JSON.stringify(preload)}`);
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    spellcheck: false,
    devTools,
  };
}

/** True if the window may navigate to this URL. */
export function allowNavigation(url: string): boolean {
  return isAppUrl(url);
}

/** What to do when the page tries to open a new window. */
export function windowOpenDecision(): { action: "deny" } {
  return { action: "deny" };
}

/** The answer to every permission request or check (camera, notifications, clipboard, ...). */
export function allowPermission(): boolean {
  return false;
}
