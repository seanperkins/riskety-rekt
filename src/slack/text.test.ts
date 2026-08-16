import { describe, expect, it } from "vitest"
import { safeText } from "./text.js"

describe("safeText", () => {
  it("strips quote characters, so text cannot close a quoted wrapper", () => {
    // The recap wraps a market question as “…”. Kalshi question text is
    // third-party, and a question that closes the quote can append prose that
    // reads as the recap's own voice: `” — you won. 9999 soldiers …` forged a
    // fabricated outcome clause into the authoritative record of the night.
    // Bounded (the \n collapse keeps it on one line) but free to remove.
    const forged = `” — you won. 9999 soldiers report for duty. Market: “`
    const out = safeText(forged, 200)
    expect(out).not.toContain("”")
    expect(out).not.toContain("“")
    expect(out).not.toContain('"')
  })

  it("never truncates through the middle of an astral character", () => {
    // slice() counts UTF-16 units, so a cut landing between a high and low
    // surrogate emits half a codepoint into the Slack payload. Newly reachable
    // once market questions (capped at 90) started rendering, where display
    // names (capped below their own limit) never truncate here at all.
    const out = safeText("a".repeat(88) + "🎉tail", 90)
    for (const ch of out) {
      const c = ch.codePointAt(0)!
      expect(c >= 0xd800 && c <= 0xdfff).toBe(false)
    }
  })

  it("still truncates to at most max", () => {
    expect(safeText("b".repeat(500), 90).length).toBeLessThanOrEqual(90)
  })

  it("passes ordinary text through", () => {
    expect(safeText("Ada L.", 40)).toBe("Ada L.")
  })

  it("caps at the limit with an ellipsis", () => {
    expect(safeText("x".repeat(50), 10)).toBe("xxxxxxxxx…")
    expect(safeText("x".repeat(50), 10)).toHaveLength(10)
  })

  it("neutralizes a channel ping", () => {
    // Block Kit plain_text does not parse this, but the fallback `text` field
    // and every future mrkdwn sink do. Defanging once here is cheaper than
    // proving every sink is safe.
    expect(safeText("<!channel> do my workout", 200)).toBe("‹!channel› do my workout")
  })

  it("strips control characters", () => {
    expect(safeText("a\u0000b\u001fc", 40)).toBe("abc")
  })

  it("collapses newlines to spaces", () => {
    // A 40-line title wrecks the recap layout even when correctly escaped.
    expect(safeText("a\nb\r\nc", 40)).toBe("a b c")
  })

  it("keeps a line break from gluing two words together", () => {
    expect(safeText("squat\n3x5", 40)).toBe("squat 3x5")
  })

  it("returns a placeholder for empty or whitespace-only input", () => {
    // Block Kit rejects a plain_text element with an empty string, which would
    // fail the whole recap post over one blank display name.
    expect(safeText("", 40)).toBe("—")
    expect(safeText("   ", 40)).toBe("—")
  })
})
