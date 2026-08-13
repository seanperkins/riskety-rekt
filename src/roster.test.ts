import { describe, expect, it } from "vitest"
import { DISPLAY_NAME_MAX_CHARS } from "./config.js"
import { coerceDisplayName, factionIdFrom, normalizeDisplayName } from "./roster.js"

describe("factionIdFrom", () => {
  it("makes a readable id out of a display name", () => {
    expect(factionIdFrom("Ada Lovelace", new Set())).toBe("ada-lovelace")
    expect(factionIdFrom("SEAN.md", new Set())).toBe("sean-md")
  })

  it("strips accents rather than dropping the letters", () => {
    expect(factionIdFrom("José", new Set())).toBe("jose")
  })

  it("never collides, because two people really can share a display name", () => {
    const taken = new Set(["sam"])
    expect(factionIdFrom("Sam", taken)).toBe("sam-2")
    expect(factionIdFrom("Sam", new Set(["sam", "sam-2"]))).toBe("sam-3")
  })

  it("falls back rather than producing an empty id", () => {
    expect(factionIdFrom("🎲🎲", new Set())).toBe("player")
  })
})

describe("normalizeDisplayName", () => {
  it("accepts an ordinary name unchanged", () => {
    expect(normalizeDisplayName("Ada Lovelace")).toEqual({ ok: true, name: "Ada Lovelace" })
  })

  it("trims and collapses whitespace", () => {
    expect(normalizeDisplayName("  Ada   Lovelace \n")).toEqual({
      ok: true,
      name: "Ada Lovelace",
    })
  })

  it("strips control characters", () => {
    // A name reaches a Slack payload and an HTML page. The HTML side is escaped
    // at render, but a raw control character in the database is a thing every
    // later reader has to remember to handle.
    expect(normalizeDisplayName("Ada\u0007Lovelace")).toEqual({ ok: true, name: "AdaLovelace" })
  })

  it("refuses a name that is empty once cleaned", () => {
    expect(normalizeDisplayName("   ")).toEqual({ ok: false, reason: "empty" })
    expect(normalizeDisplayName("\u0000\u0001")).toEqual({ ok: false, reason: "empty" })
  })

  it("refuses rather than silently truncating an over-long name", () => {
    // Truncation is the wrong answer for a name somebody just typed: they get
    // no signal, and the stored name is not the one they chose. The recap's
    // safeText DOES truncate, which is right for a Kalshi question nobody
    // typed — this is the opposite case.
    const long = "a".repeat(DISPLAY_NAME_MAX_CHARS + 1)
    expect(normalizeDisplayName(long)).toEqual({ ok: false, reason: "too-long" })
    expect(normalizeDisplayName("a".repeat(DISPLAY_NAME_MAX_CHARS))).toEqual({
      ok: true,
      name: "a".repeat(DISPLAY_NAME_MAX_CHARS),
    })
  })

  it("measures length AFTER cleaning, not before", () => {
    // Otherwise a name padded with spaces is refused for being too long and
    // the person cannot see why.
    const padded = `   ${"a".repeat(DISPLAY_NAME_MAX_CHARS)}   `
    expect(normalizeDisplayName(padded)).toEqual({
      ok: true,
      name: "a".repeat(DISPLAY_NAME_MAX_CHARS),
    })
  })

  it("leaves angle brackets alone", () => {
    // Escaping belongs at the sink, not the store: `esc` handles the HTML page
    // and `safeText` handles the Slack payload. Mangling them here would put a
    // different name in the database from the one the player chose, and would
    // double-escape at whichever sink already does its job.
    expect(normalizeDisplayName("<Ada>")).toEqual({ ok: true, name: "<Ada>" })
  })

  it("keeps the cap under the recap's, so a name is never ellipsised", () => {
    // RECAP_NAME_MAX_CHARS is 40 and safeText truncates at it. A stored name
    // longer than that would render as "Aaaa…" in every recap.
    expect(DISPLAY_NAME_MAX_CHARS).toBeLessThan(40)
  })
})

describe("coerceDisplayName", () => {
  it("passes an ordinary name through", () => {
    expect(coerceDisplayName("Ada Lovelace", "player")).toBe("Ada Lovelace")
  })

  it("truncates rather than refusing, because nobody typed this one", () => {
    // The Slack profile of somebody joining. Refusing would mean refusing the
    // join, and the only person who could shorten the name is not the one being
    // told about it.
    const long = "a".repeat(DISPLAY_NAME_MAX_CHARS + 10)
    const out = coerceDisplayName(long, "player")
    expect(out).toBe("a".repeat(DISPLAY_NAME_MAX_CHARS))
    expect(normalizeDisplayName(out)).toEqual({ ok: true, name: out })
  })

  it("never cuts an emoji in half", () => {
    // Slicing by index would land inside a surrogate pair and store a lone
    // surrogate, which no later reader can render.
    const out = coerceDisplayName("🎲".repeat(DISPLAY_NAME_MAX_CHARS + 5), "player")
    expect(Array.from(out).every((ch) => ch === "🎲")).toBe(true)
    expect(out).not.toContain("�")
  })

  it("falls back when there is nothing left after cleaning", () => {
    expect(coerceDisplayName("   ", "ada")).toBe("ada")
    expect(coerceDisplayName("\u0000\u0001", "ada")).toBe("ada")
  })

  it("always returns something normalize would accept", () => {
    // The contract that lets the join path write the result straight to the
    // roster without a second check.
    for (const raw of ["Ada", "a".repeat(200), "  spaced  out  ", "🎲".repeat(99)]) {
      expect(normalizeDisplayName(coerceDisplayName(raw, "player")).ok).toBe(true)
    }
  })
})

describe("the cap", () => {
  it("stays under the recap's, so a name is never ellipsised", () => {
    // RECAP_NAME_MAX_CHARS is 40 and safeText truncates at it. A stored name
    // longer than that would render as "Aaaa…" in every recap.
    expect(DISPLAY_NAME_MAX_CHARS).toBeLessThan(40)
  })
})
