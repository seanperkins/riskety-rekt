import { describe, expect, it } from "vitest"
import type { Market } from "../engine/index.js"
import { renderSlate } from "./announce.js"

const market = (over: Partial<Market> = {}): Market => ({
  id: "KX-1",
  question: "Will it rain in Richmond today?",
  priceYes: 0.42,
  priceNo: 0.6,
  closeTime: "2026-08-09T20:00:00.000Z",
  ...over,
})

describe("renderSlate", () => {
  it("lists each market with both prices", () => {
    const { blocks } = renderSlate(3, [market()])
    const json = JSON.stringify(blocks)
    expect(json).toContain("Will it rain in Richmond today?")
    expect(json).toContain("42")
    expect(json).toContain("60")
  })

  it("uses only plain_text", () => {
    expect(JSON.stringify(renderSlate(3, [market()]).blocks)).not.toContain("mrkdwn")
  })

  it("defangs and caps a hostile question", () => {
    // Kalshi questions are third-party text. A 5,000-character title wrecks the
    // layout even when correctly escaped.
    const hostile = market({ question: `<!channel> ${"x".repeat(5000)}` })
    const json = JSON.stringify(renderSlate(3, [hostile]).blocks)
    expect(json).not.toContain("<!channel>")
    expect(json).not.toContain("x".repeat(300))
  })

  it("says so when the slate is empty", () => {
    // No market slate means the day runs as plain Risk. Post a note, carry on.
    const { blocks } = renderSlate(3, [])
    expect(JSON.stringify(blocks)).toMatch(/plain Risk/i)
    expect(blocks.length).toBeGreaterThan(0)
  })

  it("shows each market's own close time", () => {
    // Wagers lock per-market at that market's close, not at 21:00. Players
    // cannot plan around a window they cannot see.
    const { blocks } = renderSlate(3, [market()])
    expect(JSON.stringify(blocks)).toContain("4:00")
  })
})
