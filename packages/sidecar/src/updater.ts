import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SidecarClient } from "./client";
import { FetchError, fetchLimited, type FetchOptions } from "./fetch";
import { activate, binaryName, compareVersions, currentPlatform, isValidVersion, readPointer, verifyInstalled, type InstalledInfo, type Platform } from "./layout";
import { isWeak, verifyManifestSignature } from "./signature";

// Installing an engine release. The only thing trusted is a manifest signed by a pinned key; the binary is trusted only
// because the signed manifest names its exact size and SHA-256. Order: signature, then parse, then download, then
// check size and hash, then place it, then check it again from disk, then run its hello, and only then make it current.

export type UpdateErrorKind = "config" | "signature" | "manifest" | "download" | "downgrade" | "self-test" | "install";

export class UpdateError extends Error {
  constructor(
    readonly kind: UpdateErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 128;

export interface ReleaseManifest {
  manifestVersion: 1;
  engineVersion: string;
  protocol: number;
  platform: string;
  arch: string;
  file: string;
  size: number;
  sha256: string;
}

export interface UpdateConfig {
  /** The sidecar folder (see layout.sidecarRoot). */
  root: string;
  /** Where releases are published, e.g. https://example.org/memelens-engine. */
  baseUrl: string;
  publicKeys: readonly Uint8Array[];
  allowedHosts: readonly string[];
  platform?: Platform;
  arch?: string;
  /** Replaces the network, for tests. */
  fetchBytes?: (url: string, maxBytes: number) => Promise<Uint8Array>;
  /** Starts the new engine and checks it. Default: run it, say hello, compare the version, shut it down. */
  selfTest?: (binary: string, expectedVersion: string) => Promise<void>;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  maxBinaryBytes?: number;
}

export interface UpdateOffer {
  manifest: ReleaseManifest;
  manifestBytes: Uint8Array;
  signature: Uint8Array;
}

export type CheckResult =
  | { kind: "up-to-date"; version: string }
  | { kind: "older"; latest: string; current: string }
  | { kind: "available"; offer: UpdateOffer };

const FIELDS = ["manifestVersion", "engineVersion", "protocol", "platform", "arch", "file", "size", "sha256"] as const;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(kind: UpdateErrorKind, message: string, cause?: unknown): UpdateError {
  return new UpdateError(kind, message, cause === undefined ? undefined : { cause });
}
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function parseReleaseManifest(bytes: Uint8Array, platform: string, arch: string, maxBinaryBytes: number = MAX_BINARY_BYTES): ReleaseManifest {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail("manifest", "the manifest is not valid UTF-8");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw fail("manifest", "the manifest is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw fail("manifest", "the manifest must be a JSON object");
  const o = data as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(FIELDS as readonly string[]).includes(k)) throw fail("manifest", `the manifest has an unknown field: ${k}`);
  for (const k of FIELDS) if (!Object.hasOwn(o, k)) throw fail("manifest", `the manifest lacks the field ${k}`);
  if (o["manifestVersion"] !== 1) throw fail("manifest", "manifestVersion must be 1");
  const version = o["engineVersion"];
  if (!isValidVersion(version)) throw fail("manifest", "engineVersion is not a valid version");
  const protocol = o["protocol"];
  if (typeof protocol !== "number" || !Number.isSafeInteger(protocol) || protocol < 1) throw fail("manifest", "protocol must be a whole number from 1");
  if (o["platform"] !== platform) throw fail("manifest", `the manifest is for platform ${JSON.stringify(o["platform"])}, not ${platform}`);
  if (o["arch"] !== arch) throw fail("manifest", `the manifest is for architecture ${JSON.stringify(o["arch"])}, not ${arch}`);
  const file = binaryName(platform as Platform);
  if (o["file"] !== file) throw fail("manifest", `file must be ${file}`);
  const size = o["size"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > maxBinaryBytes) throw fail("manifest", `size must be a whole number from 1 to ${maxBinaryBytes}`);
  const hash = o["sha256"];
  if (typeof hash !== "string" || !SHA256.test(hash)) throw fail("manifest", "sha256 must be 64 lower-case hexadecimal digits");
  return { manifestVersion: 1, engineVersion: version, protocol, platform, arch, file, size, sha256: hash };
}

interface Resolved {
  root: string;
  base: string;
  keys: readonly Uint8Array[];
  platform: Platform;
  arch: string;
  maxBinaryBytes: number;
  get: (url: string, maxBytes: number) => Promise<Uint8Array>;
  selfTest: (binary: string, expectedVersion: string) => Promise<void>;
}

function resolve(config: UpdateConfig): Resolved {
  if (typeof config.root !== "string" || config.root === "") throw fail("config", "root must be a folder path");
  if (!Array.isArray(config.publicKeys) || config.publicKeys.length === 0) throw fail("config", "at least one trusted public key is needed");
  for (const k of config.publicKeys) {
    if (!(k instanceof Uint8Array) || k.length !== 32) throw fail("config", "every trusted public key must be 32 bytes");
    if (isWeak(k)) throw fail("config", "a trusted public key is a weak (small-order) key");
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw fail("config", "baseUrl is not a valid address");
  }
  const loopback = config.allowInsecureLoopback === true && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw fail("config", "baseUrl must be an https address");
  if (url.username !== "" || url.password !== "") throw fail("config", "baseUrl must not contain a user name or password");
  if (!config.allowedHosts.some((h) => h.toLowerCase() === url.hostname.toLowerCase())) throw fail("config", `baseUrl's host ${url.hostname} is not on the list of allowed hosts`);

  const maxBinaryBytes = config.maxBinaryBytes ?? MAX_BINARY_BYTES;
  const fetchBytes =
    config.fetchBytes ??
    ((u: string, maxBytes: number) => {
      const o: FetchOptions = { allowedHosts: config.allowedHosts, maxBytes };
      if (config.timeoutMs !== undefined) o.timeoutMs = config.timeoutMs;
      if (config.allowInsecureLoopback !== undefined) o.allowInsecureLoopback = config.allowInsecureLoopback;
      return fetchLimited(u, o);
    });
  return {
    root: config.root,
    base: config.baseUrl.replace(/\/+$/, ""),
    keys: config.publicKeys,
    platform: config.platform ?? currentPlatform(),
    arch: config.arch ?? process.arch,
    maxBinaryBytes,
    get: async (u, maxBytes) => {
      try {
        return await fetchBytes(u, maxBytes);
      } catch (e) {
        if (e instanceof UpdateError) throw e;
        throw fail("download", `cannot download ${u}: ${describe(e)}`, e);
      }
    },
    selfTest: config.selfTest ?? defaultSelfTest,
  };
}

function signedBy(keys: readonly Uint8Array[], manifest: Uint8Array, signature: Uint8Array): boolean {
  return signature.length === 64 && keys.some((k) => verifyManifestSignature(manifest, signature, k));
}

/** The current version, or null if none is set or current.json is damaged (a damaged pointer must not block an update). */
function currentVersion(root: string): string | null {
  try {
    return readPointer(root, "current")?.version ?? null;
  } catch {
    return null;
  }
}

/** The installed engine of `version`, if it verifies against its own manifest AND that manifest is exactly the signed one. */
function installedAsSigned(root: string, version: string, platform: Platform, signedManifest: Uint8Array): InstalledInfo | null {
  try {
    const info = verifyInstalled(root, version, platform);
    const onDisk = readFileSync(join(root, "versions", version, "manifest.json"));
    return Buffer.from(onDisk).equals(Buffer.from(signedManifest)) ? info : null;
  } catch {
    return null;
  }
}

/** Asks the release host for the latest signed manifest of this platform. Downloads no binary. */
export async function checkForUpdate(config: UpdateConfig): Promise<CheckResult> {
  const r = resolve(config);
  const dir = `${r.base}/latest/${r.platform}-${r.arch}`;
  const [manifestBytes, signature] = await Promise.all([r.get(`${dir}/manifest.json`, MAX_MANIFEST_BYTES), r.get(`${dir}/manifest.json.sig`, MAX_SIGNATURE_BYTES)]);
  // The signature is checked before the manifest is looked at: a file nobody trusted is never parsed.
  if (!signedBy(r.keys, manifestBytes, signature)) throw fail("signature", "the latest manifest is not signed by a trusted key");
  const manifest = parseReleaseManifest(manifestBytes, r.platform, r.arch, r.maxBinaryBytes);
  const current = currentVersion(r.root);
  if (current !== null) {
    const order = compareVersions(manifest.engineVersion, current);
    if (order < 0) return { kind: "older", latest: manifest.engineVersion, current };
    // The same version is "up to date" only if the copy on disk is intact AND is the very release that was signed;
    // otherwise it is offered again, which repairs it.
    if (order === 0 && installedAsSigned(r.root, current, r.platform, manifestBytes) !== null) return { kind: "up-to-date", version: current };
  }
  return { kind: "available", offer: { manifest, manifestBytes, signature } };
}

/**
 * Installs an offer: downloads the binary, checks it against the signed manifest, places it under versions/<version>,
 * checks it again from disk, runs its self-test, and only then makes it current. On any failure nothing it created stays.
 */
export async function installUpdate(config: UpdateConfig, offer: UpdateOffer): Promise<InstalledInfo> {
  const r = resolve(config);
  // The offer is only a carrier. What counts is the signed bytes, checked here again and parsed here, not the object passed in.
  if (!(offer?.manifestBytes instanceof Uint8Array) || !(offer.signature instanceof Uint8Array)) throw fail("signature", "the offer has no signed manifest");
  if (!signedBy(r.keys, offer.manifestBytes, offer.signature)) throw fail("signature", "the manifest is not signed by a trusted key");
  const manifest = parseReleaseManifest(offer.manifestBytes, r.platform, r.arch, r.maxBinaryBytes);
  const version = manifest.engineVersion;

  const current = currentVersion(r.root);
  if (current !== null && compareVersions(version, current) < 0) throw fail("downgrade", `version ${version} is older than the current ${current}`);

  const target = join(r.root, "versions", version);
  // Already here, intact, and the very same signed manifest: nothing to download.
  const here = installedAsSigned(r.root, version, r.platform, offer.manifestBytes);
  if (here !== null) {
    if (current !== version) activate(r.root, version, r.platform);
    return here;
  }

  const binary = await r.get(`${r.base}/${version}/${r.platform}-${r.arch}/${manifest.file}`, manifest.size);
  if (binary.length !== manifest.size) throw fail("download", `the engine is ${binary.length} bytes; the signed manifest says ${manifest.size}`);
  if (sha256(binary) !== manifest.sha256) throw fail("download", "the engine's SHA-256 does not match the signed manifest");

  const staging = join(r.root, "staging", randomBytes(8).toString("hex"));
  let placed = false;
  try {
    mkdirSync(staging, { recursive: true });
    const file = join(staging, manifest.file);
    writeFileSync(file, binary);
    if (process.platform !== "win32") chmodSync(file, 0o755);
    writeFileSync(join(staging, "manifest.json"), offer.manifestBytes);
    mkdirSync(join(r.root, "versions"), { recursive: true });
    rmSync(target, { recursive: true, force: true }); // a damaged earlier copy
    renameSync(staging, target);
    placed = true;
  } catch (e) {
    throw fail("install", `cannot place the engine: ${describe(e)}`, e);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const undo = (): void => {
    if (placed) rmSync(target, { recursive: true, force: true });
  };
  let info: InstalledInfo;
  try {
    info = verifyInstalled(r.root, version, r.platform);
  } catch (e) {
    undo();
    throw fail("install", `the installed engine does not verify: ${describe(e)}`, e);
  }
  try {
    await r.selfTest(info.binary, version);
  } catch (e) {
    undo();
    throw fail("self-test", `the new engine failed its self-test: ${describe(e)}`, e);
  }
  try {
    activate(r.root, version, r.platform);
  } catch (e) {
    undo();
    throw fail("install", `cannot make the engine current: ${describe(e)}`, e);
  }
  return info;
}

/** Starts the engine, says hello, checks it reports the version the manifest promised, and shuts it down. */
export async function defaultSelfTest(binary: string, expectedVersion: string): Promise<void> {
  const client = await SidecarClient.start({ command: binary, helloTimeoutMs: 15_000 });
  try {
    if (client.info.engineVersion !== expectedVersion) {
      throw new Error(`the engine says it is version ${client.info.engineVersion}, the manifest says ${expectedVersion}`);
    }
  } finally {
    await client.close(1500);
  }
}
