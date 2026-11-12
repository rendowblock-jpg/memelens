/** Addresses and chain ids never contain spaces or control characters. */
export const TEXT = /^[^\s\u0000-\u001f\u007f]{1,200}$/u;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
