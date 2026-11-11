/** Maps a type to what it becomes on the wire: every bigint turns into a decimal string. */
export type Wire<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

/**
 * Turns a value into plain JSON-safe data: bigint becomes a decimal string, everything else is copied.
 * Throws on anything that JSON would silently damage (NaN, Infinity, undefined inside arrays, functions, symbols, Map, Set).
 */
export function toWire<T>(value: T): Wire<T> {
  return walk(value, "", new Set()) as Wire<T>;
}

function walk(value: unknown, path: string, ancestors: Set<object>): unknown {
  const where = path === "" ? "value" : path;
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${where}: ${String(value)} has no JSON form`);
      return value;
    case "undefined":
      throw new Error(`${where}: undefined has no JSON form here`);
    case "function":
      throw new Error(`${where}: a function has no JSON form`);
    case "symbol":
      throw new Error(`${where}: a symbol has no JSON form`);
    default:
      break;
  }
  if (value === null) return null;
  const obj = value as object;
  if (ancestors.has(obj)) throw new Error(`${where}: cyclic structure`);
  if (!Array.isArray(obj)) {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${where}: a ${obj.constructor?.name ?? "non-plain object"} has no JSON form`);
    }
  }
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((item, i) => walk(item, `${path}[${i}]`, ancestors));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue; // JSON omits undefined properties
      out[k] = walk(v, path === "" ? k : `${path}.${k}`, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}
