import { join } from "node:path";
import { app } from "electron";
import { launch } from "./app";
import { sidecarSetup } from "./engine";

// MEMELENS_DB lets a user (or a test) point the app at another database file.
const dbPath = process.env["MEMELENS_DB"] ?? join(app.getPath("userData"), "memelens.sqlite");

app.on("window-all-closed", () => app.quit());

// Where engine releases are published. None yet: until a release host and a signing key held by the release pipeline
// exist, the window says "not set up to fetch engine releases" and an engine can only be put in place by hand.
const ENGINE_RELEASE: { baseUrl: string; allowedHosts: string[] } | undefined = undefined;

launch({
  dbPath,
  sidecar: sidecarSetup(process.env, app.getPath("home")),
  ...(ENGINE_RELEASE === undefined ? {} : { engineRelease: ENGINE_RELEASE }),
  rendererRoot: join(__dirname, "renderer"),
  preloadPath: join(__dirname, "preload.cjs"),
  devTools: !app.isPackaged,
  log: (line) => console.error(line),
}).catch((e: unknown) => {
  console.error("MemeLens failed to start:", e);
  app.exit(1);
});
