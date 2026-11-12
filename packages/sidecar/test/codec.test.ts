import { describe, expect, it } from "vitest";
import { LineDecoder, encodeMessage, MAX_LINE_BYTES } from "../src/codec";

const bytes = (s: string): Buffer => Buffer.from(s, "utf8");

describe("encodeMessage", () => {
  it("writes one compact JSON line ending in a newline", () => {
    expect(encodeMessage({ jsonrpc: "2.0", id: 1, method: "hello" }).toString("utf8")).toBe('{"jsonrpc":"2.0","id":1,"method":"hello"}\n');
  });
  it("keeps line breaks inside strings escaped, so a message is always exactly one line", () => {
    const out = encodeMessage({ a: "x\ny\r\nz" }).toString("utf8");
    expect(out.slice(0, -1)).not.toMatch(/[\n\r]/);
    expect(JSON.parse(out)).toEqual({ a: "x\ny\r\nz" });
  });
  it("encodes text as UTF-8", () => {
    expect(encodeMessage({ a: "é" })).toEqual(Buffer.from([...bytes('{"a":"'), 0xc3, 0xa9, ...bytes('"}\n')]));
  });
  it("has a 16 MiB default limit", () => {
    expect(MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
  });
  it("refuses a message whose line (without the newline) is over the limit, and accepts one exactly at it", () => {
    const m = { a: "x".repeat(10) }; // {"a":"xxxxxxxxxx"} = 18 bytes
    expect(encodeMessage(m, 18).length).toBe(19);
    expect(() => encodeMessage(m, 17)).toThrow(RangeError);
  });
  it("refuses what JSON cannot carry, with the TypeError JSON itself raises", () => {
    expect(() => encodeMessage({ a: 1n })).toThrow(TypeError);
    expect(() => encodeMessage({ a: 1n })).toThrow(/bigint/i);
  });
});

describe("LineDecoder", () => {
  const msg = (v: unknown) => ({ kind: "message", value: v });

  it("decodes one complete line", () => {
    expect(new LineDecoder().push(bytes('{"a":1}\n'))).toEqual([msg({ a: 1 })]);
  });
  it("decodes several lines in one chunk, in order", () => {
    expect(new LineDecoder().push(bytes('{"a":1}\n{"a":2}\n{"a":3}\n'))).toEqual([msg({ a: 1 }), msg({ a: 2 }), msg({ a: 3 })]);
  });
  it("waits for the rest of a line that is split across chunks", () => {
    const d = new LineDecoder();
    expect(d.push(bytes('{"a":'))).toEqual([]);
    expect(d.bufferedBytes).toBe(5);
    expect(d.push(bytes('12}'))).toEqual([]);
    expect(d.push(bytes("\n"))).toEqual([msg({ a: 12 })]);
    expect(d.bufferedBytes).toBe(0);
  });
  it("keeps a partial line after a complete one", () => {
    const d = new LineDecoder();
    expect(d.push(bytes('{"a":1}\n{"b"'))).toEqual([msg({ a: 1 })]);
    expect(d.push(bytes(":2}\n"))).toEqual([msg({ b: 2 })]);
  });
  it("decodes a multi-byte character that is split between two chunks", () => {
    const all = bytes('{"a":"é中😀"}\n');
    for (let cut = 1; cut < all.length; cut++) {
      const d = new LineDecoder();
      const first = d.push(all.subarray(0, cut));
      const second = d.push(all.subarray(cut));
      expect([...first, ...second], `cut at ${cut}`).toEqual([msg({ a: "é中😀" })]);
    }
  });
  it("accepts CRLF line ends and skips blank lines", () => {
    expect(new LineDecoder().push(bytes('{"a":1}\r\n\r\n\n{"a":2}\r\n'))).toEqual([msg({ a: 1 }), msg({ a: 2 })]);
  });
  it("reports a line that is not JSON and carries on with the next line", () => {
    const out = new LineDecoder().push(bytes('hello there\n{"a":1}\n'));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "invalid", preview: "hello there" });
    expect(out[1]).toEqual(msg({ a: 1 }));
  });
  it("accepts only JSON objects (no batches, numbers, strings or null)", () => {
    const out = new LineDecoder().push(bytes('[1]\n5\n"x"\nnull\ntrue\n'));
    expect(out.map((o) => o.kind)).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid"]);
  });
  it("reports bytes that are not valid UTF-8", () => {
    const out = new LineDecoder().push(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "invalid" });
  });
  it("reports bytes that are not valid UTF-8 even when the JSON around them is fine", () => {
    const out = new LineDecoder().push(Buffer.from([...bytes('{"a":"'), 0xff, ...bytes('"}\n')]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "invalid", reason: "not valid UTF-8" });
  });
  it("refuses a limit that is not a positive whole number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new LineDecoder({ maxLineBytes: bad }), String(bad)).toThrow(RangeError);
    expect(() => new LineDecoder({ maxLineBytes: 1 })).not.toThrow();
  });
  it("cuts the preview of a bad line to 80 characters", () => {
    const out = new LineDecoder().push(bytes("z".repeat(500) + "\n"));
    expect(out[0]).toMatchObject({ kind: "invalid" });
    expect((out[0] as { preview: string }).preview).toBe("z".repeat(80));
  });

  describe("the line limit", () => {
    const limit = 20;
    it("accepts a line of exactly the limit (it is then judged on its content) and refuses one byte more", () => {
      const d = new LineDecoder({ maxLineBytes: limit });
      expect(d.push(bytes("x".repeat(limit) + "\n"))[0]).toMatchObject({ kind: "invalid" }); // within the limit: parsed, and not JSON
      expect(d.push(bytes("x".repeat(limit + 1) + "\n"))).toEqual([{ kind: "too-long", bytes: limit + 1 }]);
    });
    it("does not call a line too long while it is exactly at the limit and its newline has not arrived yet", () => {
      const d = new LineDecoder({ maxLineBytes: limit });
      expect(d.push(bytes("x".repeat(limit)))).toEqual([]);
      expect(d.bufferedBytes).toBe(limit);
      expect(d.push(bytes("\n"))[0]).toMatchObject({ kind: "invalid" }); // parsed (and not JSON), not "too long"
    });
    it("counts the part of a line that arrived earlier when it measures the line", () => {
      const d = new LineDecoder({ maxLineBytes: limit });
      expect(d.push(bytes("x".repeat(15)))).toEqual([]);
      expect(d.push(bytes("y".repeat(10) + "\n"))).toEqual([{ kind: "too-long", bytes: 25 }]);
      expect(d.bufferedBytes).toBe(0);
    });
    it("reports a too-long line once, discards the rest of it, and then carries on", () => {
      const d = new LineDecoder({ maxLineBytes: limit });
      const a = d.push(bytes("x".repeat(30)));
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ kind: "too-long" });
      expect(d.bufferedBytes).toBe(0);
      expect(d.push(bytes("y".repeat(50)))).toEqual([]);
      expect(d.bufferedBytes).toBe(0);
      expect(d.push(bytes('tail\n{"a":1}\n'))).toEqual([msg({ a: 1 })]);
    });
    it("does not keep buffering a line that is already known to be too long", () => {
      const d = new LineDecoder({ maxLineBytes: 1000 });
      for (let i = 0; i < 100; i++) d.push(bytes("x".repeat(500)));
      expect(d.bufferedBytes).toBeLessThan(1000);
    });
    it("uses a 16 MiB limit by default", () => {
      const d = new LineDecoder();
      const out = d.push(Buffer.alloc(MAX_LINE_BYTES + 1, 0x78));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: "too-long" });
    });
  });
});
