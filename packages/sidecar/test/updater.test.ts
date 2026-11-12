import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FetchError } from "../src/fetch";
import { activate, binaryName, listInstalled, readPointer, resolveCurrent, verifyInstalled } from "../src/layout";
import {
  checkForUpdate, installUpdate, MAX_MANIFEST_BYTES, parseReleaseManifest, UpdateError,
  type ReleaseManifest, type UpdateConfig, type UpdateOffer,
} from "../src/updater";

const BASE = "https://releases.example.test/memelens";
const HOSTS = ["releases.example.test"];
const PLATFORM = "linux" as const;
const ARCH = "x64";
const NAME = binaryName(PLATFORM);
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

interface Key { raw: Buffer; priv: KeyObject }
function newKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { raw: Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"), priv: privateKey };
}
const KEY = newKey();

interface Release { version: string; binary: Buffer; manifest: Record<string, unknown>; manifestBytes: Buffer; signature: Buffer }
function release(version: string, over: { content?: string; manifest?: Record<string, unknown>; key?: Key; raw?: Buffer } = {}): Release {
  const binary = Buffer.from(over.content ?? `engine ${version}`);
  const manifest: Record<string, unknown> = {
    manifestVersion: 1, engineVersion: version, protocol: 1, platform: PLATFORM, arch: ARCH, file: NAME, size: binary.length, sha256: sha(binary), ...over.manifest,
  };
  const manifestBytes = over.raw ?? Buffer.from(JSON.stringify(manifest));
  return { version, binary, manifest, manifestBytes, signature: sign(null, manifestBytes, (over.key ?? KEY).priv) };
}

/** What the server holds: the "latest" manifest and, per version, the binary. */
class Server {
  files = new Map<string, Uint8Array>();
  requests: string[] = [];
  publish(r: Release, opts: { latest?: boolean; binary?: Uint8Array } = {}): void {
    if (opts.latest !== false) {
      this.files.set(`${BASE}/latest/${PLATFORM}-${ARCH}/manifest.json`, r.manifestBytes);
      this.files.set(`${BASE}/latest/${PLATFORM}-${ARCH}/manifest.json.sig`, r.signature);
    }
    this.files.set(`${BASE}/${r.version}/${PLATFORM}-${ARCH}/${NAME}`, opts.binary ?? r.binary);
  }
  fetchBytes = async (url: string, maxBytes: number): Promise<Uint8Array> => {
    this.requests.push(url);
    const f = this.files.get(url);
    if (f === undefined) throw new FetchError("status", `HTTP 404 for ${url}`, 404);
    if (f.length > maxBytes) throw new FetchError("too-large", `${url} is larger than ${maxBytes} bytes`);
    return f;
  };
}

const roots: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "memelens-update-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function config(root: string, server: Server, over: Partial<UpdateConfig> = {}): UpdateConfig {
  return { root, baseUrl: BASE, publicKeys: [KEY.raw], allowedHosts: HOSTS, platform: PLATFORM, arch: ARCH, fetchBytes: server.fetchBytes, selfTest: async () => {}, ...over };
}
async function reason(p: Promise<unknown>): Promise<UpdateError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof UpdateError) return e;
    throw e;
  }
  throw new Error("expected an UpdateError, but it resolved");
}
async function offerOf(root: string, server: Server): Promise<UpdateOffer> {
  const r = await checkForUpdate(config(root, server));
  if (r.kind !== "available") throw new Error(`expected an update, got ${r.kind}`);
  return r.offer;
}
/** Installs a version the normal way, as a starting point. */
async function installed(root: string, version: string): Promise<void> {
  const s = new Server();
  s.publish(release(version));
  await installUpdate(config(root, s), await offerOf(root, s));
}

