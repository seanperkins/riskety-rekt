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
 * Minimum cumulative volume, in dollars, for a market to be slate-eligible.
 *
 * Derived 2026-08-09 from 5,382 structurally-eligible Kalshi markets across a
 * seven-day forward sample. 66.6% of them had never traded, so the median of
 * all markets was 0.00 and the spec's "set it at the median" would have admitted
 * every untraded rung of every strike ladder. Median of markets that did trade
 * was 82.32; p75 was 500.00.
 *
 * 500 is the p75. On the four sample days whose walk completed it left 12-28
 * distinct series to choose from, against a slate of at most 5. The next step
 * up, 1000, left only 6 on the thinnest of those days -- one clear of the slate
 * size, which is not enough room for a quiet Sunday.
 *
 * Re-derive with `npm run sample:kalshi`, and disregard any day the output
 * marks TRUNCATED: its series count is a page-cap artifact, not a measurement.
 */
export const VOLUME_FLOOR = 500

/** Third-party text cap. A 5,000-char title wrecks the recap layout. */
export const QUESTION_MAX_CHARS = 200

export const TIMEZONE = "America/New_York"

export const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
export const HTTP_TIMEOUT_MS = 20_000
export const HTTP_RETRIES = 2
export const HTTP_RETRY_DELAY_MS = 1_000
/**
 * Hard stop on cursor pagination.
 *
 * A production same-day window (status=open) was measured at 5,748 markets in 6
 * pages, so this is roughly 6x headroom. It was 12 until a sampling run came
 * back with exactly 12,000 markets on all seven days — the cap silently
 * truncating every result. Hitting it is now reported, never swallowed.
 */
export const MAX_PAGES = 40
/** Kalshi caps `limit` at 1000. */
export const PAGE_LIMIT = 1000
/** Max tickers per `?tickers=` settlement query. */
export const SETTLEMENT_BATCH_SIZE = 100

/**
 * How far back the poller looks for unsettled markets. Wagers refund after 2
 * ticks, so anything older than this can never affect a live wager.
 */
export const SETTLEMENT_HORIZON_DAYS = 4
