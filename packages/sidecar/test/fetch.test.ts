import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FetchError, fetchLimited, type FetchOptions } from "../src/fetch";

const HOSTS = ["releases.example.test"];
const opts = (over: Partial<FetchOptions> = {}): FetchOptions => ({ allowedHosts: HOSTS, maxBytes: 1000, timeoutMs: 2000, ...over });
const bytesOf = (r: Uint8Array): number[] => [...r];

/** A fetch that answers from a function and records what it was asked. */
function fake(handler: (url: URL) => Response | Promise<Response>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    seen.push(url.href);
    expect(init?.redirect, "redirects must be followed by hand, host by host").toBe("manual");
    return handler(url);
  }) as typeof fetch;
}
/** A body that looks endless but stops after `chunks` pieces, so code without a size check fails the test instead of using all memory. */
function longBody(chunk: number, chunks: number, counter: { pulled: number }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(c) {
      counter.pulled++;
      if (counter.pulled > chunks) c.close();
      else c.enqueue(new Uint8Array(chunk));
    },
  });
}
const ok = (body: Uint8Array | string, headers: Record<string, string> = {}): Response => new Response(body, { status: 200, headers });
const redirect = (to: string | null, status = 302): Response => new Response(null, { status, headers: to === null ? {} : { location: to } });
async function kind(p: Promise<unknown>): Promise<FetchError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FetchError) return e;
    throw e;
  }
  throw new Error("expected a FetchError, but it resolved");
}

describe("fetchLimited: what it fetches", () => {
  it("returns the bytes of a 200 answer", async () => {
    const r = await fetchLimited("https://releases.example.test/a.bin", opts({ fetchImpl: fake(() => ok(new Uint8Array([1, 2, 3]))) }));
    expect(bytesOf(r)).toEqual([1, 2, 3]);
  });
  it("accepts an empty body", async () => {
    expect((await fetchLimited("https://releases.example.test/a", opts({ fetchImpl: fake(() => ok("")) }))).length).toBe(0);
  });
  it("accepts a body of exactly maxBytes and refuses one byte more", async () => {
    expect((await fetchLimited("https://releases.example.test/a", opts({ maxBytes: 10, fetchImpl: fake(() => ok(new Uint8Array(10))) }))).length).toBe(10);
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ maxBytes: 10, fetchImpl: fake(() => ok(new Uint8Array(11))) })))).kind).toBe("too-large");
  });
});

describe("fetchLimited: where it may go", () => {
  it("refuses plain http, and anything that is not a URL", async () => {
    expect((await kind(fetchLimited("http://releases.example.test/a", opts({ fetchImpl: fake(() => ok("x")) })))).kind).toBe("scheme");
    expect((await kind(fetchLimited("file:///etc/passwd", opts({ fetchImpl: fake(() => ok("x")) })))).kind).toBe("scheme");
    expect((await kind(fetchLimited("not a url", opts({ fetchImpl: fake(() => ok("x")) })))).kind).toBe("scheme");
  });
  it("allows plain http to the loopback only when asked to, and never to another host", async () => {
    const f = fake(() => ok("x"));
    expect((await kind(fetchLimited("http://127.0.0.1/a", opts({ allowedHosts: ["127.0.0.1"], fetchImpl: f })))).kind).toBe("scheme");
    expect((await fetchLimited("http://127.0.0.1/a", opts({ allowedHosts: ["127.0.0.1"], allowInsecureLoopback: true, fetchImpl: f }))).length).toBe(1);
    expect((await fetchLimited("http://localhost/a", opts({ allowedHosts: ["localhost"], allowInsecureLoopback: true, fetchImpl: f }))).length).toBe(1);
    expect((await kind(fetchLimited("http://releases.example.test/a", opts({ allowInsecureLoopback: true, fetchImpl: f })))).kind).toBe("scheme");
  });
  it("refuses a host that is not on the list, and a look-alike", async () => {
    const seen: string[] = [];
    for (const u of ["https://evil.test/a", "https://releases.example.test.evil.test/a", "https://xreleases.example.test/a", "https://example.test/a"]) {
      expect((await kind(fetchLimited(u, opts({ fetchImpl: fake(() => ok("x"), seen) })))).kind, u).toBe("host");
    }
    expect(seen).toEqual([]); // nothing was even requested
  });
  it("compares hosts without regard to letter case, and a port does not change the host", async () => {
    expect((await fetchLimited("https://RELEASES.Example.Test/a", opts({ fetchImpl: fake(() => ok("x")) }))).length).toBe(1);
    expect((await fetchLimited("https://releases.example.test:8443/a", opts({ fetchImpl: fake(() => ok("x")) }))).length).toBe(1);
  });
  it("refuses credentials inside the URL", async () => {
    expect((await kind(fetchLimited("https://user:pw@releases.example.test/a", opts({ fetchImpl: fake(() => ok("x")) })))).kind).toBe("credentials");
    expect((await kind(fetchLimited("https://user@releases.example.test/a", opts({ fetchImpl: fake(() => ok("x")) })))).kind).toBe("credentials");
  });
});