describe("parseReleaseManifest", () => {
  const good = (over: Record<string, unknown> = {}) => release("1.2.3", { manifest: over }).manifestBytes;
  const parse = (bytes: Uint8Array) => parseReleaseManifest(bytes, PLATFORM, ARCH);
  const refuses = (bytes: Uint8Array) => expect(() => parse(bytes)).toThrow(UpdateError);

  it("accepts a complete manifest", () => {
    const m: ReleaseManifest = parse(good());
    expect(m).toMatchObject({ manifestVersion: 1, engineVersion: "1.2.3", protocol: 1, platform: PLATFORM, arch: ARCH, file: NAME, size: 12 });
    expect(m.sha256).toBe(sha("engine 1.2.3"));
  });
  it("refuses text that is not a JSON object", () => {
    for (const t of ["", "nope", "[]", "null", "5", '"x"']) refuses(Buffer.from(t));
    refuses(Buffer.from([0x7b, 0xff, 0x7d]));
  });
  it("refuses a missing field and an unknown field", () => {
    for (const k of ["manifestVersion", "engineVersion", "protocol", "platform", "arch", "file", "size", "sha256"]) {
      const o = JSON.parse(good().toString()) as Record<string, unknown>;
      delete o[k];
      // the message must name the missing field, not fail later with a message about its value
      expect(() => parse(Buffer.from(JSON.stringify(o))), k).toThrow(new RegExp(`lacks the field ${k}\\b`));
    }
    refuses(good({ extra: 1 }));
  });
  it("checks every value", () => {
    refuses(good({ manifestVersion: 2 }));
    for (const v of ["1.2", "v1.2.3", "../1.2.3", "1.2.3+b", 5, null]) refuses(good({ engineVersion: v }));
    for (const v of [0, -1, 1.5, "1"]) refuses(good({ protocol: v }));
    refuses(good({ platform: "win32" }));
    refuses(good({ arch: "arm64" }));
    refuses(good({ file: "other" }));
    refuses(good({ file: "../memelens-sidecar" }));
    for (const v of [0, -1, 1.5, "11", null, 256 * 1024 * 1024 + 1]) refuses(good({ size: v }));
    for (const v of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64), 5]) refuses(good({ sha256: v }));
  });
  it("accepts the largest size allowed, and a smaller limit when asked for one", () => {
    expect(() => parse(good({ size: 256 * 1024 * 1024 }))).not.toThrow();
    expect(() => parseReleaseManifest(good({ size: 101 }), PLATFORM, ARCH, 100)).toThrow(UpdateError);
    expect(() => parseReleaseManifest(good({ size: 100 }), PLATFORM, ARCH, 100)).not.toThrow();
  });
  it("is an UpdateError of kind 'manifest'", () => {
    try {
      parse(Buffer.from("nope"));
    } catch (e) {
      expect((e as UpdateError).kind).toBe("manifest");
    }
  });
});

