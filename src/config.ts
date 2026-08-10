/** Season shape. Mirrors the spec's "21 days, one tick per day". */
export const SEASON_LENGTH = 21

/** Slate size target. Fewer is published if fewer candidates survive filtering. */
export const SLATE_MIN = 3
export const SLATE_MAX = 5

/** Candidate close window, in America/New_York hours on the slate's own day. */
export const WINDOW_OPEN_HOUR = 9
export const WINDOW_CLOSE_HOUR = 21

/**
 * Price band for slate eligibility. Must equal the engine's payout clamp, or a
 * market could be published at a price the engine then silently clamps away.
 * src/config.test.ts asserts the equality.
 */
export const PRICE_MIN = 0.1
export const PRICE_MAX = 0.9

/**
 * Minimum 24h-cumulative volume, in dollars, for a market to be slate-eligible.
 *
 * Set in Task 5 from a week of observed same-day Kalshi markets. The spec said
 * "set it at the median", but the observed median is 0.00 -- roughly 75% of
 * same-day markets never trade. This is the median of markets with non-zero
 * volume, rounded up to a round number. Re-derive with `npm run sample:kalshi`.
 */
export const VOLUME_FLOOR = 1000

/** Third-party text cap. A 5,000-char title wrecks the recap layout. */
export const QUESTION_MAX_CHARS = 200

export const TIMEZONE = "America/New_York"

export const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
export const HTTP_TIMEOUT_MS = 20_000
export const HTTP_RETRIES = 2
export const HTTP_RETRY_DELAY_MS = 1_000
/** Hard stop on cursor pagination. One observed window needed 6 pages. */
export const MAX_PAGES = 12
/** Kalshi caps `limit` at 1000. */
export const PAGE_LIMIT = 1000
/** Max tickers per `?tickers=` settlement query. */
export const SETTLEMENT_BATCH_SIZE = 100

/**
 * How far back the poller looks for unsettled markets. Wagers refund after 2
 * ticks, so anything older than this can never affect a live wager.
 */
export const SETTLEMENT_HORIZON_DAYS = 4
