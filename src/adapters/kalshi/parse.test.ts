import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { PRICE_MAX, PRICE_MIN, QUESTION_MAX_CHARS, VOLUME_FLOOR } from "../../config.js"
import { capQuestion, parseDecimal, questionOf, seriesOf, toCandidate, toSettlement } from "./parse.js"
import type { CandidateWindow } from "../types.js"

const WINDOW: CandidateWindow = {
  opensAfter: new Date("2026-08-10T13:00:00Z"), // 09:00 ET
  closesBefore: new Date("2026-08-11T01:00:00Z"), // 21:00 ET
}

/** A real market, trimmed. Verbatim from the API on 2026-08-09. */
const GOOD = {
  ticker: "KXURYPDGAME-26AUG08TORPEN-PEN",
  event_ticker: "KXURYPDGAME-26AUG08TORPEN",
  title: "Montevideo City vs Penarol Winner?",
  status: "active",
  result: "",
  open_time: "2026-08-05T05:36:00Z",
  close_time: "2026-08-10T21:30:00Z",
  volume_fp: "38457.31",
  yes_bid_dollars: "0.3800",
  yes_ask_dollars: "0.5300",
  no_bid_dollars: "0.4700",
  no_ask_dollars: "0.6200",
}

describe("close_time normalization and ticker validation", () => {
  it("normalizes close_time to a millisecond ISO instant", () => {
    // The per-market wager lock is a STRING comparison. An offset form sorts
    // wrong against now.toISOString(), and a date-only value sorts after every
    // same-day instant -- reading as open forever.
    const r = toCandidate({ ...GOOD, close_time: "2026-08-10T17:30:00-04:00" }, WINDOW, 1000)
    expect(r.ok && r.candidate.closeTime).toBe("2026-08-10T21:30:00.000Z")
  })

  it("leaves an already-normal close_time alone", () => {
    const r = toCandidate(GOOD, WINDOW, 1000)
    expect(r.ok && r.candidate.closeTime).toBe("2026-08-10T21:30:00.000Z")
  })

  it("rejects a ticker with shell metacharacters", () => {
    // The ticker reaches slate_markets, the Slack slate, and an operator's
    // clipboard. Its own drop reason, so a systematic rejection is visible
    // rather than hidden inside "malformed".
    for (const bad of ["KX;rm -rf /", "KX`id`", "KX$(id)", "KX&&ls", "KX A", "KX'x"]) {
      expect(toCandidate({ ...GOOD, ticker: bad }, WINDOW, 1000)).toEqual({
        ok: false,
        reason: "bad-ticker",
      })
    }
  })

  it("accepts a real Kalshi ticker", () => {
    expect(toCandidate(GOOD, WINDOW, 1000).ok).toBe(true)
  })
})

describe("parseDecimal", () => {
  it("parses a decimal string", () => {
    expect(parseDecimal("0.3800")).toBe(0.38)
  })

  it("returns NaN for empty string", () => {
    // Number("") is 0. A missing quote must never become a free price of zero.
    expect(parseDecimal("")).toBeNaN()
  })

  it("returns NaN for null and undefined", () => {
    expect(parseDecimal(null)).toBeNaN()
    expect(parseDecimal(undefined)).toBeNaN()
  })

  it("returns NaN for non-numeric text", () => {
    expect(parseDecimal("abc")).toBeNaN()
    expect(parseDecimal("0.38abc")).toBeNaN()
  })

  it("returns NaN for whitespace", () => {
    expect(parseDecimal("   ")).toBeNaN()
  })

  it("rejects the numeric literals Number() accepts", () => {
    // Number("0x10") is 16, Number("1e3") is 1000, Number("Infinity") is Infinity.
    expect(parseDecimal("0x10")).toBeNaN()
    expect(parseDecimal("1e3")).toBeNaN()
    expect(parseDecimal("Infinity")).toBeNaN()
  })

  it("passes through finite numbers", () => {
    expect(parseDecimal(0.38)).toBe(0.38)
  })

  it("returns NaN for non-finite numbers", () => {
    expect(parseDecimal(Number.NaN)).toBeNaN()
    expect(parseDecimal(Number.POSITIVE_INFINITY)).toBeNaN()
  })
})