describe("checkForUpdate", () => {
  it("asks for the signed manifest of this platform and its signature, and nothing else", async () => {
    const s = new Server();
    s.publish(release("1.0.0"));
    await checkForUpdate(config(tempRoot(), s));
    expect(s.requests).toEqual([`${BASE}/latest/${PLATFORM}-${ARCH}/manifest.json`, `${BASE}/latest/${PLATFORM}-${ARCH}/manifest.json.sig`].sort((a, b) => s.requests.indexOf(a) - s.requests.indexOf(b)));
    expect(s.requests).toHaveLength(2);
    expect(s.requests.some((u) => u.endsWith(NAME))).toBe(false); // the binary is not downloaded by a check
  });
  it("tolerates slashes at the end of the base address", async () => {
    const s = new Server();
    s.publish(release("1.0.0"));
    expect((await checkForUpdate(config(tempRoot(), s, { baseUrl: BASE + "///" }))).kind).toBe("available");
  });
  it("offers a version when nothing is installed", async () => {
    const s = new Server();
    s.publish(release("1.0.0"));
    const r = await checkForUpdate(config(tempRoot(), s));
    expect(r.kind).toBe("available");
    if (r.kind === "available") expect(r.offer.manifest.engineVersion).toBe("1.0.0");
  });
  it("offers a newer version, including one that is only a patch or a release after its pre-release", async () => {
    for (const [have, latest] of [["1.0.0", "1.0.1"], ["1.9.0", "1.10.0"], ["1.0.0-rc.1", "1.0.0"], ["0.9.9", "1.0.0"]] as const) {
      const root = tempRoot();
      await installed(root, have);
      const s = new Server();
      s.publish(release(latest));
      expect((await checkForUpdate(config(root, s))).kind, `${have} -> ${latest}`).toBe("available");
    }
  });
  it("says up to date when the current version is the latest and intact", async () => {
    const root = tempRoot();
    await installed(root, "1.0.0");
    const s = new Server();
    s.publish(release("1.0.0"));
    expect(await checkForUpdate(config(root, s))).toEqual({ kind: "up-to-date", version: "1.0.0" });
  });
  it("offers the same version again when the installed copy no longer verifies (a repair)", async () => {
    const root = tempRoot();
    await installed(root, "1.0.0");
    writeFileSync(join(root, "versions", "1.0.0", NAME), "tampered 1.0.0");
    const s = new Server();
    s.publish(release("1.0.0"));
    expect((await checkForUpdate(config(root, s))).kind).toBe("available");
  });
  it("never offers an older version than the current one (a replayed old release)", async () => {
    const root = tempRoot();
    await installed(root, "2.0.0");
    const s = new Server();
    s.publish(release("1.9.0"));
    expect(await checkForUpdate(config(root, s))).toEqual({ kind: "older", latest: "1.9.0", current: "2.0.0" });
    const s2 = new Server();
    s2.publish(release("2.0.0-rc.1"));
    expect((await checkForUpdate(config(root, s2))).kind).toBe("older");
  });
  it("is not blocked by a damaged current.json", async () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "current.json"), "garbage");
    const s = new Server();
    s.publish(release("1.0.0"));
    expect((await checkForUpdate(config(root, s))).kind).toBe("available");
  });
  it("refuses a manifest that is not signed by a trusted key, whatever else is right", async () => {
    const other = newKey();
    const s = new Server();
    s.publish(release("1.0.0", { key: other }));
    const e = await reason(checkForUpdate(config(tempRoot(), s)));
    expect(e.kind).toBe("signature");
  });
  it("refuses a manifest changed after it was signed, and a signature of the wrong length", async () => {
    const r = release("1.0.0");
    const tampered = Buffer.from(r.manifestBytes);
    tampered[tampered.length - 3] = tampered[tampered.length - 3]! ^ 1;
    const s = new Server();
    s.publish({ ...r, manifestBytes: tampered });
    expect((await reason(checkForUpdate(config(tempRoot(), s)))).kind).toBe("signature");
    for (const len of [0, 63, 65, 128]) {
      const s2 = new Server();
      s2.publish({ ...r, signature: Buffer.alloc(len, 1) });
      expect((await reason(checkForUpdate(config(tempRoot(), s2)))).kind, `signature of ${len} bytes`).toBe("signature");
    }
  });
  it("accepts a signature from any one of several trusted keys (key rotation)", async () => {
    const older = newKey();
    const s = new Server();
    s.publish(release("1.0.0", { key: older }));
    expect((await checkForUpdate(config(tempRoot(), s, { publicKeys: [KEY.raw, older.raw] }))).kind).toBe("available");
    expect((await reason(checkForUpdate(config(tempRoot(), s, { publicKeys: [KEY.raw] })))).kind).toBe("signature");
  });
  it("checks the signature before it reads the manifest, so a hostile file is never parsed", async () => {
    const s = new Server();
    s.publish(release("1.0.0", { key: newKey(), raw: Buffer.from("{ not even json") }));
    expect((await reason(checkForUpdate(config(tempRoot(), s)))).kind).toBe("signature");
  });
  it("refuses a correctly signed manifest that is for another platform or architecture", async () => {
    for (const manifest of [{ platform: "win32" }, { arch: "arm64" }]) {
      const s = new Server();
      s.publish(release("1.0.0", { manifest }));
      expect((await reason(checkForUpdate(config(tempRoot(), s)))).kind).toBe("manifest");
    }
  });
  it("turns a failed download into an UpdateError of kind 'download', and keeps the cause", async () => {
    const e = await reason(checkForUpdate(config(tempRoot(), new Server())));
    expect(e.kind).toBe("download");
    expect(e.cause).toBeInstanceOf(FetchError);
  });
  it("limits the manifest it will read", async () => {
    const s = new Server();
    const r = release("1.0.0");
    s.publish(r);
    const seen: number[] = [];
    await checkForUpdate(config(tempRoot(), s, { fetchBytes: async (u, max) => (seen.push(max), s.fetchBytes(u, max)) }));
    expect(seen[0]).toBe(MAX_MANIFEST_BYTES);
    expect(seen[1]).toBeLessThanOrEqual(128);
  });
  it("refuses a configuration that cannot be right", async () => {
    const s = new Server();
    const root = tempRoot();
    for (const over of [{ publicKeys: [] }, { publicKeys: [new Uint8Array(31)] }, { baseUrl: "not a url" }, { baseUrl: "https://elsewhere.test/x" }, { baseUrl: "http://releases.example.test/x" }] as Partial<UpdateConfig>[]) {
      expect((await reason(checkForUpdate(config(root, s, over)))).kind, JSON.stringify(over)).toBe("config");
    }
  });
});

