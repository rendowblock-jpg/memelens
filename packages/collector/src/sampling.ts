import { createHash } from "node:crypto";

/** The two salts are part of the protocol in docs/DESIGN.md ("Calibration collection"); changing one changes which tokens are followed. */
export const SAMPLING_SALT = "memelens-calibration-v1:";
export const PICK_SALT = "memelens-calibration-v1:pick:";

/** The first four bytes of sha256(salt + address) read as a number in [0, 1). Depends on the address only, never on an outcome. */
export function fraction(salt: string, address: string): number {
  const digest = createHash("sha256").update(salt + address).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/** Whether a launch is followed: its fraction is below `rate` (so a rate of 0 follows none and a rate of 1 follows all). */
export function isFollowed(address: string, rate = 0.1): boolean {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new RangeError(`rate must be from 0 to 1, got ${rate}`);
  return fraction(SAMPLING_SALT, address) < rate;
}

/** The key the final 30 + 30 are ordered by (lowercase hex, ascending). */
export function pickKey(address: string): string {
  return createHash("sha256").update(PICK_SALT + address).digest("hex");
}
