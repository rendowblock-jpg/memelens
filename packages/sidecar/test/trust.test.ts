import { describe, expect, it } from "vitest";
import { isWeak } from "../src/signature";
import { TRUSTED_SIDECAR_KEYS, trustedSidecarKeys } from "../src/trust";

describe("the pinned release keys", () => {
  it("has at least one key, and every key is 32 bytes written in base64url", () => {
    expect(TRUSTED_SIDECAR_KEYS.length).toBeGreaterThanOrEqual(1);
    const keys = trustedSidecarKeys();
    expect(keys).toHaveLength(TRUSTED_SIDECAR_KEYS.length);
    for (const k of keys) expect(k.length).toBe(32);
    for (const text of TRUSTED_SIDECAR_KEYS) expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("has no duplicate and no weak (small-order) key", () => {
    expect(new Set(TRUSTED_SIDECAR_KEYS).size).toBe(TRUSTED_SIDECAR_KEYS.length);
    for (const k of trustedSidecarKeys()) expect(isWeak(k)).toBe(false);
  });
  it("round-trips: decoding then encoding gives the pinned text back", () => {
    trustedSidecarKeys().forEach((k, i) => expect(Buffer.from(k).toString("base64url")).toBe(TRUSTED_SIDECAR_KEYS[i]));
  });
});

import { decodeTrustedKey } from "../src/trust";

describe("decodeTrustedKey", () => {
  const good = TRUSTED_SIDECAR_KEYS[0]!;
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  it("decodes the pinned key to 32 bytes", () => {
    expect(decodeTrustedKey(good).length).toBe(32);
  });
  it("refuses text of the wrong length or with characters outside base64url", () => {
    for (const t of ["", good.slice(1), good + "A", good.slice(0, 42) + "+", good.slice(0, 42) + "=", good.slice(0, 20) + " " + good.slice(21), good.slice(0, 42) + "/"]) {
      expect(() => decodeTrustedKey(t), JSON.stringify(t)).toThrow(/43 base64url/);
    }
  });
  it("refuses a non-canonical spelling: the last character carries two spare bits that must be zero", () => {
    const same = [...ALPHABET].map((c) => good.slice(0, 42) + c).filter((t) => t !== good && Buffer.from(t, "base64url").equals(Buffer.from(good, "base64url")));
    expect(same).toHaveLength(3);
    for (const t of same) expect(() => decodeTrustedKey(t), t).toThrow(/canonical/);
  });
  it("names the key by its position in the message", () => {
    expect(() => decodeTrustedKey("short", 2)).toThrow(/#2/);
  });
});

describe("which keys this build trusts", () => {
  // The development key's private half sat on a build host, outside any pipeline. It must not be trusted by anything that ships.
  const DEVELOPMENT_KEY = "4KsdC1bGzcCItiFYU4cUA_haL17h7TwksqQJevL6HDE";
  // The release pipeline's key. Its private half exists only as an Actions secret of the private engine repository.
  const RELEASE_KEY = "3meG0F38M2TSrHKv2t8EjE1PfOnNzbSbuJJYKlzS3mM";

  it("trusts the release pipeline's key", () => {
    expect(TRUSTED_SIDECAR_KEYS).toContain(RELEASE_KEY);
  });
  it("no longer trusts the development key", () => {
    expect(TRUSTED_SIDECAR_KEYS).not.toContain(DEVELOPMENT_KEY);
  });
  it("trusts exactly one key for now: adding a second is a deliberate change that updates this line", () => {
    expect(TRUSTED_SIDECAR_KEYS).toEqual([RELEASE_KEY]);
  });
});
