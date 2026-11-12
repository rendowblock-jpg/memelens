// The public keys the app trusts to sign engine releases. A release is installed only if its manifest carries a valid
// ed25519 signature from one of these. More than one key is allowed so a key can be replaced without a flag day: ship an app
// that trusts old + new, then sign with the new one, then drop the old one in a later app.
//
// DEVELOPMENT KEY: the matching private key lives on the build host, outside both repositories. It must be replaced by a key
// whose private half is held by the release pipeline alone, before any engine is published to users.
export const TRUSTED_SIDECAR_KEYS: readonly string[] = ["4KsdC1bGzcCItiFYU4cUA_haL17h7TwksqQJevL6HDE"];

/** Decodes one key written as 43 base64url characters. Refuses any other spelling, including a non-canonical one. */
export function decodeTrustedKey(text: string, index = 0): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw new Error(`trusted key #${index} must be 43 base64url characters`);
  const raw = Buffer.from(text, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== text) throw new Error(`trusted key #${index} is not a canonical 32-byte value`);
  return new Uint8Array(raw);
}

/** The trusted keys as raw 32-byte values. Throws if one is malformed, so a typo here can never silently trust nothing or anything. */
export function trustedSidecarKeys(): Uint8Array[] {
  return TRUSTED_SIDECAR_KEYS.map((text, i) => decodeTrustedKey(text, i));
}