describe("fetchLimited: cases found by mutation checks", () => {
  const f = fake(() => ok("x"));
  it("refuses an address that has only a password", async () => {
    expect((await kind(fetchLimited("https://:pw@releases.example.test/a", opts({ fetchImpl: f })))).kind).toBe("credentials");
  });
  it("allows plain http on the loopback only for http, not for other schemes", async () => {
    expect((await kind(fetchLimited("ftp://127.0.0.1/a", opts({ allowedHosts: ["127.0.0.1"], allowInsecureLoopback: true, fetchImpl: f })))).kind).toBe("scheme");
    expect((await kind(fetchLimited("ws://127.0.0.1/a", opts({ allowedHosts: ["127.0.0.1"], allowInsecureLoopback: true, fetchImpl: f })))).kind).toBe("scheme");
  });
  it("matches a host in the list without regard to letter case", async () => {
    expect((await fetchLimited("https://releases.example.test/a", opts({ allowedHosts: ["Releases.Example.TEST"], fetchImpl: f }))).length).toBe(1);
  });
  it("accepts a declared length equal to the limit and refuses one byte more", async () => {
    const exact = fake(() => new Response(new Uint8Array(10), { status: 200, headers: { "content-length": "10" } }));
    expect((await fetchLimited("https://releases.example.test/a", opts({ maxBytes: 10, fetchImpl: exact }))).length).toBe(10);
    const over = fake(() => new Response(new Uint8Array(10), { status: 200, headers: { "content-length": "11" } }));
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ maxBytes: 10, fetchImpl: over })))).kind).toBe("too-large");
  });
  it("accepts an answer with no body at all", async () => {
    expect((await fetchLimited("https://releases.example.test/a", opts({ fetchImpl: fake(() => new Response(null, { status: 200 })) }))).length).toBe(0);
  });
  it("follows no redirect when none is allowed, and refuses a negative number", async () => {
    let n = 0;
    const g = fake(() => (n++, redirect("/b")));
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ maxRedirects: 0, fetchImpl: g })))).kind).toBe("redirect");
    expect(n).toBe(1);
    await expect(fetchLimited("https://releases.example.test/a", opts({ maxRedirects: -1, fetchImpl: f }))).rejects.toThrow(RangeError);
  });
  it("treats an empty Location as missing and does not request the same address again", async () => {
    let n = 0;
    const g = fake(() => (n++, new Response(null, { status: 302, headers: { location: "" } })));
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ fetchImpl: g })))).kind).toBe("redirect");
    expect(n).toBe(1);
  });
});

describe("fetchLimited: redirects", () => {
  it("follows a redirect by hand, resolving a relative address against the current one", async () => {
    const seen: string[] = [];
    const f = fake((u) => (u.pathname === "/a" ? redirect("/b/c") : ok("done")), seen);
    expect(bytesOf(await fetchLimited("https://releases.example.test/a", opts({ fetchImpl: f })))).toEqual([...Buffer.from("done")]);
    expect(seen).toEqual(["https://releases.example.test/a", "https://releases.example.test/b/c"]);
  });
  it("follows every redirect status", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const f = fake((u) => (u.pathname === "/a" ? redirect("/b", status) : ok("x")));
      expect((await fetchLimited("https://releases.example.test/a", opts({ fetchImpl: f }))).length, String(status)).toBe(1);
    }
  });
  it("checks the host of every hop, and never contacts a host that is not allowed", async () => {
    const seen: string[] = [];
    const f = fake((u) => (u.hostname === "releases.example.test" ? redirect("https://evil.test/x") : ok("x")), seen);
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ fetchImpl: f })))).kind).toBe("host");
    expect(seen).toEqual(["https://releases.example.test/a"]);
  });
  it("lets a redirect go to a second allowed host (a release CDN)", async () => {
    const f = fake((u) => (u.hostname === "releases.example.test" ? redirect("https://cdn.example.test/blob") : ok("payload")));
    expect(bytesOf(await fetchLimited("https://releases.example.test/a", opts({ allowedHosts: [...HOSTS, "cdn.example.test"], fetchImpl: f })))).toEqual([...Buffer.from("payload")]);
  });
  it("refuses a redirect down to http", async () => {
    const f = fake(() => redirect("http://releases.example.test/x"));
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ fetchImpl: f })))).kind).toBe("scheme");
  });
  it("refuses a redirect to a URL with credentials", async () => {
    const f = fake(() => redirect("https://u:p@releases.example.test/x"));
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ fetchImpl: f })))).kind).toBe("credentials");
  });
  it("gives up after 5 redirects by default, and after the number it is given", async () => {
    let n = 0;
    const loop = fake(() => redirect(`/r${++n}`));
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ fetchImpl: loop })))).kind).toBe("redirect");
    expect(n).toBe(6); // the first request plus 5 hops, then it stops
    n = 0;
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ maxRedirects: 1, fetchImpl: loop })))).kind).toBe("redirect");
    expect(n).toBe(2);
    // exactly 5 redirects then success is fine
    let m = 0;
    const five = fake(() => (m++ < 5 ? redirect(`/r${m}`) : ok("end")));
    expect((await fetchLimited("https://releases.example.test/a", opts({ fetchImpl: five }))).length).toBe(3);
  });
  it("refuses a redirect without a Location", async () => {
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ fetchImpl: fake(() => redirect(null)) })))).kind).toBe("redirect");
  });
});

