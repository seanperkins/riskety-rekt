import { MIN_MARKET_HOURS, PRICE_MAX, PRICE_MIN, QUESTION_MAX_CHARS } from "../../config.js"
import type { Settlement } from "../../engine/index.js"
import type { Candidate, CandidateWindow } from "../types.js"
import type { RawKalshiMarket } from "./raw.js"

export type DropReason =
  | "multivariate"
  | "malformed"
  | "close-window"
  | "short-lived"
  | "volume"
  | "price-range"
  | "crossed-book"
  | "bad-ticker"

export type CandidateResult =
  | { ok: true; candidate: Candidate }
  | { ok: false; reason: DropReason }

/** Only plain decimals. Deliberately narrower than Number(). */
const DECIMAL = /^-?\d+(\.\d+)?$/

/**
 * Kalshi tickers are uppercase alphanumerics with dashes in every sample taken.
 * Validated because the id is third-party text that reaches slate_markets, the
 * Slack slate, and an operator's shell -- the same treatment QUESTION_MAX_CHARS
 * already gives the question.
 */
const TICKER = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Strict numeric parse of untrusted wire data.
 *
 * `Number("")` is 0 and `Number(null)` is 0, so a missing Kalshi quote parsed
 * with `Number` becomes a free price of zero. `Number("0x10")` is 16 and
 * `Number("Infinity")` is Infinity. Everything that is not a plain finite
 * decimal returns NaN, and every caller must check.
 */
export function parseDecimal(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN
  if (typeof v !== "string") return Number.NaN
  const s = v.trim()
  if (!DECIMAL.test(s)) return Number.NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : Number.NaN
}

/**
 * Normalize and length-cap third-party question text.
 *
 * Deliberately does NOT escape anything. Each sink has its own encoding --
 * Block Kit `plain_text` for Slack, JSX for the web, entity escaping for SVG --
 * and escaping here would both double-encode and hide the real requirement.
 */
/**
 * The question a player actually has to answer: title plus the strike.
 *
 * A Kalshi `title` is the SERIES question and frequently states no number at
 * all — "BTC price up in next 15 mins?", "Bitcoin price on Aug 12, 2026?" — and
 * the threshold lives in `yes_sub_title` ("Target Price: $63,324.20", "$63,500
 * or above"). Publishing the title alone asks people to stake soldiers on a
 * question with the number missing, which is what shipped until a player asked
 * what price the Bitcoin market meant.
 *
 * Range markets state the bound in both fields, so the subtitle is skipped when
 * the title already carries the same digits. Comparing DIGITS ONLY is what
 * makes that work: the two fields disagree on commas and separators
 * ("7,725 to 7,749.9999" versus "between 7725 and 7749.9999"), so any
 * comparison of the text itself would append a duplicate every time.
 */
export function questionOf(title: unknown, subtitle: unknown): string | null {
  const base = capQuestion(title)
  if (base === null) return null
  const sub = typeof subtitle === "string" ? subtitle.replace(/\s+/g, " ").trim() : ""
  if (sub === "") return base
  const digits = (s: string) => s.replace(/[^0-9.]/g, "")
  const subDigits = digits(sub)
  if (subDigits !== "" && digits(base).includes(subDigits)) return base
  return capQuestion(`${base} — ${sub}`)
}

export function capQuestion(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = v.replace(/\s+/g, " ").trim()
  if (s.length === 0) return null
  return s.length > QUESTION_MAX_CHARS ? s.slice(0, QUESTION_MAX_CHARS) : s
}

/** The series a ticker belongs to: "KXSOLE-26AUG1017-B74" -> "KXSOLE". */
export function seriesOf(ticker: string): string {
  const dash = ticker.indexOf("-")
  return dash === -1 ? ticker : ticker.slice(0, dash)
}

/**
 * Kalshi quotes in deci-cents, so a midpoint is always a multiple of 0.00005
 * and six decimal places is exact. Rounding is not cosmetic: `(0.47 + 0.62) / 2`
 * is 0.5449999999999999, which both sinks below a 0.90 band edge it should sit
 * on and makes a normal book's two mids sum to less than 1 -- 86 in-band
 * bid/ask combinations would otherwise be dropped as crossed books.
 */
const PRICE_PRECISION = 1e6

function midpoint(bid: unknown, ask: unknown): number {
  const b = parseDecimal(bid)
  const a = parseDecimal(ask)
  if (Number.isNaN(b) || Number.isNaN(a)) return Number.NaN
  return Math.round(((b + a) / 2) * PRICE_PRECISION) / PRICE_PRECISION
}

