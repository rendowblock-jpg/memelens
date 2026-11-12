import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";

// Where the engine lives, and how a version is chosen. The folder is per user and has nothing to do with the app's
// name, version or install path, so reinstalling or upgrading the app never touches it (docs/DESIGN.md, "The sidecar").
//
//   <root>/versions/<semver>/memelens-sidecar[.exe]  +  manifest.json
//   <root>/current.json   {"version": "..."}   replaced in one step (write a temp file, rename it over)
//   <root>/previous.json  one step of rollback

export type Platform = "win32" | "darwin" | "linux";

export class LayoutError extends Error {}

export interface InstalledInfo {
  version: string;
  engineVersion: string;
  protocol: number;
  binary: string;
}

export interface PointerOps {
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: boolean }): void;
}

const REAL_OPS: PointerOps = { writeFileSync: (p, d) => writeFileSync(p, d), renameSync, rmSync: (p, o) => rmSync(p, o) };

export function currentPlatform(): Platform {
  const p = process.platform;
  if (p === "win32" || p === "darwin" || p === "linux") return p;
  throw new LayoutError(`unsupported platform: ${p}`);
}

export function binaryName(platform: Platform): string {
  return platform === "win32" ? "memelens-sidecar.exe" : "memelens-sidecar";
}

/** The per-user folder. A missing or relative base is an error: the engine is never put in a place that was guessed. */
export function sidecarRoot(platform: Platform, env: Record<string, string | undefined>, home: string): string {
  switch (platform) {
    case "win32": {
      const base = env["LOCALAPPDATA"];
      if (typeof base !== "string" || base === "" || !nodePath.win32.isAbsolute(base)) throw new LayoutError("LOCALAPPDATA is not set to an absolute path");
      return nodePath.win32.join(base, "MemeLens", "sidecar");
    }
    case "darwin":
      if (!nodePath.posix.isAbsolute(home)) throw new LayoutError("the home folder is not an absolute path");
      return nodePath.posix.join(home, "Library", "Application Support", "MemeLens", "sidecar");
    case "linux": {
      if (!nodePath.posix.isAbsolute(home)) throw new LayoutError("the home folder is not an absolute path");
      const xdg = env["XDG_DATA_HOME"];
      const base = typeof xdg === "string" && nodePath.posix.isAbsolute(xdg) ? xdg : nodePath.posix.join(home, ".local", "share");
      return nodePath.posix.join(base, "memelens", "sidecar");
    }
    default:
      throw new LayoutError(`unsupported platform: ${String(platform)}`);
  }
}

/** The name of the environment variable that moves the sidecar folder (for tests and for people who keep apps elsewhere). */
export const SIDECAR_DIR_ENV = "MEMELENS_SIDECAR_DIR";

/** `sidecarRoot`, unless MEMELENS_SIDECAR_DIR names another folder. That must be an absolute path without '..'; anything else is an error, never ignored. */
export function resolveSidecarRoot(platform: Platform, env: Record<string, string | undefined>, home: string): string {
  const override = env[SIDECAR_DIR_ENV];
  if (override === undefined || override === "") return sidecarRoot(platform, env, home);
  // A drive letter or a share on Windows ("\\rooted" and "C:relative" are not absolute enough); a slash elsewhere.
  const absolute = platform === "win32" ? /^([A-Za-z]:[\\/]|\\\\)/.test(override) : override.startsWith("/");
  if (!absolute || override.includes("\0") || override.split(/[\\/]+/).includes("..")) {
    throw new LayoutError(`${SIDECAR_DIR_ENV} must be an absolute path without '..' segments`);
  }
  return override;
}

// Semantic version without build metadata. Because a version names a folder, nothing else may pass: no path
// separators, no dots in odd places, no spaces, and a length limit.
const NUM = "(?:0|[1-9][0-9]*)";
const PRE_ID = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);

export function isValidVersion(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 && VERSION.test(v);
}

