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

export interface Size {
  width: number;
  height: number;
}

/**
 * The window size for a screen whose usable area (the screen minus the taskbar) is `work`: the wanted size, cut down
 * to fit, and never smaller than the minimum unless the screen itself is. A 1366x768 laptop has about 1366x728 usable.
 */
export function windowSize(
  work: Size,
  want: Size = { width: 1360, height: 860 },
  min: Size = { width: 900, height: 600 },
): Size & { minWidth: number; minHeight: number } {
  for (const [name, size] of [["work", work], ["want", want], ["min", min]] as const) {
    for (const side of ["width", "height"] as const) {
      if (!Number.isSafeInteger(size[side]) || size[side] <= 0) throw new RangeError(`${name}.${side} must be a positive whole number`);
    }
  }
  const width = Math.min(want.width, work.width);
  const height = Math.min(want.height, work.height);
  return { width, height, minWidth: Math.min(min.width, width), minHeight: Math.min(min.height, height) };
}
