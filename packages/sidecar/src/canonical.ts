import { createHash } from "node:crypto";

// Canonical JSON: the one text form two programs in two languages must agree on byte for byte, because the spec hash is
// taken over it. Rules (docs/SIDECAR-PROTOCOL.md): no whitespace; object keys sorted by their UTF-8 bytes; integers
// only (safe range); strings escape only quote, backslash and the C0 controls; everything else is written as it is.

const SHORT_ESCAPES: Record<number, string> = { 0x08: "\\b", 0x09: "\\t", 0x0a: "\\n", 0x0c: "\\f", 0x0d: "\\r" };

function quote(text: string, where: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${where}: a lone surrogate is not valid text`);
      out += text[i]! + text[i + 1]!;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`${where}: a lone surrogate is not valid text`);
    } else if (unit === 0x22) {
      out += '\\"';
    } else if (unit === 0x5c) {
      out += "\\\\";
    } else if (unit < 0x20) {
      out += SHORT_ESCAPES[unit] ?? `\\u${unit.toString(16).padStart(4, "0")}`;
    } else {
      out += text[i]!;
    }
  }
  return out + '"';
}

function walk(value: unknown, where: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case "string":
      return quote(value, where);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError(`${where}: ${String(value)} is not a safe integer (the canonical form has no other numbers)`);
      return String(value);
    case "undefined":
      throw new TypeError(`${where}: undefined has no JSON form`);
    case "bigint":
      throw new TypeError(`${where}: a bigint has no JSON form (write it as a decimal string)`);
    case "function":
    case "symbol":
      throw new TypeError(`${where}: a ${typeof value} has no JSON form`);
    default:
      break;
  }
  if (value === null) return "null";
  const obj = value as object;
  if (ancestors.has(obj)) throw new TypeError(`${where}: cyclic structure`);
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) return "[" + obj.map((item, i) => walk(item, `${where}[${i}]`, ancestors)).join(",") + "]";
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`${where}: a ${(obj as { constructor?: { name?: string } }).constructor?.name ?? "non-plain object"} has no JSON form`);
    }
    const keys = Object.keys(obj).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    const parts = keys.map((k) => `${quote(k, `${where}.${k}`)}:${walk((obj as Record<string, unknown>)[k], `${where}.${k}`, ancestors)}`);
    return "{" + parts.join(",") + "}";
  } finally {
    ancestors.delete(obj);
  }
}

export function canonicalJson(value: unknown): string {
  return walk(value, "$", new Set());
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 of the canonical form: the identity of a spec. */
export function specHash(spec: unknown): string {
  return sha256Hex(canonicalJson(spec));
}
