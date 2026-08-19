import { describe, expect, it } from "vitest"
import { renderRuleOffer } from "./offer.js"
import type { Block } from "./recap.js"

const offers = [
  { ordinal: 1, name: "Boom", description: "Territory income is doubled today." },
  { ordinal: 2, name: "Truce", description: "No attacks land today." },
  { ordinal: 3, name: "Attrition", description: "Attacks cost one extra troop today." },
]

function sectionText(blocks: Block[]): string {
  const section = blocks.find((block) => block.type === "section")
  if (section?.type !== "section" || section.text.type !== "mrkdwn") throw new Error("table section missing")
  return section.text.text
}

function fencedLines(text: string): string[] {
  return text.split("```")[1]!.trim().split("\n")
}

describe("renderRuleOffer", () => {
  it("numbers each candidate with its ordinal, name and description", () => {
    const { text, blocks } = renderRuleOffer(5, offers)
    expect(text).toContain("Candidates")
    const json = JSON.stringify(blocks)
    expect(json).toContain("Day 5 — vote on today's rule")
    for (const needle of ["1", "2", "3", "Boom", "Truce", "Attrition"]) {
      expect(json).toContain(needle)
    }
    expect(json).not.toContain(":one:")
    expect(json).not.toContain(":two:")
    expect(json).not.toContain(":three:")
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

  it("keeps hostile offer payloads safe and uses one fenced table", () => {
    const hostile = [{ ordinal: 1, name: "<!channel>", description: "<script>".repeat(40) }]
    const { blocks } = renderRuleOffer(1, hostile)
    const json = JSON.stringify(blocks)
    expect(json).not.toContain("<")
    expect(json).not.toContain(">")
    expect(json).not.toContain("<!channel>")
    expect(sectionText(blocks).match(/```/g)).toHaveLength(2)
  })

  it("caps hostile descriptions at the table cell limit", () => {
    const hostile = [{ ordinal: 1, name: "*bold*", description: "<script>".repeat(40) }]
    const descriptionCell = fencedLines(sectionText(renderRuleOffer(1, hostile).blocks))[1]!.split("  ")[2]!
    expect(descriptionCell).toContain("…")
    expect(descriptionCell.length).toBeLessThanOrEqual(120)
  })

  it("aligns rule and description columns across differently sized offers", () => {
    const { blocks } = renderRuleOffer(5, [
      { ordinal: 1, name: "A", description: "Brief effect" },
      { ordinal: 2, name: "Long candidate", description: "A much longer explanation" },
    ])
    const rows = fencedLines(sectionText(blocks)).slice(1)
    expect(rows[0]!.slice(3, 17)).toBe("A             ")
    expect(rows[1]!.slice(3, 17)).toBe("Long candidate")
    expect(rows[0]!.slice(19)).toBe("Brief effect")
    expect(rows[1]!.slice(19)).toBe("A much longer explanation")
    expect(rows[0]).toContain("1  A               Brief effect")
    expect(rows[1]).toContain("2  Long candidate  A much longer explanation")
  })
})
