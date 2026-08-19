import { describe, expect, it } from "vitest"
import type { Market } from "../engine/index.js"
import { MARKET_QUESTION_MAX } from "../config.js"
import { renderSlate } from "./announce.js"
import type { Block } from "./recap.js"

const market = (over: Partial<Market> = {}): Market => ({
  id: "KX-1",
  question: "Will it rain in Richmond today?",
  priceYes: 0.42,
  priceNo: 0.6,
  closeTime: "2026-08-09T20:00:00.000Z",
  ...over,
})

function sectionText(blocks: Block[]): string {
  const section = blocks.find((block) => block.type === "section")
  if (section?.type !== "section" || section.text.type !== "mrkdwn") throw new Error("table section missing")
  return section.text.text
}

function fencedLines(text: string): string[] {
  return text.split("```")[1]!.trim().split("\n")
}

describe("renderSlate", () => {
  it("lists each market with both prices", () => {
    const { blocks } = renderSlate(3, [market()])
    const json = JSON.stringify(blocks)
    expect(json).toContain("Will it rain in Richmond today?")
    expect(json).toContain("42¢")
    expect(json).toContain("60¢")
  })

  it("keeps hostile market payloads safe in blocks and fallback text", () => {
    const hostile = market({ question: `<!channel> https://kalshi.com/market-x ${"x".repeat(5000)}` })
    const { blocks, text } = renderSlate(3, [hostile])
    const json = JSON.stringify(blocks)
    expect(json).not.toContain("<")
    expect(json).not.toContain(">")
    expect(json).not.toContain("<!channel>")
    expect(sectionText(blocks).match(/```/g)).toHaveLength(2)
    expect(text).not.toContain("<")
    expect(text).not.toContain(">")
    expect(text).not.toContain("<!channel>")
    expect(text).not.toContain("://")
  })

  it("keeps hostile triple backticks inside one fenced table", () => {
    const { blocks, text } = renderSlate(3, [market({ question: "before ``` after" })])
    expect(sectionText(blocks).match(/```/g)).toHaveLength(2)
    expect(text).not.toContain("```")
    expect(text).toContain("before ` after")
  })

  it("caps hostile questions to the daily table width", () => {
    const hostile = market({ question: `<!channel> ${"x".repeat(5000)}` })
    const questionCell = fencedLines(sectionText(renderSlate(3, [hostile]).blocks))[1]!.split("  ")[0]!
    expect(questionCell).toContain("…")
    expect(questionCell.length).toBeLessThanOrEqual(MARKET_QUESTION_MAX)
  })

  it("aligns Unicode-width questions by display width, not UTF-16 length", () => {
    const wideQuestion = "🗣️".repeat(4)
    const { blocks } = renderSlate(3, [
      market({ id: "KX-wide", question: wideQuestion, priceYes: 0.22, priceNo: 0.78 }),
      market({ id: "KX-short", question: "A", priceYes: 0.11, priceNo: 0.89 }),
    ])
    const rows = fencedLines(sectionText(blocks)).slice(1)
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    const displayWidth = (value: string): number =>
      [...segmenter.segment(value)].reduce(
        (width, part) =>
          width + ([...part.segment].some((char) => char === "🗣" || char === "️") ? 2 : 1),
        0,
      )
    const rawYesStarts = rows.map((row) => row.indexOf("¢") - 2)
    const yesStarts = rows.map((row) => displayWidth(row.slice(0, row.indexOf("¢") - 2)))
    // Each 🗣️ grapheme is width 2, so the question is width 8 and YES starts at 8 + 2 = 10.
    // Its UTF-16 length is 12, which would incorrectly put the raw index at 12 + 2 = 14.
    expect(rawYesStarts).toEqual([14, 10])
    expect(yesStarts).toEqual([10, 10])
  })


  it("aligns price and lock columns across differently sized markets", () => {
    const { blocks } = renderSlate(3, [
      market({
        id: "KX-short",
        question: "A",
        priceYes: 0.22,
        priceNo: 0.78,
        closeTime: "2026-08-09T21:00:00.000Z",
      }),
      market({
        id: "KX-long",
        question: "Long market question",
        priceYes: 0.11,
        priceNo: 0.89,
        closeTime: "2026-08-09T20:00:00.000Z",
      }),
    ])
    const rows = fencedLines(sectionText(blocks)).slice(1)
    const yesStarts = rows.map((row) => row.indexOf("¢") - 2)
    const noStarts = rows.map((row) => row.indexOf("¢", row.indexOf("¢") + 1) - 2)
    const lockStarts = rows.map((row) => row.indexOf(":", noStarts[0]!) - 1)
    expect(yesStarts).toEqual([22, 22])
    expect(noStarts).toEqual([27, 27])
    expect(lockStarts).toEqual([32, 32])
    expect(rows[1]).toContain("Long market question  11¢  89¢  4:00 PM")
    expect(rows[0]).toContain("A                     22¢  78¢  5:00 PM")
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