describe("short-lived markets", () => {
  // Kalshi runs ladders of 15-minute crypto markets. Measured on a live slate:
  // 0.25h of life against 17.5-25h for the daily ones, so the two are cleanly
  // separable. They are a bad daily wager -- the whole market opens and closes
  // inside the gap between the 08:00 slate and the 21:00 tick, so a player who
  // read the slate in the morning is staking on something that had not started.
  const long = { ...GOOD, open_time: "2026-08-09T21:30:00Z" } // 24h

  it("drops a market whose whole life is shorter than the game's day", () => {
    const r = toCandidate({ ...GOOD, open_time: "2026-08-10T21:15:00Z" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "short-lived" })
  })

  it("keeps a market that has been open since yesterday", () => {
    expect(toCandidate(long, WINDOW, 1000).ok).toBe(true)
  })

  it("keeps a market whose open_time is missing or unreadable", () => {
    // Absence is not disqualifying: a field Kalshi stops sending must not
    // silently empty the slate.
    expect(toCandidate({ ...GOOD, open_time: undefined }, WINDOW, 1000).ok).toBe(true)
    expect(toCandidate({ ...GOOD, open_time: "not a date" }, WINDOW, 1000).ok).toBe(true)
  })
})

describe("questionOf — the title alone is not a question", () => {
  it("appends the strike, because the title does not carry it", () => {
    // Sampled live: the title is the SERIES question and the number lives in
    // yes_sub_title. Without it a player stakes soldiers on "BTC price up in
    // next 15 mins?" with no target to reason about.
    expect(questionOf("BTC price up in next 15 mins?", "Target Price: $63,324.20")).toBe(
      "BTC price up in next 15 mins? — Target Price: $63,324.20",
    )
    expect(questionOf("Bitcoin price on Aug 12, 2026?", "$63,500 or above")).toBe(
      "Bitcoin price on Aug 12, 2026? — $63,500 or above",
    )
  })

  it("does not repeat a threshold the title already states", () => {
    // Range markets put it in both. Commas and separators differ between the
    // two fields, so the comparison ignores everything but the digits.
    expect(
      questionOf(
        "Will the S&P 500 be between 7725 and 7749.9999 on Aug 12, 2026 at 4pm EDT?",
        "7,725 to 7,749.9999",
      ),
    ).toBe("Will the S&P 500 be between 7725 and 7749.9999 on Aug 12, 2026 at 4pm EDT?")
  })

  it("falls back to the title when there is no subtitle", () => {
    expect(questionOf("Who wins?", undefined)).toBe("Who wins?")
    expect(questionOf("Who wins?", "")).toBe("Who wins?")
    expect(questionOf("Who wins?", null)).toBe("Who wins?")
  })

  it("returns null for a title that is not usable", () => {
    expect(questionOf(undefined, "$5")).toBeNull()
    expect(questionOf("", "$5")).toBeNull()
  })

  it("caps the joined string, not just the title", () => {
    const out = questionOf("x".repeat(190), "Target Price: $1.00")
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(QUESTION_MAX_CHARS)
  })
})

describe("capQuestion", () => {
  it("keeps a normal title", () => {
    expect(capQuestion("Montevideo City vs Penarol Winner?")).toBe(
      "Montevideo City vs Penarol Winner?",
    )
  })

  it("collapses whitespace", () => {
    expect(capQuestion("a\n\n  b\tc")).toBe("a b c")
  })

  it("truncates past the cap", () => {
    const out = capQuestion("x".repeat(500))
    expect(out).not.toBeNull()
    expect(out!.length).toBe(200)
  })

  it("returns null for empty or non-string", () => {
    expect(capQuestion("")).toBeNull()
    expect(capQuestion("   ")).toBeNull()
    expect(capQuestion(null)).toBeNull()
    expect(capQuestion(42)).toBeNull()
  })

  it("does not alter hostile text -- escaping belongs at the render sink", () => {
    // Encoding is per-sink (Block Kit plain_text, JSX, SVG escaping). Mangling
    // it here would give a false sense of safety at the sinks that matter.
    expect(capQuestion("</text><script>alert(1)</script>")).toBe(
      "</text><script>alert(1)</script>",
    )
    expect(capQuestion("<!channel> who wins?")).toBe("<!channel> who wins?")
  })
})

