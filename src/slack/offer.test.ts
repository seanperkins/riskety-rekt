import { describe, expect, it } from "vitest"
import { renderRuleOffer } from "./offer.js"

const offers = [
  { ordinal: 1, name: "Boom", description: "Territory income is doubled today." },
  { ordinal: 2, name: "Truce", description: "No attacks land today." },
  { ordinal: 3, name: "Attrition", description: "Attacks cost one extra troop today." },
]

describe("renderRuleOffer", () => {
  it("numbers each candidate with its numeral emoji, name and description", () => {
    const { text, blocks } = renderRuleOffer(5, offers)
    expect(text).toContain("Day 5")
    const json = JSON.stringify(blocks)
    expect(json).toContain("Day 5 — vote on today's rule")
    for (const needle of [":one:", ":two:", ":three:", "Boom", "Truce", "Attrition"]) {
      expect(json).toContain(needle)
    }
    expect(json).toContain("React with the number to vote")
    expect(json).toContain("latest reaction counts")
  })

  it("marks a superseding re-post as the first context block", () => {
    const { blocks } = renderRuleOffer(5, offers, { supersedes: true })
    expect(blocks[1]).toEqual({
      type: "context",
      elements: [{ type: "plain_text", text: "Replaces the offer above — vote here.", emoji: true }],
    })
    // The default post carries no supersession line.
    expect(JSON.stringify(renderRuleOffer(5, offers).blocks)).not.toContain("Replaces the offer")
  })

  it("caps hostile text and renders only plain_text blocks", () => {
    const hostile = [{ ordinal: 1, name: "*bold*", description: "<script>".repeat(40) }]
    const { blocks } = renderRuleOffer(1, hostile)
    for (const b of blocks) {
      if (b.type === "section" || b.type === "header") expect(b.text.type).toBe("plain_text")
    }
    const section = blocks.find((b) => b.type === "section") as { text: { text: string } }
    // safeText caps the description at 120 — the 360-char payload was cut.
    expect(section.text.text.length).toBeLessThan(200)
  })
})
