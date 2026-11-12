// The only way the app fetches an engine release. It goes only to hosts on a fixed list, over https, follows redirects one
// hop at a time (checking every hop), refuses credentials in addresses, reads at most `maxBytes`, and gives up after a
// deadline that covers the whole transfer, body included.

export type FetchErrorKind = "scheme" | "host" | "credentials" | "redirect" | "status" | "too-large" | "timeout" | "network";

export class FetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  allowedHosts: readonly string[];
  maxBytes: number;
  /** For the whole transfer, body included. Default 60 s. */
  timeoutMs?: number;
  /** Default 5. */
  maxRedirects?: number;
  /** For tests only: allow plain http to 127.0.0.1, [::1] and localhost. */
  allowInsecureLoopback?: boolean;
  fetchImpl?: typeof fetch;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

function checkUrl(url: URL, options: FetchOptions): void {
  const shown = `${url.protocol}//${url.hostname}`;
  if (url.username !== "" || url.password !== "") throw new FetchError("credentials", `an address with a user name or password is not allowed (${shown})`);
  const loopback = options.allowInsecureLoopback === true && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new FetchError("scheme", `only https addresses are allowed, not ${shown}`);
  const host = url.hostname.toLowerCase();
  if (!options.allowedHosts.some((h) => h.toLowerCase() === host)) throw new FetchError("host", `the host ${url.hostname} is not on the list of allowed hosts`);
}

function positiveInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${name} must be a positive whole number`);
}

export async function fetchLimited(rawUrl: string, options: FetchOptions): Promise<Uint8Array> {
  positiveInt("maxBytes", options.maxBytes);
  const timeoutMs = options.timeoutMs ?? 60_000;
  positiveInt("timeoutMs", timeoutMs);
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new RangeError("maxRedirects must be a whole number, 0 or more");
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reader?.cancel().catch(() => {});
      reject(new FetchError("timeout", `no complete answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  deadline.catch(() => {});

  const run = async (): Promise<Uint8Array> => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new FetchError("scheme", "not a valid address");
    }
    for (let hop = 0; ; hop++) {
      checkUrl(url, options);
      let res: Response;
      try {
        res = await doFetch(url, { redirect: "manual", signal: controller.signal, headers: { accept: "application/octet-stream" } });
      } catch (e) {
        if (e instanceof FetchError) throw e;
        throw new FetchError(timedOut ? "timeout" : "network", timedOut ? `no complete answer within ${timeoutMs} ms` : `cannot reach ${url.hostname}: ${(e as Error).message}`);
      }
      if (REDIRECTS.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) throw new FetchError("redirect", `more than ${maxRedirects} redirects`);
        const location = res.headers.get("location");
        if (location === null || location === "") throw new FetchError("redirect", "a redirect without a Location");
        try {
          url = new URL(location, url);
        } catch {
          throw new FetchError("redirect", "a redirect to an address that is not valid");
        }
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        throw new FetchError("status", `HTTP ${res.status} from ${url.hostname}`, res.status);
      }
      const declared = res.headers.get("content-length");
      if (declared !== null && Number(declared) > options.maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new FetchError("too-large", `the answer says it is ${declared} bytes; the limit is ${options.maxBytes}`);
      }
      if (res.body === null) return new Uint8Array(0);
      const rd = res.body.getReader();
      reader = rd;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        let step: Awaited<ReturnType<typeof rd.read>>;
        try {
          step = await rd.read();
        } catch (e) {
          throw new FetchError(timedOut ? "timeout" : "network", timedOut ? `no complete answer within ${timeoutMs} ms` : `the transfer broke off: ${(e as Error).message}`);
        }
        if (step.done) break;
        total += step.value.length;
        if (total > options.maxBytes) {
          await rd.cancel().catch(() => {});
          throw new FetchError("too-large", `the answer is larger than the limit of ${options.maxBytes} bytes`);
        }
        chunks.push(step.value);
      }
      return Buffer.concat(chunks);
    }
  };

  const work = run();
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
