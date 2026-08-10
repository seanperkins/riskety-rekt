import {
  HTTP_RETRIES,
  HTTP_RETRY_DELAY_MS,
  HTTP_TIMEOUT_MS,
  KALSHI_BASE_URL,
  MAX_PAGES,
} from "../../config.js"
import type { RawKalshiMarket, RawKalshiMarketsResponse } from "./raw.js"

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ClientOptions {
  fetchImpl?: FetchLike
  /** Injected so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>
  baseUrl?: string
  /** Overrides MAX_PAGES. The sampling script needs a far larger walk. */
  maxPages?: number
  /**
   * Called when the walk stops at the page cap with a cursor still pending, so
   * the caller knows its result is incomplete. A truncated candidate set is
   * survivable — a truncated candidate set nobody knows about is not.
   */
  onTruncate?: (pages: number, collected: number) => void
}

export class KalshiHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "KalshiHttpError"
    this.status = status
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 5xx and 429 are worth another try; 4xx will stay broken. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * GET a JSON document, with a hard timeout and a bounded retry budget.
 *
 * The timeout matters more than it looks: a hung TLS handshake with no
 * AbortSignal would leave the 08:00 job running until systemd killed it, and
 * the day would silently get no slate.
 */
export async function getJson(
  path: string,
  params: Record<string, string>,
  opts: ClientOptions = {},
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const url = new URL((opts.baseUrl ?? KALSHI_BASE_URL) + path)
  for (const key of Object.keys(params).sort()) {
    url.searchParams.set(key, params[key]!)
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt++) {
    if (attempt > 0) await sleep(HTTP_RETRY_DELAY_MS)
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
      if (!res.ok) {
        const err = new KalshiHttpError(res.status, `Kalshi ${path} returned ${res.status}`)
        if (!isRetryable(res.status)) throw err
        lastError = err
        continue
      }
      return await res.json()
    } catch (err) {
      // A non-retryable HTTP error must escape immediately.
      if (err instanceof KalshiHttpError && !isRetryable(err.status)) throw err
      lastError = err
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Kalshi ${path} failed: ${String(lastError)}`)
}

/**
 * Fetch every page of /markets for a query.
 *
 * Pagination is not optional: one observed same-day close window held 5,748
 * markets across 6 pages of 1,000. MAX_PAGES is a backstop against a cursor
 * that never advances.
 */
export async function getAllMarkets(
  params: Record<string, string>,
  opts: ClientOptions = {},
): Promise<RawKalshiMarket[]> {
  const out: RawKalshiMarket[] = []
  const maxPages = opts.maxPages ?? MAX_PAGES
  let cursor = ""
  for (let page = 0; page < maxPages; page++) {
    const query = cursor ? { ...params, cursor } : params
    const body = (await getJson("/markets", query, opts)) as RawKalshiMarketsResponse
    // A page without a markets array is a malformed response, and the only
    // quiet way to handle it is to truncate the candidate set -- which surfaces
    // later as an inexplicably thin slate and nothing else. Fail loudly
    // instead; the publish job records nothing and systemd retries.
    if (!Array.isArray(body?.markets)) {
      throw new Error(`Kalshi /markets page ${page} had no markets array`)
    }
    const markets = body.markets
    for (const m of markets) {
      if (typeof m === "object" && m !== null && !Array.isArray(m)) {
        out.push(m as RawKalshiMarket)
      }
    }
    const next = typeof body.cursor === "string" ? body.cursor : ""
    // An empty page ends the walk even when a cursor is returned -- Kalshi
    // hands back a cursor on the final page and following it loops.
    if (next === "" || markets.length === 0) return out
    cursor = next
  }
  // Fell out of the loop with a cursor still pending: the result is a prefix of
  // the real window, not the window.
  opts.onTruncate?.(maxPages, out.length)
  return out
}
