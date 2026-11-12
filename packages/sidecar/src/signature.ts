import { createPublicKey, verify } from "node:crypto";

// DER prefix of an ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// ---- Small-order keys. A public key whose point has order 1, 2, 4 or 8 makes a forged all-zero style "signature" verify
// for some messages (the check [S]B = R + [h]A holds when [h]A vanishes), and Node's check does not refuse such keys.
// The app pins its own key, so this guards against a mistake in what was pinned, not against an attacker's choice.
const P = 2n ** 255n - 19n;
const mod = (a: bigint): bigint => ((a % P) + P) % P;
function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
  }
  return result;
}
const inv = (a: bigint): bigint => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

type Point = { x: bigint; y: bigint };

/** The curve point a 32-byte Ed25519 public key stands for, or null if it is not a valid (canonical) encoding. */
function decode(key: Uint8Array): Point | null {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(key[i]! & (i === 31 ? 0x7f : 0xff));
  const sign = key[31]! >> 7;
  if (y >= P) return null;
  const y2 = mod(y * y);
  const x2 = mod((y2 - 1n) * inv(mod(D * y2 + 1n)));
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
  if (mod(x * x - x2) !== 0n) return null;
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = mod(-x);
  return { x, y };
}

function add(a: Point, b: Point): Point {
  const t = mod(D * a.x * b.x * a.y * b.y);
  return { x: mod((a.x * b.y + b.x * a.y) * inv(1n + t)), y: mod((a.y * b.y + a.x * b.x) * inv(1n - t)) };
}

/** True if the key is not a valid point, or if 8 times the point is the identity (its order divides 8). */
function isWeak(key: Uint8Array): boolean {
  const p = decode(key);
  if (p === null) return true;
  let q = p;
  for (let i = 0; i < 3; i++) q = add(q, q);
  return q.x === 0n && q.y === 1n;
}

/** True only if `signature` (64 bytes) is a valid ed25519 signature of `manifest` under the raw 32-byte `publicKey`. Never throws. */
export function verifyManifestSignature(manifest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    if (!(manifest instanceof Uint8Array) || !(signature instanceof Uint8Array) || !(publicKey instanceof Uint8Array)) return false;
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    if (isWeak(publicKey)) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
    return verify(null, manifest, key, signature);
  } catch {
    return false;
  }
}
