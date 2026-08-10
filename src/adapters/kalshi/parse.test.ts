import { describe, expect, it } from "vitest"
import { PRICE_MAX, PRICE_MIN } from "../../config.js"
import { capQuestion, parseDecimal, seriesOf, toCandidate, toSettlement } from "./parse.js"
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
      closeTime: "2026-08-10T21:30:00Z",
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