function isIsoInstant(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v))
}

/**
 * Turn one raw Kalshi market into a slate candidate, or say why it was dropped.
 *
 * Order matters only for the drop reason reported, not for correctness: the
 * cheap structural checks run before the arithmetic so a malformed row never
 * reaches a comparison.
 */
export function toCandidate(
  raw: unknown,
  window: CandidateWindow,
  volumeFloor: number,
): CandidateResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "malformed" }
  }
  const m = raw as RawKalshiMarket

  // Combo markets have machine-generated titles like
  // "yes Manny Machado: 1+,yes Ty France: 1+" -- unusable as a daily question.
  if (typeof m.mve_collection_ticker === "string" && m.mve_collection_ticker.length > 0) {
    return { ok: false, reason: "multivariate" }
  }

  const id = typeof m.ticker === "string" ? m.ticker.trim() : ""
  const question = questionOf(m.title, m.yes_sub_title)
  if (id.length === 0 || question === null) return { ok: false, reason: "malformed" }
  if (!TICKER.test(id)) return { ok: false, reason: "bad-ticker" }
  if (!isIsoInstant(m.close_time)) return { ok: false, reason: "malformed" }

  const volume = parseDecimal(m.volume_fp)
  const priceYes = midpoint(m.yes_bid_dollars, m.yes_ask_dollars)
  const priceNo = midpoint(m.no_bid_dollars, m.no_ask_dollars)
  if (Number.isNaN(volume) || Number.isNaN(priceYes) || Number.isNaN(priceNo)) {
    return { ok: false, reason: "malformed" }
  }

  const closeMs = Date.parse(m.close_time)
  // Strictly inside: a market closing at exactly the 21:00 order lock is excluded.
  if (closeMs <= window.opensAfter.getTime() || closeMs >= window.closesBefore.getTime()) {
    return { ok: false, reason: "close-window" }
  }

  // A market that opened and closes inside one day is not a day's wager: by the
  // time a player reads the morning slate it has already happened. Kalshi's
  // 15-minute crypto ladders are the case this exists for.
  //
  // A missing or unparseable open_time does NOT disqualify. Absence is not
  // evidence, and a field Kalshi stops sending must not silently empty the
  // slate every morning.
  const openMs = Date.parse(typeof m.open_time === "string" ? m.open_time : "")
  if (Number.isFinite(openMs) && closeMs - openMs < MIN_MARKET_HOURS * 3_600_000) {
    return { ok: false, reason: "short-lived" }
  }

  if (volume < volumeFloor) return { ok: false, reason: "volume" }

  if (priceYes < PRICE_MIN || priceYes > PRICE_MAX || priceNo < PRICE_MIN || priceNo > PRICE_MAX) {
    return { ok: false, reason: "price-range" }
  }

  // Two independently snapshotted mids summing below 1.0 would make the
  // both-sides hedge pay more than the intended 10% house bonus. The epsilon
  // keeps float residue from rejecting a book that sums to exactly 1; a real
  // crossed book is off by cents, never by 1e-9.
  if (priceYes + priceNo < 1 - 1e-9) return { ok: false, reason: "crossed-book" }

  return {
    ok: true,
    candidate: {
      id,
      question,
      priceYes,
      priceNo,
      // Normalized, not verbatim: the per-market wager lock compares this as a
      // STRING against now.toISOString(). An offset form sorts wrong and a
      // date-only value sorts after every same-day instant, reading as open
      // forever -- in the player's favour, which is what the lock exists to
      // prevent.
      closeTime: new Date(m.close_time).toISOString(),
      volume,
      series: seriesOf(id),
    },
  }
}

const SETTLED_STATUSES = new Set(["settled", "finalized"])

/**
 * Map a raw market to a settlement outcome.
 *
 * Anything that is not an unambiguous settled yes/no is "unsettled": an active
 * market, a void result, a timeout, junk. Unsettled rolls forward and the
 * engine refunds it after two ticks, so absorbing failure here is safe.
 *
 * Note the status check reads the *response* field. Querying `?status=settled`
 * returns markets whose own `status` reads "finalized".
 */
export function toSettlement(raw: unknown): Settlement {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "unsettled"
  const m = raw as RawKalshiMarket
  if (typeof m.status !== "string" || !SETTLED_STATUSES.has(m.status)) return "unsettled"
  if (m.result === "yes") return "yes"
  if (m.result === "no") return "no"
  return "unsettled"
}
