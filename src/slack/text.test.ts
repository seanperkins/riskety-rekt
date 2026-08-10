import { describe, expect, it } from "vitest"
import { safeText } from "./text.js"

describe("safeText", () => {
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
