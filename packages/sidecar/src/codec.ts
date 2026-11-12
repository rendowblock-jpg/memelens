// The line protocol: one JSON object per line, UTF-8, "\n" at the end. A line is cut off at a limit so a broken or
// hostile engine cannot make the app buffer without end.

export const MAX_LINE_BYTES = 16 * 1024 * 1024;
const NEWLINE = 0x0a;
const CR = 0x0d;
const PREVIEW_CHARS = 80;

export type DecodedLine =
  | { kind: "message"; value: Record<string, unknown> }
  | { kind: "invalid"; reason: string; preview: string }
  | { kind: "too-long"; bytes: number };

/** The bytes to write for one message: compact JSON and a newline. Throws if the line (without the newline) is over `maxBytes`. */
export function encodeMessage(message: object, maxBytes: number = MAX_LINE_BYTES): Buffer {
  const text = JSON.stringify(message);
  const body = Buffer.from(text, "utf8");
  if (body.length > maxBytes) throw new RangeError(`a message of ${body.length} bytes is over the line limit of ${maxBytes} bytes`);
  return Buffer.concat([body, Buffer.from([NEWLINE])]);
}

/** Cuts a byte stream into lines and parses each one. Keeps at most one unfinished line, never more than the limit. */
export class LineDecoder {
  private readonly max: number;
  private parts: Buffer[] = [];
  private size = 0;
  private skipping = false;
  private readonly strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private readonly lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

  constructor(options: { maxLineBytes?: number } = {}) {
    this.max = options.maxLineBytes ?? MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.max) || this.max < 1) throw new RangeError("maxLineBytes must be a positive whole number");
  }

  /** Bytes of the unfinished line being held. */
  get bufferedBytes(): number {
    return this.size;
  }

  push(chunk: Uint8Array): DecodedLine[] {
    const out: DecodedLine[] = [];
    let data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (data.length > 0) {
      const end = data.indexOf(NEWLINE);
      if (this.skipping) {
        // The rest of a line that was already reported as too long.
        if (end === -1) return out;
        this.skipping = false;
        data = data.subarray(end + 1);
        continue;
      }
      if (end === -1) {
        this.parts.push(Buffer.from(data));
        this.size += data.length;
        if (this.size > this.max) {
          out.push({ kind: "too-long", bytes: this.size });
          this.reset();
          this.skipping = true;
        }
        return out;
      }
      const lineLength = this.size + end;
      if (lineLength > this.max) {
        out.push({ kind: "too-long", bytes: lineLength });
      } else {
        const line = this.size === 0 ? data.subarray(0, end) : Buffer.concat([...this.parts, data.subarray(0, end)]);
        const decoded = this.decode(line);
        if (decoded !== null) out.push(decoded);
      }
      this.reset();
      data = data.subarray(end + 1);
    }
    return out;
  }

  private reset(): void {
    this.parts = [];
    this.size = 0;
  }

  /** null for a blank line. */
  private decode(raw: Buffer): DecodedLine | null {
    const line = raw.length > 0 && raw[raw.length - 1] === CR ? raw.subarray(0, raw.length - 1) : raw;
    if (line.length === 0) return null;
    const preview = (): string => this.lossy.decode(line).slice(0, PREVIEW_CHARS);
    let text: string;
    try {
      text = this.strict.decode(line);
    } catch {
      return { kind: "invalid", reason: "not valid UTF-8", preview: preview() };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: "invalid", reason: "not valid JSON", preview: text.slice(0, PREVIEW_CHARS) };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { kind: "invalid", reason: "not a JSON object", preview: text.slice(0, PREVIEW_CHARS) };
    }
    return { kind: "message", value: value as Record<string, unknown> };
  }
}