describe("configuration found by mutation checks", () => {
  it("refuses a weak (small-order) trusted key, and an address with credentials", async () => {
    const s = new Server();
    s.publish(release("1.0.0"));
    expect((await reason(checkForUpdate(config(tempRoot(), s, { publicKeys: [KEY.raw, new Uint8Array(32)] })))).kind).toBe("config");
    expect((await reason(checkForUpdate(config(tempRoot(), s, { baseUrl: "https://u:p@releases.example.test/x" })))).kind).toBe("config");
    expect((await reason(checkForUpdate(config(tempRoot(), s, { baseUrl: "https://:p@releases.example.test/x" })))).kind).toBe("config");
  });
  it("accepts a base address on a host that is in the list with different letter case", async () => {
    const s = new Server();
    s.publish(release("1.0.0"));
    expect((await checkForUpdate(config(tempRoot(), s, { allowedHosts: ["Releases.Example.TEST"] }))).kind).toBe("available");
  });
  it("replaces an installed copy of the same version when the signed manifest is a different one (a re-release)", async () => {
    const root = tempRoot();
    await installed(root, "1.0.0");
    const s = new Server();
    s.publish(release("1.0.0", { content: "a different build of 1.0.0" }));
    const offer = await offerOf(root, s).catch(() => null);
    expect(offer).not.toBeNull(); // same version, but the installed manifest is not the signed one: the check calls it up to date only if intact
    const manual = release("1.0.0", { content: "a different build of 1.0.0" });
    await installUpdate(config(root, s), { manifest: manual.manifest as unknown as ReleaseManifest, manifestBytes: manual.manifestBytes, signature: manual.signature });
    expect(readFileSync(join(root, "versions", "1.0.0", NAME), "utf8")).toBe("a different build of 1.0.0");
    expect(readFileSync(join(root, "versions", "1.0.0", "manifest.json"))).toEqual(manual.manifestBytes);
  });
});

