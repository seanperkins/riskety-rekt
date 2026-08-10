/** Season shape. Mirrors the spec's "14 days, one tick per day". */
export const SEASON_LENGTH = 14

/**
 * Roster bounds. New constants — no faction bound existed in code before, only
 * prose in the design spec.
 */
export const MIN_FACTIONS = 4
export const MAX_FACTIONS = 15

/**
 * Territories per faction at the deal.
 *
 * The UPPER bound is not a judgement call: income is `max(5, floor(t/2))`, so
 * `floor(t/2) > 5` first at t = 12 — 11 is exactly where a deal would start
 * above the income floor of 5.
 *
 * The LOWER bound is. Five dealt territories is ten troops: enough that losing
 * one border does not cascade, and it keeps the smallest realistic region (4)
 * in reach. Two or three is the failure it guards — 42 territories dealt to 15
 * factions is 2.8 each, six troops, eliminated by one focused attack. Note that
 * income does NOT distinguish 2.8 from 7.0; both sit at the floor by design.
 */
export const MIN_TERRITORIES_PER_FACTION = 5
export const MAX_TERRITORIES_PER_FACTION = 11

/**
 * Region size band, enforced by `validateMap`.
 *
 * The upper bound is the load-bearing one: a region of twenty territories is
 * a bonus nobody ever collects, which removes the region race rather than
 * adding to it. Classic Risk keeps five of its six continents inside this band
 * — Asia at 12 is the exception, and `RISK_MAP` is grandfathered because it is
 * only the golden fixture and is never selected from.
 */
export const REGION_MIN = 4
export const REGION_MAX = 9

/**
 * The fewest regions a selected board may have.
 *
 * Three is already implied by the size floor — the smallest board is 5 × 4 = 20
 * territories and the largest region is 9, so `ceil(20/9) = 3` is
 * unavoidable — which makes 4 the first value that constrains anything. It is
 * what makes a region race exist rather than a scramble for one of two
 * prizes.
 */
export const MIN_REGIONS = 4

/**
 * Restarts allowed when a selection walk strands itself below the size floor
 * with no adjacent region that fits under the ceiling.
 */
export const MAX_ATTEMPTS = 20

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
