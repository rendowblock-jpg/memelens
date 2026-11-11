import type { Store } from "@memelens/data";
import { CHANNELS, handle, type ErrorSink } from "@memelens/service";
import { isAppUrl } from "./security";

/** The part of Electron's IpcMainInvokeEvent this code looks at. */
export interface IpcEventLike {
  senderFrame: { url: string } | null;
}

/** The part of Electron's ipcMain this code uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, payload: unknown) => unknown): void;
}

export const UNTRUSTED_SENDER = "refused: untrusted sender";

// Checked on every call, not once at start-up: a frame can navigate after the window was created.
function trusted(event: IpcEventLike | null | undefined): boolean {
  const url: unknown = event?.senderFrame?.url;
  return typeof url === "string" && isAppUrl(url);
}

/** Registers one listener per API channel. Each answers only frames on the app:// origin. */
export function registerIpc(ipcMain: IpcMainLike, store: Store, onError?: ErrorSink): void {
  for (const channel of CHANNELS) {
    // The channel comes from this loop, never from the page.
    ipcMain.handle(channel, (event, payload) =>
      trusted(event) ? handle(store, channel, payload, onError) : { ok: false, error: UNTRUSTED_SENDER },
    );
  }
}
