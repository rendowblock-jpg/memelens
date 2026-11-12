import { join } from "node:path";
import { app } from "electron";
import { launch } from "./app";
import { sidecarSetup } from "./engine";
import { ENGINE_RELEASE } from "./engine-release";

// MEMELENS_DB lets a user (or a test) point the app at another database file.
const dbPath = process.env["MEMELENS_DB"] ?? join(app.getPath("userData"), "memelens.sqlite");

app.on("window-all-closed", () => app.quit());

launch({
  dbPath,
  sidecar: sidecarSetup(process.env, app.getPath("home")),
  engineRelease: ENGINE_RELEASE,
  rendererRoot: join(__dirname, "renderer"),
  preloadPath: join(__dirname, "preload.cjs"),
  devTools: !app.isPackaged,
  log: (line) => console.error(line),
}).catch((e: unknown) => {
  console.error("MemeLens failed to start:", e);
  app.exit(1);
});