/** Orders versions by semantic-version precedence: numbers by value, a release after its own pre-releases. */
export function compareVersions(a: string, b: string): number {
  const ma = VERSION.exec(a);
  const mb = VERSION.exec(b);
  if (ma === null || mb === null) throw new LayoutError(`not a version: ${ma === null ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const xa = pa.split(".");
  const xb = pb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const p = xa[i];
    const q = xb[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^[0-9]+$/.test(p);
    const qn = /^[0-9]+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

function pointerPath(root: string, which: "current" | "previous"): string {
  return nodePath.join(root, `${which}.json`);
}

export function readPointer(root: string, which: "current" | "previous"): { version: string } | null {
  const file = pointerPath(root, which);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LayoutError(`cannot read ${which}.json: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LayoutError(`${which}.json is not valid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new LayoutError(`${which}.json must be an object`);
  const keys = Object.keys(data);
  const version = (data as Record<string, unknown>)["version"];
  if (keys.length !== 1 || keys[0] !== "version" || !isValidVersion(version)) throw new LayoutError(`${which}.json must be exactly {"version": "<a valid version>"}`);
  return { version };
}

/** Replaces the pointer in one step. If anything fails, the old pointer is still there and no temporary file is left. */
export function installPointer(root: string, which: "current" | "previous", version: string, ops: PointerOps = REAL_OPS): void {
  if (!isValidVersion(version)) throw new LayoutError(`not a valid version: ${JSON.stringify(version)}`);
  mkdirSync(root, { recursive: true });
  const target = pointerPath(root, which);
  const temp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    ops.writeFileSync(temp, JSON.stringify({ version }) + "\n");
    ops.renameSync(temp, target);
  } catch (e) {
    try {
      ops.rmSync(temp, { force: true });
    } catch {
      // nothing more can be done about a temp file that cannot be removed
    }
    throw e;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Checks that versions/<version>/ holds a binary that is exactly what its manifest says (name, size, SHA-256).
 * Called before every launch: the folder is writable by the user, so an earlier check proves nothing about now.
 * This stops accidents and tampering by anything that cannot also change this check; it is not a barrier against
 * other code running as the same user, which could change the app itself just as easily.
 */
export function verifyInstalled(root: string, version: string, platform: Platform = currentPlatform()): InstalledInfo {
  if (!isValidVersion(version)) throw new LayoutError(`not a valid version: ${JSON.stringify(version)}`);
  const dir = nodePath.join(root, "versions", version);
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new LayoutError(`version ${version} is not installed`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(nodePath.join(dir, "manifest.json"), "utf8"));
  } catch (e) {
    throw new LayoutError(`version ${version}: manifest.json is missing or not valid JSON (${(e as Error).message})`);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw new LayoutError(`version ${version}: manifest must be an object`);
  const m = manifest as Record<string, unknown>;
  if (m["manifestVersion"] !== 1) throw new LayoutError(`version ${version}: manifestVersion must be 1`);
  if (m["engineVersion"] !== version) throw new LayoutError(`version ${version}: manifest engineVersion ${JSON.stringify(m["engineVersion"])} is not the folder's version`);
  const protocol = m["protocol"];
  if (typeof protocol !== "number" || !Number.isSafeInteger(protocol) || protocol < 1) throw new LayoutError(`version ${version}: manifest protocol must be a whole number from 1`);
  const name = binaryName(platform);
  if (m["file"] !== name) throw new LayoutError(`version ${version}: manifest file must be ${name}`);
  const size = m["size"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new LayoutError(`version ${version}: manifest size must be a whole number`);
  const hash = m["sha256"];
  if (typeof hash !== "string" || !HEX64.test(hash)) throw new LayoutError(`version ${version}: manifest sha256 must be 64 lower-case hexadecimal digits`);

  const binary = nodePath.join(dir, name);
  let stat;
  try {
    stat = lstatSync(binary);
  } catch {
    throw new LayoutError(`version ${version}: the binary ${name} is missing`);
  }
  if (!stat.isFile()) throw new LayoutError(`version ${version}: ${name} is not a regular file`);
  if (stat.size !== size) throw new LayoutError(`version ${version}: the binary has size ${stat.size}, the manifest says ${size}`);
  const actual = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (actual !== hash) throw new LayoutError(`version ${version}: the binary's sha256 does not match the manifest`);
  return { version, engineVersion: version, protocol, binary };
}

/** Makes `version` the current one (after verifying it) and keeps the version it replaces as the previous one. */
export function activate(root: string, version: string, platform: Platform = currentPlatform(), ops: PointerOps = REAL_OPS): void {
  verifyInstalled(root, version, platform);
  let before: { version: string } | null = null;
  try {
    before = readPointer(root, "current");
  } catch {
    before = null; // a damaged pointer must not block installing a good version
  }
  if (before !== null && before.version !== version) installPointer(root, "previous", before.version, ops);
  installPointer(root, "current", version, ops);
}

/** Goes back to the previous version (after verifying it). Returns the version that is now current. */
export function rollback(root: string, platform: Platform = currentPlatform(), ops: PointerOps = REAL_OPS): string {
  const prev = readPointer(root, "previous");
  if (prev === null) throw new LayoutError("there is no previous version to go back to");
  verifyInstalled(root, prev.version, platform);
  let before: { version: string } | null = null;
  try {
    before = readPointer(root, "current");
  } catch {
    before = null;
  }
  installPointer(root, "current", prev.version, ops);
  if (before !== null && before.version !== prev.version) installPointer(root, "previous", before.version, ops);
  return prev.version;
}

/** The current version, verified again right now; null if none is chosen. */
export function resolveCurrent(root: string, platform: Platform = currentPlatform()): InstalledInfo | null {
  const cur = readPointer(root, "current");
  return cur === null ? null : verifyInstalled(root, cur.version, platform);
}

/** Folders under versions/ that are valid versions, oldest first. Anything else in there is ignored. */
export function listInstalled(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(nodePath.join(root, "versions"), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new LayoutError(`cannot list ${root}: ${(e as Error).message}`);
  }
  return entries.filter((e) => e.isDirectory() && isValidVersion(e.name)).map((e) => e.name).sort(compareVersions);
}