describe("installUpdate", () => {
  it("puts the verified engine in versions/<version>, with the signed manifest byte for byte, and makes it current", async () => {
    const root = tempRoot();
    const s = new Server();
    const r = release("1.0.0");
    s.publish(r);
    const info = await installUpdate(config(root, s), await offerOf(root, s));
    expect(info).toMatchObject({ version: "1.0.0", engineVersion: "1.0.0", protocol: 1, binary: join(root, "versions", "1.0.0", NAME) });
    expect(readFileSync(info.binary)).toEqual(r.binary);
    expect(readFileSync(join(root, "versions", "1.0.0", "manifest.json"))).toEqual(r.manifestBytes);
    expect(readPointer(root, "current")).toEqual({ version: "1.0.0" });
    expect(resolveCurrent(root, PLATFORM)?.version).toBe("1.0.0");
    expect(listInstalled(root)).toEqual(["1.0.0"]);
  });
  it("downloads the binary from versions/<version>/<platform-arch>/<file> with the size from the manifest as the limit", async () => {
    const root = tempRoot();
    const s = new Server();
    s.publish(release("1.0.0", { content: "x".repeat(50) }));
    const limits = new Map<string, number>();
    const offer = await offerOf(root, s);
    await installUpdate(config(root, s, { fetchBytes: async (u, m) => (limits.set(u, m), s.fetchBytes(u, m)) }), offer);
    expect(limits.get(`${BASE}/1.0.0/${PLATFORM}-${ARCH}/${NAME}`)).toBe(50);
  });
  it("keeps the replaced version as previous, so it can be rolled back", async () => {
    const root = tempRoot();
    await installed(root, "1.0.0");
    const s = new Server();
    s.publish(release("1.1.0"));
    await installUpdate(config(root, s), await offerOf(root, s));
    expect(readPointer(root, "current")).toEqual({ version: "1.1.0" });
    expect(readPointer(root, "previous")).toEqual({ version: "1.0.0" });
    expect(listInstalled(root)).toEqual(["1.0.0", "1.1.0"]);
  });
  it("runs the self-test on the installed binary, with the version it expects, before making it current", async () => {
    const root = tempRoot();
    const s = new Server();
    s.publish(release("1.0.0"));
    const calls: [string, string, string | null][] = [];
    await installUpdate(config(root, s, { selfTest: async (bin, v) => void calls.push([bin, v, readPointer(root, "current")?.version ?? null]) }), await offerOf(root, s));
    expect(calls).toEqual([[join(root, "versions", "1.0.0", NAME), "1.0.0", null]]); // current was still unset while the test ran
  });
  it("removes what it installed, and changes nothing else, when the self-test fails", async () => {
    const root = tempRoot();
    await installed(root, "1.0.0");
    const s = new Server();
    s.publish(release("1.1.0"));
    const offer = await offerOf(root, s);
    const e = await reason(installUpdate(config(root, s, { selfTest: async () => { throw new Error("hello failed"); } }), offer));
    expect(e.kind).toBe("self-test");
    expect(e.message).toMatch(/hello failed/);
    expect(existsSync(join(root, "versions", "1.1.0"))).toBe(false);
    expect(readPointer(root, "current")).toEqual({ version: "1.0.0" });
    expect(readPointer(root, "previous")).toBeNull();
    expect(listInstalled(root)).toEqual(["1.0.0"]);
  });
  it("refuses a binary of the wrong size, or with the wrong hash, and leaves nothing behind", async () => {
    for (const bad of [Buffer.from("engine 1.0.0 plus"), Buffer.from("engine 1.0.0".slice(0, -2)), Buffer.from("engine 9.9.9")]) {
      const root = tempRoot();
      const s = new Server();
      const r = release("1.0.0");
      s.publish(r, { binary: bad });
      const e = await reason(installUpdate(config(root, s), await offerOf(root, s)));
      expect(e.kind, bad.toString()).toBe("download");
      expect(existsSync(join(root, "versions"))).toBe(false);
      expect(readPointer(root, "current")).toBeNull();
      expect(existsSync(join(root, "staging")) ? readdirSync(join(root, "staging")) : []).toEqual([]);
    }
  });
  it("re-checks the signature on the offer itself, before downloading anything", async () => {
    const root = tempRoot();
    const s = new Server();
    s.publish(release("1.0.0"));
    const offer = await offerOf(root, s);
    const forged: UpdateOffer = { ...offer, manifestBytes: Buffer.from(JSON.stringify({ ...offer.manifest, sha256: sha("evil") })) };
    s.requests.length = 0;
    expect((await reason(installUpdate(config(root, s), forged))).kind).toBe("signature");
    expect(s.requests).toEqual([]);
    const wrongKey: UpdateOffer = { ...offer, signature: sign(null, offer.manifestBytes, newKey().priv) };
    expect((await reason(installUpdate(config(root, s), wrongKey))).kind).toBe("signature");
    expect(s.requests).toEqual([]);
  });
  it("trusts the signed bytes and not the parsed object the caller passed along", async () => {
    const root = tempRoot();
    const s = new Server();
    s.publish(release("1.0.0"));
    const offer = await offerOf(root, s);
    const lying: UpdateOffer = { ...offer, manifest: { ...offer.manifest, engineVersion: "9.9.9", sha256: sha("evil") } };
    const info = await installUpdate(config(root, s), lying);
    expect(info.version).toBe("1.0.0");
  });
  it("refuses to install a version older than the current one, even with a valid offer", async () => {
    const root = tempRoot();
    const s = new Server();
    s.publish(release("1.0.0"));
    const offer = await offerOf(root, s);
    await installed(root, "2.0.0");
    expect((await reason(installUpdate(config(root, s), offer))).kind).toBe("downgrade");
    expect(readPointer(root, "current")).toEqual({ version: "2.0.0" });
  });
  it("is a no-op download-wise when that version is already installed and intact: it just makes it current", async () => {
    const root = tempRoot();
    await installed(root, "1.0.0");
    await installed(root, "1.1.0");
    const s = new Server();
    s.publish(release("1.1.0"));
    const offer = await offerOf(root, s).catch(() => null);
    expect(offer).toBeNull(); // 1.1.0 is current and intact: a check says up to date
    // the same offer made by hand, with 1.0.0 current again
    activate(root, "1.0.0", PLATFORM);
    const manual = release("1.1.0");
    s.publish(manual);
    const count = s.requests.length;
    const info = await installUpdate(config(root, s), { manifest: manual.manifest as unknown as ReleaseManifest, manifestBytes: manual.manifestBytes, signature: manual.signature });
    expect(info.version).toBe("1.1.0");
    expect(s.requests.length).toBe(count); // nothing was downloaded
    expect(readPointer(root, "current")).toEqual({ version: "1.1.0" });
  });
  it("repairs a version folder that no longer verifies", async () => {
    const root = tempRoot();
    await installed(root, "1.0.0");
    writeFileSync(join(root, "versions", "1.0.0", NAME), "tampered 1.0.0");
    expect(() => verifyInstalled(root, "1.0.0", PLATFORM)).toThrow();
    const s = new Server();
    s.publish(release("1.0.0"));
    await installUpdate(config(root, s), await offerOf(root, s));
    expect(verifyInstalled(root, "1.0.0", PLATFORM).version).toBe("1.0.0");
    expect(readFileSync(join(root, "versions", "1.0.0", NAME), "utf8")).toBe("engine 1.0.0");
  });
  it("leaves no staging folder behind after success or failure", async () => {
    const root = tempRoot();
    const s = new Server();
    s.publish(release("1.0.0"));
    await installUpdate(config(root, s), await offerOf(root, s));
    expect(existsSync(join(root, "staging")) ? readdirSync(join(root, "staging")) : []).toEqual([]);
    const s2 = new Server();
    s2.publish(release("1.1.0"));
    const offer = await offerOf(root, s2);
    await reason(installUpdate(config(root, s2, { selfTest: async () => { throw new Error("no"); } }), offer));
    expect(existsSync(join(root, "staging")) ? readdirSync(join(root, "staging")) : []).toEqual([]);
  });
  it("sets the execute permission on the engine (not on Windows)", async () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const s = new Server();
    s.publish(release("1.0.0"));
    const info = await installUpdate(config(root, s), await offerOf(root, s));
    const { statSync } = await import("node:fs");
    expect(statSync(info.binary).mode & 0o111).not.toBe(0);
  });
  it("turns a download failure of the binary into kind 'download'", async () => {
    const root = tempRoot();
    const s = new Server();
    s.publish(release("1.0.0"));
    const offer = await offerOf(root, s);
    s.files.delete(`${BASE}/1.0.0/${PLATFORM}-${ARCH}/${NAME}`);
    const e = await reason(installUpdate(config(root, s), offer));
    expect(e.kind).toBe("download");
    expect(e.cause).toBeInstanceOf(FetchError);
  });
});
