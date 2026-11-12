import { generateKeyPairSync, sign } from "node:crypto";
import { checkForUpdate, FetchError, trustedSidecarKeys, UpdateError } from "@memelens/sidecar";
import { describe, expect, it } from "vitest";
import { ENGINE_RELEASE } from "../src/main/engine-release";

// Where an installed MemeLens looks for engine releases. The address is written once, here, and the release tool writes the
// tree this address points into (memelens-release publish -out <releases repo>).

describe("ENGINE_RELEASE: the address", () => {
  it("is an https address on the GitHub raw host, in the public releases repository, on the main branch", () => {
    expect(ENGINE_RELEASE.baseUrl).toBe("https://raw.githubusercontent.com/rendowblock-jpg/memelens-engine/main");
  });
  it("lets the updater talk to that host and no other", () => {
    expect(ENGINE_RELEASE.allowedHosts).toEqual(["raw.githubusercontent.com"]);
    expect(new URL(ENGINE_RELEASE.baseUrl).hostname).toBe(ENGINE_RELEASE.allowedHosts[0]);
  });
  it("has no trailing slash, credentials, query or fragment", () => {
    const u = new URL(ENGINE_RELEASE.baseUrl);
    expect(ENGINE_RELEASE.baseUrl.endsWith("/")).toBe(false);
    expect([u.username, u.password, u.search, u.hash]).toEqual(["", "", "", ""]);
  });
});

describe("ENGINE_RELEASE: used by the real updater with the real trust anchor", () => {
  function stranger(): { manifest: Buffer; signature: Buffer } {
    const { privateKey } = generateKeyPairSync("ed25519");
    const manifest = Buffer.from(
      JSON.stringify({ manifestVersion: 1, engineVersion: "9.9.9", protocol: 1, platform: "win32", arch: "x64", file: "memelens-sidecar.exe", size: 1, sha256: "0".repeat(64) }),
    );
    return { manifest, signature: sign(null, manifest, privateKey) };
  }
  const config = (fetchBytes: (url: string, max: number) => Promise<Uint8Array>) => ({
    root: "C:\\unused",
    baseUrl: ENGINE_RELEASE.baseUrl,
    allowedHosts: ENGINE_RELEASE.allowedHosts,
    publicKeys: trustedSidecarKeys(),
    platform: "win32" as const,
    arch: "x64",
    fetchBytes,
  });

  it("asks for the latest manifest of this platform and its signature at the paths the release tool writes", async () => {
    const asked: string[] = [];
    const s = stranger();
    await checkForUpdate(config(async (url) => (asked.push(url), url.endsWith(".sig") ? s.signature : s.manifest))).catch(() => undefined);
    expect(asked.sort()).toEqual([
      "https://raw.githubusercontent.com/rendowblock-jpg/memelens-engine/main/latest/win32-x64/manifest.json",
      "https://raw.githubusercontent.com/rendowblock-jpg/memelens-engine/main/latest/win32-x64/manifest.json.sig",
    ]);
  });
  it("accepts the address as a valid configuration (a bad address would fail as 'config' before anything is asked)", async () => {
    const s = stranger();
    const e = await checkForUpdate(config(async (url) => (url.endsWith(".sig") ? s.signature : s.manifest))).catch((x) => x);
    expect(e).toBeInstanceOf(UpdateError);
    expect((e as UpdateError).kind).not.toBe("config");
  });
  it("refuses a release signed by anyone but the pipeline's key", async () => {
    const s = stranger();
    const e = await checkForUpdate(config(async (url) => (url.endsWith(".sig") ? s.signature : s.manifest))).catch((x) => x);
    expect(e).toBeInstanceOf(UpdateError);
    expect((e as UpdateError).kind).toBe("signature");
  });
  it("reports a missing release as a download problem, not as a signature problem", async () => {
    const e = await checkForUpdate(config(async (url) => { throw new FetchError("status", `HTTP 404 for ${url}`, 404); })).catch((x) => x);
    expect(e).toBeInstanceOf(UpdateError);
    expect((e as UpdateError).kind).toBe("download");
  });
});
