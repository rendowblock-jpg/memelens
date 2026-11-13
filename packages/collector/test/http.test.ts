import { describe, expect, it } from "vitest";
import { PoliteClient, type FetchLike } from "../src/http";

/** A clock that only moves when the code sleeps, so spacing and back-off can be measured exactly. */
function clock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps, at: () => t };
}

type Reply = { status: number; body?: string; headers?: Record<string, string> } | Error;
function scripted(replies: Reply[], seen: Array<{ url: string; headers: Record<string, string>; at: number }>, c: ReturnType<typeof clock>): FetchLike {
  let i = 0;
  return async (url, init) => {
    seen.push({ url, headers: init.headers, at: c.at() });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body ?? "" };
  };
}

function make(replies: Reply[], over: Partial<ConstructorParameters<typeof PoliteClient>[0]> = {}) {
  const c = clock();
  const seen: Array<{ url: string; headers: Record<string, string>; at: number }> = [];
  const client = new PoliteClient({
    fetch: scripted(replies, seen, c),
    sleep: c.sleep,
    now: c.now,
    userAgent: "test-agent/1",
    minIntervalMs: { "a.example": 2500, "b.example": 1500 },
    ...over,
  });
  return { client, seen, c };
}

describe("PoliteClient", () => {
  it("sends the user agent and a JSON accept header, and answers at once when nothing is waiting", async () => {
    const { client, seen, c } = make([{ status: 200, body: "{}" }]);
    const r = await client.get("https://a.example/x");
    expect(r).toEqual({ status: 200, text: "{}", attempts: 1 });
    expect(seen[0]?.headers["user-agent"]).toBe("test-agent/1");
    expect(seen[0]?.headers["accept"]).toContain("application/json");
    expect(c.sleeps).toEqual([]);
  });

  it("lets a caller add headers (GeckoTerminal wants a version in accept)", async () => {
    const { client, seen } = make([{ status: 200 }]);
    await client.get("https://a.example/x", { accept: "application/json;version=20230302" });
    expect(seen[0]?.headers["accept"]).toBe("application/json;version=20230302");
  });

  it("keeps at least the host's minimum interval between two requests to it", async () => {
    const { client, seen } = make([{ status: 200 }]);
    await client.get("https://a.example/1");
    await client.get("https://a.example/2");
    await client.get("https://a.example/3");
    expect(seen.map((s) => s.at - seen[0]!.at)).toEqual([0, 2500, 5000]);
  });

  it("does not make one host wait for another", async () => {
    const { client, seen, c } = make([{ status: 200 }]);
    await client.get("https://a.example/1");
    await client.get("https://b.example/1");
    expect(seen[1]!.at).toBe(seen[0]!.at);
    expect(c.sleeps).toEqual([]);
  });

  it("counts the time a slow request already took toward the interval", async () => {
    const c = clock();
    const seen: Array<{ url: string; headers: Record<string, string>; at: number }> = [];
    const slow: FetchLike = async (url, init) => {
      seen.push({ url, headers: init.headers, at: c.at() });
      await c.sleep(2000); // the reply takes 2 s
      return { status: 200, headers: { get: () => null }, text: async () => "" };
    };
    const client = new PoliteClient({ fetch: slow, sleep: c.sleep, now: c.now, userAgent: "u", minIntervalMs: { "a.example": 2500 } });
    await client.get("https://a.example/1");
    await client.get("https://a.example/2");
    expect(seen[1]!.at - seen[0]!.at).toBe(2500); // 2 s of reply + 0.5 s of waiting, not 2 s + 2.5 s
  });

  it("uses the default interval for a host it was not told about", async () => {
    const { client, seen } = make([{ status: 200 }], { defaultMinIntervalMs: 700 });
    await client.get("https://other.example/1");
    await client.get("https://other.example/2");
    expect(seen[1]!.at - seen[0]!.at).toBe(700);
  });

  it("retries a 429 with a doubling back-off and returns the first good answer", async () => {
    const { client, seen } = make([{ status: 429 }, { status: 429 }, { status: 200, body: "ok" }], { baseBackoffMs: 1000, minIntervalMs: { "a.example": 0 } });
    const r = await client.get("https://a.example/x");
    expect(r).toEqual({ status: 200, text: "ok", attempts: 3 });
    expect(seen.map((s) => s.at - seen[0]!.at)).toEqual([0, 1000, 3000]); // waits of 1 s then 2 s
  });

  it("retries a 5xx and a thrown network error the same way", async () => {
    const { client } = make([{ status: 503 }, new Error("socket hang up"), { status: 200, body: "ok" }], { baseBackoffMs: 10, minIntervalMs: { "a.example": 0 } });
    expect((await client.get("https://a.example/x")).attempts).toBe(3);
  });

  it("waits for Retry-After when it asks for more than the back-off", async () => {
    const { client, seen } = make([{ status: 429, headers: { "retry-after": "30" } }, { status: 200 }], { baseBackoffMs: 1000, minIntervalMs: { "a.example": 0 } });
    await client.get("https://a.example/x");
    expect(seen[1]!.at - seen[0]!.at).toBe(30_000);
  });

  it("never waits longer than the cap, however large Retry-After is", async () => {
    const { client, seen } = make([{ status: 429, headers: { "retry-after": "99999" } }, { status: 200 }], { maxWaitMs: 120_000, minIntervalMs: { "a.example": 0 } });
    await client.get("https://a.example/x");
    expect(seen[1]!.at - seen[0]!.at).toBe(120_000);
  });

  it("ignores a Retry-After that is not a number of seconds", async () => {
    const { client, seen } = make([{ status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }, { status: 200 }], { baseBackoffMs: 1000, minIntervalMs: { "a.example": 0 } });
    await client.get("https://a.example/x");
    expect(seen[1]!.at - seen[0]!.at).toBe(1000);
  });

  it("gives up after the attempt limit and returns the last answer (status 429 here)", async () => {
    const { client, seen } = make([{ status: 429, body: "slow down" }], { maxAttempts: 3, baseBackoffMs: 10, minIntervalMs: { "a.example": 0 } });
    expect(await client.get("https://a.example/x")).toEqual({ status: 429, text: "slow down", attempts: 3 });
    expect(seen).toHaveLength(3);
  });

  it("returns status 0 and the error text when every attempt throws", async () => {
    const { client } = make([new Error("ECONNRESET")], { maxAttempts: 2, baseBackoffMs: 10, minIntervalMs: { "a.example": 0 } });
    const r = await client.get("https://a.example/x");
    expect(r.status).toBe(0);
    expect(r.text).toContain("ECONNRESET");
    expect(r.attempts).toBe(2);
  });

  it("returns a 404 at once: an answer that says 'no such thing' is information, not a failure to retry", async () => {
    const { client, seen } = make([{ status: 404, body: "nope" }]);
    expect(await client.get("https://a.example/x")).toEqual({ status: 404, text: "nope", attempts: 1 });
    expect(seen).toHaveLength(1);
  });

  it("does not retry other 4xx answers", async () => {
    const { client, seen } = make([{ status: 403 }]);
    expect((await client.get("https://a.example/x")).status).toBe(403);
    expect(seen).toHaveLength(1);
  });
});