describe("fetchLimited: failures", () => {
  it("reports any status but 200, with the status", async () => {
    for (const status of [201, 204, 206, 304, 400, 403, 404, 500]) {
      const e = await kind(fetchLimited("https://releases.example.test/a", opts({ fetchImpl: fake(() => new Response(status === 204 || status === 304 ? null : "x", { status })) })));
      expect(e.kind, String(status)).toBe("status");
      expect(e.status).toBe(status);
    }
  });
  it("reports a network failure", async () => {
    const f = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ fetchImpl: f })))).kind).toBe("network");
  });
  it("refuses a body whose declared length is over the limit without reading it", async () => {
    const counter = { pulled: 0 };
    const f = fake(() => new Response(longBody(100, 20, counter), { status: 200, headers: { "content-length": "5000" } }));
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ maxBytes: 1000, fetchImpl: f })))).kind).toBe("too-large");
    expect(counter.pulled).toBeLessThanOrEqual(1);
  });
  it("stops reading a body that grows past the limit when no length was declared", async () => {
    const counter = { pulled: 0 };
    const f = fake(() => new Response(longBody(100, 2000, counter), { status: 200 }));
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ maxBytes: 1000, fetchImpl: f })))).kind).toBe("too-large");
    expect(counter.pulled).toBeLessThan(50); // it did not drain the whole body
  });
  it("times out a request that never answers, and one that stalls in the middle of the body", async () => {
    const hang = (async (_i: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const t0 = Date.now();
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ timeoutMs: 80, fetchImpl: hang })))).kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
    const stall = (async (_i: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(5)); },
        pull: () => new Promise(() => {}),
        cancel() {},
      });
      init?.signal?.addEventListener("abort", () => {});
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    expect((await kind(fetchLimited("https://releases.example.test/a", opts({ timeoutMs: 80, fetchImpl: stall })))).kind).toBe("timeout");
  });
  it("refuses limits that make no sense", async () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(fetchLimited("https://releases.example.test/a", opts({ maxBytes, fetchImpl: fake(() => ok("x")) })), String(maxBytes)).rejects.toThrow(RangeError);
    }
    for (const timeoutMs of [0, -5, 1.5]) {
      await expect(fetchLimited("https://releases.example.test/a", opts({ timeoutMs, fetchImpl: fake(() => ok("x")) })), String(timeoutMs)).rejects.toThrow(RangeError);
    }
  });
});

describe("fetchLimited: against a real local server", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? (server.closeAllConnections(), server.close(() => r())) : r())));
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const local = (over: Partial<FetchOptions> = {}): FetchOptions => ({ allowedHosts: ["127.0.0.1"], allowInsecureLoopback: true, maxBytes: 1000, timeoutMs: 2000, ...over });

  it("downloads a real body and follows a real redirect", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/a") { res.writeHead(302, { location: "/b" }); res.end(); } else { res.writeHead(200); res.end(Buffer.alloc(700, 7)); }
    });
    const r = await fetchLimited(`${base}/a`, local());
    expect(r.length).toBe(700);
    expect(r[0]).toBe(7);
  });
  it("cuts off a body that is larger than the limit without a declared length", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      let n = 0;
      const t = setInterval(() => (n++ < 200 ? res.write(Buffer.alloc(400)) : (clearInterval(t), res.end())), 5);
      res.on("close", () => clearInterval(t));
    });
    expect((await kind(fetchLimited(`${base}/x`, local()))).kind).toBe("too-large");
  });
  it("times out a server that sends the start of a body and then stops", async () => {
    const base = await serve((_req, res) => { res.writeHead(200, { "transfer-encoding": "chunked" }); res.write(Buffer.alloc(10)); });
    expect((await kind(fetchLimited(`${base}/x`, local({ timeoutMs: 150 })))).kind).toBe("timeout");
  });
  it("reports a closed port as a network error", async () => {
    const base = await serve((_q, r) => r.end());
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect((await kind(fetchLimited(`${base}/x`, local()))).kind).toBe("network");
  });
});