describe("seriesOf", () => {
  it("takes the segment before the first dash", () => {
    expect(seriesOf("KXSOLE-26AUG1017-B74")).toBe("KXSOLE")
  })

  it("handles a ticker with no dash", () => {
    expect(seriesOf("PLAIN")).toBe("PLAIN")
  })
})

describe("toCandidate", () => {
  it("accepts a real market and snapshots both side mids", () => {
    const r = toCandidate(GOOD, WINDOW, 1000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.candidate).toEqual({
      id: "KXURYPDGAME-26AUG08TORPEN-PEN",
      question: "Montevideo City vs Penarol Winner?",
      priceYes: 0.455, // (0.38 + 0.53) / 2
      priceNo: 0.545, // (0.47 + 0.62) / 2, rounded
      closeTime: "2026-08-10T21:30:00.000Z", // normalized at ingest
      volume: 38457.31,
      series: "KXURYPDGAME",
    })
  })

  it("stores priceNo explicitly rather than deriving 1 - priceYes", () => {
    const r = toCandidate(GOOD, WINDOW, 1000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Kalshi quotes each side with its own spread. Deriving would be wrong the
    // moment the two mids do not sum to exactly 1.
    expect(r.candidate.priceNo).toBe(0.545)
  })

  it("drops multivariate combo markets", () => {
    const r = toCandidate({ ...GOOD, mve_collection_ticker: "KXMVE-R" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "multivariate" })
  })

  it("drops a market closing at or after the window end", () => {
    // A market closing at exactly 21:00:00 ET is excluded -- the spec is explicit.
    const r = toCandidate({ ...GOOD, close_time: "2026-08-11T01:00:00Z" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "close-window" })
  })

  it("drops a market closing before the window opens", () => {
    const r = toCandidate({ ...GOOD, close_time: "2026-08-10T12:00:00Z" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "close-window" })
  })

  it("drops a market with an unparseable close time", () => {
    const r = toCandidate({ ...GOOD, close_time: "not a date" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "malformed" })
  })

  it("drops a market below the volume floor", () => {
    const r = toCandidate({ ...GOOD, volume_fp: "999.99" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "volume" })
  })

  it("accepts a market exactly at the volume floor", () => {
    const r = toCandidate({ ...GOOD, volume_fp: "1000" }, WINDOW, 1000)
    expect(r.ok).toBe(true)
  })

  it("drops a market with a missing quote rather than treating it as zero", () => {
    const r = toCandidate({ ...GOOD, yes_bid_dollars: "" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "malformed" })
  })

  it("drops a market whose volume is unparseable", () => {
    const r = toCandidate({ ...GOOD, volume_fp: "" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "malformed" })
  })

  it("drops a market priced outside the band on either side", () => {
    // yes mid 0.05, no mid 0.95
    const cheap = {
      ...GOOD,
      yes_bid_dollars: "0.0400",
      yes_ask_dollars: "0.0600",
      no_bid_dollars: "0.9400",
      no_ask_dollars: "0.9600",
    }
    expect(toCandidate(cheap, WINDOW, 1000)).toEqual({ ok: false, reason: "price-range" })
  })

  it("accepts a market exactly on the band edges", () => {
    const edge = {
      ...GOOD,
      yes_bid_dollars: "0.0900",
      yes_ask_dollars: "0.1100", // mid 0.10
      no_bid_dollars: "0.8900",
      no_ask_dollars: "0.9100", // mid 0.90
    }
    const r = toCandidate(edge, WINDOW, 1000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.candidate.priceYes).toBeCloseTo(PRICE_MIN, 10)
    expect(r.candidate.priceNo).toBeCloseTo(PRICE_MAX, 10)
  })

  it("rounds midpoints so float residue does not fake a crossed book", () => {
    // (0.03 + 0.17)/2 = 0.1 and (0.83 + 0.97)/2 = 0.8999999999999999, which
    // sums to just under 1. 86 in-band bid/ask combinations hit this; without
    // rounding they are all dropped as crossed books.
    const r = toCandidate(
      {
        ...GOOD,
        yes_bid_dollars: "0.0300",
        yes_ask_dollars: "0.1700",
        no_bid_dollars: "0.8300",
        no_ask_dollars: "0.9700",
      },
      WINDOW,
      1000,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.candidate.priceYes).toBe(0.1)
    expect(r.candidate.priceNo).toBe(0.9)
  })

  it("rounds a midpoint that float error would push outside the band", () => {
    // The same residue in the other direction would fail the PRICE_MAX check
    // on a market whose NO mid is exactly 0.90.
    const r = toCandidate(
      {
        ...GOOD,
        yes_bid_dollars: "0.0500",
        yes_ask_dollars: "0.1500",
        no_bid_dollars: "0.8500",
        no_ask_dollars: "0.9500",
      },
      WINDOW,
      1000,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.candidate.priceNo).toBe(PRICE_MAX)
  })

  it("drops a crossed book whose sides sum below 1", () => {
    // If the two independently-snapshotted mids sum below 1.0, the both-sides
    // hedge would pay more than the intended 10%. One-wager-per-market already
    // blocks it in the engine; this is the second lock on the same door.
    const crossed = {
      ...GOOD,
      yes_bid_dollars: "0.3000",
      yes_ask_dollars: "0.4000", // mid 0.35
      no_bid_dollars: "0.5000",
      no_ask_dollars: "0.6000", // mid 0.55, sum 0.90
    }
    expect(toCandidate(crossed, WINDOW, 1000)).toEqual({ ok: false, reason: "crossed-book" })
  })

  it("drops a market with no usable title", () => {
    expect(toCandidate({ ...GOOD, title: "" }, WINDOW, 1000)).toEqual({
      ok: false,
      reason: "malformed",
    })
  })

  it("drops a market with no ticker", () => {
    expect(toCandidate({ ...GOOD, ticker: "" }, WINDOW, 1000)).toEqual({
      ok: false,
      reason: "malformed",
    })
  })

  it("drops junk instead of throwing", () => {
    for (const junk of [null, undefined, 42, "string", [], {}]) {
      const r = toCandidate(junk, WINDOW, 1000)
      expect(r.ok).toBe(false)
    }
  })

  it("never emits a non-finite price", () => {
    // The clamp in the engine cannot filter NaN: Math.max(a, Math.min(b, NaN))
    // is NaN, and a NaN price persisted to disk poisons every later tick.
    const nan = { ...GOOD, yes_bid_dollars: "NaN", yes_ask_dollars: "NaN" }
    expect(toCandidate(nan, WINDOW, 1000)).toEqual({ ok: false, reason: "malformed" })
  })
})

describe("toSettlement", () => {
  it("maps a finalized yes", () => {
    expect(toSettlement({ status: "finalized", result: "yes" })).toBe("yes")
  })

  it("maps a finalized no", () => {
    expect(toSettlement({ status: "finalized", result: "no" })).toBe("no")
  })

  it("maps a settled status too", () => {
    expect(toSettlement({ status: "settled", result: "yes" })).toBe("yes")
  })

  it("treats an active market as unsettled even if a result leaked in", () => {
    expect(toSettlement({ status: "active", result: "yes" })).toBe("unsettled")
  })

  it("treats an empty or void result as unsettled", () => {
    // Void rolls forward and is refunded by the engine at 2 ticks.
    expect(toSettlement({ status: "finalized", result: "" })).toBe("unsettled")
    expect(toSettlement({ status: "finalized", result: "void" })).toBe("unsettled")
  })

  it("treats junk as unsettled", () => {
    for (const junk of [null, undefined, 42, "yes", []]) {
      expect(toSettlement(junk)).toBe("unsettled")
    }
  })
})

describe("recorded fixtures", () => {
  const body = JSON.parse(
    readFileSync(new URL("./__fixtures__/candidates-page.json", import.meta.url), "utf8"),
  ) as { markets: unknown[] }

  // A window wide enough that close-time filtering does not dominate; the point
  // of these tests is that real payloads never produce a bad Candidate.
  const wide: CandidateWindow = {
    opensAfter: new Date("2000-01-01T00:00:00Z"),
    closesBefore: new Date("2100-01-01T00:00:00Z"),
  }

  it("has markets to test against", () => {
    expect(body.markets.length).toBeGreaterThan(0)
  })

  it("never produces a malformed Candidate from a real payload", () => {
    for (const raw of body.markets) {
      const r = toCandidate(raw, wide, 0)
      if (!r.ok) continue
      const c = r.candidate
      expect(Number.isFinite(c.priceYes)).toBe(true)
      expect(Number.isFinite(c.priceNo)).toBe(true)
      expect(c.priceYes).toBeGreaterThanOrEqual(PRICE_MIN)
      expect(c.priceYes).toBeLessThanOrEqual(PRICE_MAX)
      expect(c.priceNo).toBeGreaterThanOrEqual(PRICE_MIN)
      expect(c.priceNo).toBeLessThanOrEqual(PRICE_MAX)
      expect(c.priceYes + c.priceNo).toBeGreaterThanOrEqual(1)
      expect(c.question.length).toBeGreaterThan(0)
      expect(c.question.length).toBeLessThanOrEqual(200)
      expect(c.id.length).toBeGreaterThan(0)
      expect(c.volume).toBeGreaterThanOrEqual(0)
    }
  })

  it("is entirely short-lived, which is what a same-day window looks like", () => {
    // Not an accident of sampling. Run late in the ET day, the only markets
    // still closing before 21:00 are Kalshi's 15-minute crypto ladders -- so
    // this fixture accepts nothing, and IS the short-lived path.
    const results = body.markets.map((m) => toCandidate(m, wide, VOLUME_FLOOR))
    expect(results.filter((r) => r.ok)).toHaveLength(0)
    expect(results.some((r) => !r.ok && r.reason === "short-lived")).toBe(true)
  })
})

describe("recorded fixtures — the next-day window an 08:00 publish actually sees", () => {
  const body = JSON.parse(
    readFileSync(new URL("./__fixtures__/candidates-nextday.json", import.meta.url), "utf8"),
  ) as { markets: unknown[] }
  const wide: CandidateWindow = {
    opensAfter: new Date("2000-01-01T00:00:00Z"),
    closesBefore: new Date("2100-01-01T00:00:00Z"),
  }

  it("accepts some markets and rejects others -- the fixture spans outcomes", () => {
    // A fixture where everything passes, or everything fails, silently stops
    // testing the filters it was recorded to test.
    const results = body.markets.map((m) => toCandidate(m, wide, VOLUME_FLOOR))
    const accepted = results.filter((r) => r.ok).length
    const reasons = new Set(results.flatMap((r) => (r.ok ? [] : [r.reason])))
    expect(accepted).toBeGreaterThan(0)
    expect(reasons.has("multivariate")).toBe(true)
    expect(reasons.has("volume")).toBe(true)
    expect(reasons.size).toBeGreaterThanOrEqual(2)
  })

  it("keeps real day-length markets — the rule must not empty the slate", () => {
    // The whole risk of MIN_MARKET_HOURS: a filter that drops the junk and the
    // day's actual markets with it. Measured live, it drops none of these.
    const results = body.markets.map((m) => toCandidate(m, wide, VOLUME_FLOOR))
    expect(results.some((r) => !r.ok && r.reason === "short-lived")).toBe(false)
  })

  it("never produces a malformed Candidate from a real payload", () => {
    for (const raw of body.markets) {
      const r = toCandidate(raw, wide, 0)
      if (!r.ok) continue
      const c = r.candidate
      expect(Number.isFinite(c.priceYes)).toBe(true)
      expect(Number.isFinite(c.priceNo)).toBe(true)
      expect(c.question.length).toBeGreaterThan(0)
      expect(c.question.length).toBeLessThanOrEqual(200)
      expect(c.id.length).toBeGreaterThan(0)
    }
  })

  it("drops every multivariate combo market in the fixture", () => {
    const combos = body.markets.filter(
      (m) => typeof (m as { mve_collection_ticker?: unknown }).mve_collection_ticker === "string",
    )
    expect(combos.length).toBeGreaterThan(0)
    for (const m of combos) {
      expect(toCandidate(m, wide, 0)).toEqual({ ok: false, reason: "multivariate" })
    }
  })
})
