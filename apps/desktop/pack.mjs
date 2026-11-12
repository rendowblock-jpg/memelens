// Packages the desktop app with electron-builder.
//   node pack.mjs            Windows: builds the MSI.  Linux/macOS: builds an unpacked app folder (for checking).
//   node pack.mjs --dir      an unpacked app folder on any platform (no installer)
// Everything the app needs is bundled by esbuild (build.mjs), so the packaged app has no node_modules at all:
// it is staged into its own folder with its own package.json, and only that folder is packaged.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Outside the repository on purpose: electron-builder walks up from the app folder, finds the workspace and then
// packs the dev dependencies (react, the @memelens sources) into the app. With no node_modules above it, it cannot.
const stage = join(tmpdir(), "memelens-stage");
const release = join(here, "release");
const dirOnly = process.argv.includes("--dir") || process.platform !== "win32";

/**
 * Identifies this product to Windows Installer. It must NEVER change: a new value makes the next version install
 * beside the old one instead of replacing it. Generated once (12 Nov 2026) and written down in docs/DESIGN.md.
 */
export const UPGRADE_CODE = "80E58C9E-4267-4FF5-A0F0-65565D71F798";

execFileSync(process.execPath, [join(here, "build.mjs")], { cwd: here, stdio: "inherit" });

// 1. Stage: only what the running app loads. The smoke, screenshot and preview helpers are not copied.
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["main.cjs", "preload.cjs"]) cpSync(join(here, "dist", f), join(stage, f));
cpSync(join(here, "dist", "renderer"), join(stage, "renderer"), { recursive: true });
const own = require("./package.json");
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "memelens",
      productName: "MemeLens",
      version: own.version,
      description: "Local-first memecoin on-chain analytics. Read-only: no keys, no signing.",
      author: { name: "MemeLens contributors" },
      main: "main.cjs",
    },
    null,
    2,
  ),
);
const staged = readdirSync(stage).sort().join(",");
if (staged !== "main.cjs,package.json,preload.cjs,renderer") throw new Error(`unexpected files in the stage folder: ${staged}`);

// 2. Package.
const { build, Platform, Arch } = require("electron-builder");
const electronVersion = require("electron/package.json").version;
rmSync(release, { recursive: true, force: true });

const targets = dirOnly ? Platform.current().createTarget("dir", Arch.x64) : Platform.WINDOWS.createTarget("msi", Arch.x64);
const files = await build({
  projectDir: stage,
  targets,
  publish: "never",
  config: {
    appId: "org.memelens.app",
    productName: "MemeLens",
    copyright: "MemeLens contributors",
    electronVersion,
    directories: { output: release, buildResources: join(here, "build") },
    asar: true,
    npmRebuild: false,
    // Fuses are switches inside the Electron binary itself. The install folder is writable by the user, so the app
    // must refuse to run code that is not in its own app.asar, refuse a modified app.asar, and not be turned into a
    // general-purpose Node interpreter (ELECTRON_RUN_AS_NODE) or debugged through environment variables.
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    },
    artifactName: "MemeLens-${version}-${arch}.${ext}",
    win: { icon: "icon.png", signAndEditExecutable: true },
    msi: {
      oneClick: true,
      perMachine: false, // per user: no administrator needed; matches the per-user sidecar folder
      upgradeCode: UPGRADE_CODE,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      runAfterFinish: false,
      warningsAsErrors: true,
    },
  },
});
// 3. Look inside what was built: the app must hold exactly the staged files and nothing else.
const asars = [];
(function find(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) find(p);
    else if (e.name === "app.asar") asars.push(p);
  }
})(release);
if (asars.length !== 1) throw new Error(`expected one app.asar under ${release}, found ${asars.length}`);
const asar = require("@electron/asar");
const inside = asar.listPackage(asars[0]).map((p) => p.replace(/\\/g, "/").replace(/^\//, "")).sort().join(",");
const wanted = ["main.cjs", "package.json", "preload.cjs", "renderer", "renderer/index.html", "renderer/main.js", "renderer/style.css"].join(",");
if (inside !== wanted) throw new Error(`app.asar holds the wrong files.\n  expected: ${wanted}\n  found:    ${inside}`);
console.log(`app.asar holds exactly the 7 expected entries (${asars[0]})`);
console.log("built:");
for (const f of files) console.log("  " + f);
if (!existsSync(release)) throw new Error("electron-builder produced no release folder");
