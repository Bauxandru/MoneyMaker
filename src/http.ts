import { sleep } from "./utils.js";

export type RetryOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  retryOnStatuses?: number[];
};

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}. ${body}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {}
): Promise<T> {
  const maxRetries = Math.max(0, opts.maxRetries ?? 4);
  const baseDelayMs = Math.max(50, opts.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 8000);
  const jitterMs = Math.max(0, opts.jitterMs ?? 200);
  const timeoutMs = opts.timeoutMs ?? 15000;
  const retryOnStatuses = new Set(
    opts.retryOnStatuses ?? [429, 500, 502, 503, 504]
  );

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(
          `HTTP ${res.status} ${res.statusText} for ${url}. ${body}`
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    } catch (err) {
      const status = (err as { status?: number }).status;
      const isAbort = (err as Error).name === "AbortError";
      const shouldRetry =
        attempt < maxRetries &&
        (isAbort || status === undefined || retryOnStatuses.has(status));
      if (!shouldRetry) {
        throw err;
      }
      const delay =
        Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt)) +
        Math.floor(Math.random() * jitterMs);
      await sleep(delay);
      attempt += 1;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Create a rate-limited fetch function with its own queue.
 * Each call is serialized and spaced by at least `intervalMs`.
 * Each instance has an independent queue -- Kalshi and Polymarket won't block each other.
 */
export function createRateLimitedFetcher(
  intervalMs: number,
  retryOpts: RetryOptions = {}
): <T>(url: string) => Promise<T> {
  let nextAllowedAt = 0;

  return async function rateLimitedFetch<T>(url: string): Promise<T> {
    // Reserve a slot: each request gets its own time slot, spaced by intervalMs.
    // Does NOT wait for previous requests to complete — only for the time window.
    // This prevents a slow/hanging request from blocking the entire queue.
    const now = Date.now();
    const mySlot = Math.max(now, nextAllowedAt);
    nextAllowedAt = mySlot + intervalMs;
    const wait = mySlot - now;
    if (wait > 0) await sleep(wait);
    return fetchJsonWithRetry<T>(url, {}, retryOpts);
  };
}
