export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<FetchResponse>;

export interface ClientOptions {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  userAgent: string;
  /** Least time between the starts of two requests to the same host, by host name. */
  minIntervalMs: Record<string, number>;
  /** For a host not listed above. Default 1000. */
  defaultMinIntervalMs?: number;
  /** Tries per request, the first included. Default 4. */
  maxAttempts?: number;
  /** Wait before the second try; it doubles after each failure. Default 2000. */
  baseBackoffMs?: number;
  /** No wait is longer than this, whatever the server asks for. Default 120000. */
  maxWaitMs?: number;
}

export interface HttpResult {
  /** The last answer's status, or 0 when no answer came at all (the error text is in `text`). */
  status: number;
  text: string;
  attempts: number;
}

/**
 * One way out to the network for every source. It keeps a minimum gap between requests to the same host, so the free
 * public services are never hit faster than their published limits, and retries what is worth retrying (429, 5xx, a
 * dropped connection) with a doubling wait that honours Retry-After up to a cap. Any other answer, a 404 included, is
 * returned at once: "no such thing" is information, not a reason to ask again.
 */
export class PoliteClient {
  private readonly lastStart = new Map<string, number>();
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxWaitMs: number;
  private readonly defaultMinIntervalMs: number;

  constructor(private readonly options: ClientOptions) {
    this.maxAttempts = options.maxAttempts ?? 4;
    this.baseBackoffMs = options.baseBackoffMs ?? 2000;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.defaultMinIntervalMs = options.defaultMinIntervalMs ?? 1000;
  }

  async get(url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
    const host = new URL(url).host;
    const interval = this.options.minIntervalMs[host] ?? this.defaultMinIntervalMs;
    const send = { "user-agent": this.options.userAgent, accept: "application/json", ...headers };
    let last: HttpResult = { status: 0, text: "no attempt was made", attempts: 0 };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const previous = this.lastStart.get(host);
      if (previous !== undefined) {
        const wait = previous + interval - this.options.now();
        if (wait > 0) await this.options.sleep(wait);
      }
      this.lastStart.set(host, this.options.now());
      let retryAfterMs = 0;
      try {
        const response = await this.options.fetch(url, { headers: send });
        const text = await response.text();
        last = { status: response.status, text, attempts: attempt };
        if (response.status !== 429 && response.status < 500) return last;
        const seconds = Number(response.headers.get("retry-after"));
        if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = seconds * 1000;
      } catch (error) {
        last = { status: 0, text: String(error), attempts: attempt };
      }
      if (attempt < this.maxAttempts) {
        const backoff = this.baseBackoffMs * 2 ** (attempt - 1);
        await this.options.sleep(Math.min(this.maxWaitMs, Math.max(backoff, retryAfterMs)));
      }
    }
    return last;
  }
}
