import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyManifestSignature } from "../src/signature";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { raw, privateKey };
}
const manifest = Buffer.from('{"manifestVersion":1,"engineVersion":"1.0.0"}');

describe("verifyManifestSignature", () => {
  it("accepts the signature the key made", () => {
    const { raw, privateKey } = keypair();
    expect(raw.length).toBe(32);
    expect(verifyManifestSignature(manifest, sign(null, manifest, privateKey), raw)).toBe(true);
  });
  it("rejects a manifest changed by one byte", () => {
    const { raw, privateKey } = keypair();
    const sig = sign(null, manifest, privateKey);
    const changed = Buffer.from(manifest);
    changed[10] = changed[10]! ^ 1;
    expect(verifyManifestSignature(changed, sig, raw)).toBe(false);
  });
  it("rejects a signature changed by one bit, and one made by another key", () => {
    const a = keypair();
    const b = keypair();
    const sig = sign(null, manifest, a.privateKey);
    const flipped = Buffer.from(sig);
    flipped[0] = flipped[0]! ^ 1;
    expect(verifyManifestSignature(manifest, flipped, a.raw)).toBe(false);
    expect(verifyManifestSignature(manifest, sig, b.raw)).toBe(false);
  });
  it("returns false, and never throws, for inputs of the wrong size or kind", () => {
    const { raw, privateKey } = keypair();
    const sig = sign(null, manifest, privateKey);
    expect(verifyManifestSignature(manifest, sig.subarray(0, 63), raw)).toBe(false);
    expect(verifyManifestSignature(manifest, Buffer.alloc(65), raw)).toBe(false);
    expect(verifyManifestSignature(manifest, sig, raw.subarray(0, 31))).toBe(false);
    expect(verifyManifestSignature(manifest, sig, Buffer.alloc(32))).toBe(false);
    expect(verifyManifestSignature(manifest, Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
    expect(verifyManifestSignature(null as unknown as Uint8Array, sig, raw)).toBe(false);
  });
});

describe("verifyManifestSignature: weak keys", () => {
  // Ed25519 keys of small order make a "signature" of zeros verify for ANY message. The app pins its own key, but a wrongly
  // configured weak key must never turn every manifest into a valid one.
  const zeroSig = Buffer.alloc(64);
  const yBytes = (y: bigint, sign: number): Buffer => {
    const b = Buffer.alloc(32);
    let v = y;
    for (let i = 0; i < 32; i++) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    b[31] = b[31]! | (sign << 7);
    return b;
  };
  const P = 2n ** 255n - 19n;
  const smallOrder: [string, Buffer][] = [
    ["all zeros (y = 0, order 4)", Buffer.alloc(32)],
    ["the identity point (order 1)", yBytes(1n, 0)],
    ["y = p - 1 (order 2)", yBytes(P - 1n, 0)],
    ["order 8, first y, sign 0", yBytes(2707385501144840649318225287225658788936804267575313519463743609750303402022n, 0)],
    ["order 8, first y, sign 1", yBytes(2707385501144840649318225287225658788936804267575313519463743609750303402022n, 1)],
    ["order 8, second y, sign 0", yBytes(55188659117513257062467267217118295137698188065244968500265048394206261417927n, 0)],
    ["order 8, second y, sign 1", yBytes(55188659117513257062467267217118295137698188065244968500265048394206261417927n, 1)],
  ];
  // Two signature shapes: 64 zero bytes, and "R = the identity point, S = 0" (valid whenever h*A is the identity).
  const identitySig = Buffer.concat([Buffer.from([1]), Buffer.alloc(63)]);
  const rawVerify = (message: Buffer, signature: Buffer, key: Buffer): boolean => {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]);
    return verify(null, message, createPublicKey({ key: spki, format: "der", type: "spki" }), signature);
  };
  for (const [name, key] of smallOrder) {
    it(`rejects ${name}, for a message and signature the raw library accepts under it`, () => {
      let found: { m: Buffer; sig: Buffer } | null = null;
      for (let i = 0; i < 2000 && found === null; i++) {
        const m = Buffer.from(`manifest number ${i}`);
        for (const sig of [zeroSig, identitySig]) if (found === null && rawVerify(m, sig, key)) found = { m, sig };
      }
      expect(found, "the raw library should accept some message under a small-order key (that is the weakness)").not.toBeNull();
      expect(verifyManifestSignature(found!.m, found!.sig, key)).toBe(false);
    });
  }
  it("rejects a key that is not a point on the curve, and one written with y >= p", () => {
    expect(verifyManifestSignature(manifest, zeroSig, Buffer.alloc(32, 0xff))).toBe(false);
    expect(verifyManifestSignature(manifest, zeroSig, yBytes(P + 1n, 0))).toBe(false);
  });
  it("still accepts many ordinary keys (a guard that rejects honest keys would be worse than none)", () => {
    for (let i = 0; i < 25; i++) {
      const { raw, privateKey } = keypair();
      expect(verifyManifestSignature(manifest, sign(null, manifest, privateKey), raw), `key ${i}`).toBe(true);
    }
  });
});

describe("verifyManifestSignature: fails closed", () => {
  it("returns false, never true, when something inside the check throws", () => {
    const { raw, privateKey } = keypair();
    const good = sign(null, manifest, privateKey);
    // An object that IS a Uint8Array as far as instanceof can tell, but throws as soon as its length is read.
    const booby = (bytes: Uint8Array): Uint8Array =>
      new Proxy(bytes, {
        get(target, prop) {
          if (prop === "length") throw new Error("boom");
          return Reflect.get(target, prop, target);
        },
      });
    expect(verifyManifestSignature(manifest, booby(good), raw)).toBe(false);
    expect(verifyManifestSignature(manifest, good, booby(raw))).toBe(false);
    expect(verifyManifestSignature(booby(manifest), good, raw)).toBe(false);
  });
});

describe("verifyManifestSignature: the published RFC 8032 test vectors (section 7.1)", () => {
  const hex = (s: string): Buffer => Buffer.from(s, "hex");
  const vectors = [
    { name: "TEST 1 (empty message)", pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", msg: "", sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b" },
    { name: "TEST 2 (one byte, 0x72)", pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", msg: "72", sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00" },
  ];
  for (const v of vectors) {
    it(`accepts ${v.name}`, () => expect(verifyManifestSignature(hex(v.msg), hex(v.sig), hex(v.pub))).toBe(true));
    it(`rejects ${v.name} with one changed message byte`, () => {
      const m = Buffer.concat([hex(v.msg), Buffer.from([1])]);
      expect(verifyManifestSignature(m, hex(v.sig), hex(v.pub))).toBe(false);
    });
  }
  it("rejects TEST 1's signature under TEST 2's key", () => {
    expect(verifyManifestSignature(hex(""), hex(vectors[0]!.sig), hex(vectors[1]!.pub))).toBe(false);
  });
});
