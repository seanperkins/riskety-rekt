import { describe, expect, it } from "vitest"
import { RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction, GameState, TickEvent } from "../engine/index.js"
import { MAX_RECAP_BLOCKS, MAX_SECTION_CHARS } from "./config.js"
import { renderRecap } from "./recap.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ada", color: "#f00" },
  { id: "f2", playerName: "Bex", color: "#0f0" },
]

const ids = RISK_MAP.territories.map((t) => t.id)

function stateWith(log: TickEvent[], day = 3): GameState {
  return { ...createSeason("s1", factions, ids), day, log }
}

/** Every plain_text string anywhere in the payload. */
function texts(blocks: unknown[]): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk)
    if (node === null || typeof node !== "object") return
    const o = node as Record<string, unknown>
    if (o.type === "plain_text" && typeof o.text === "string") out.push(o.text)
    Object.values(o).forEach(walk)
  }
  walk(blocks)
  return out
}

describe("renderRecap", () => {
  const previous = stateWith([], 2)

  it("names the day in the header", () => {
    const { blocks } = renderRecap({ state: stateWith([]), previous, lengthDays: 21 })
    expect(texts(blocks).join(" ")).toContain("Day 3")
  })

  it("uses only plain_text, never mrkdwn", () => {
    // A question containing <!channel> would ping the workspace daily.
    const { blocks } = renderRecap({
      state: stateWith([{ t: "income", faction: "f1", amount: 6 }]),
      previous,
      lengthDays: 21,
    })
    expect(JSON.stringify(blocks)).not.toContain("mrkdwn")
  })

  it("reports a capture with both players named", () => {
    const { blocks } = renderRecap({
      state: stateWith([
        {
          t: "attack",
          from: "alaska",
          to: "kamchatka",
          attacker: "f1",
          committed: 6,
          survivors: 2,
          captured: true,
        },
      ]),
      previous,
      lengthDays: 21,
    })
    const all = texts(blocks).join("\n")
    expect(all).toContain("Ada")
    expect(all).toContain("Kamchatka")
  })

  it("surfaces every rejection", () => {
    // Silent validation is how a validator bug survives a whole season.
    const { blocks } = renderRecap({
      state: stateWith([
        { t: "rejected", faction: "f2", field: "deploys", reason: "exceeds reserve" },
      ]),
      previous,
      lengthDays: 21,
    })
    const all = texts(blocks).join("\n")
    expect(all).toContain("Bex")
    expect(all).toContain("exceeds reserve")
  })

  it("reveals protections", () => {
    const { blocks } = renderRecap({
      state: stateWith([{ t: "protected", territory: "brazil", byCount: 1 }]),
      previous,
      lengthDays: 21,
    })
    expect(texts(blocks).join("\n")).toContain("Brazil")
  })

  it("reports wager settlements", () => {
    const { blocks } = renderRecap({
      state: stateWith([{ t: "wagerSettle", wagerId: "w1", outcome: "yes", payout: 22 }]),
      previous,
      lengthDays: 21,
    })
    expect(texts(blocks).join("\n")).toContain("22")
  })

  it("caps and defangs a player name", () => {
    const hostile: Faction[] = [{ id: "f1", playerName: "<!channel>".repeat(20), color: "#f00" }]
    const state = { ...stateWith([{ t: "income", faction: "f1", amount: 5 }]), factions: hostile }
    const { blocks, text } = renderRecap({ state, previous, lengthDays: 21 })
    expect(JSON.stringify(blocks)).not.toContain("<!channel>")
    expect(text).not.toContain("<!channel>")
  })

  it("declares the winner on the final day", () => {
    const state = stateWith([], 21)
    const { blocks } = renderRecap({ state, previous: stateWith([], 20), lengthDays: 21 })
    expect(texts(blocks).join("\n")).toMatch(/wins|draw/i)
  })

  it("says nothing happened rather than rendering an empty message", () => {
    // Slack rejects a post with zero blocks.
    const { blocks } = renderRecap({ state: stateWith([]), previous, lengthDays: 21 })
    expect(blocks.length).toBeGreaterThan(0)
  })

  it("stays inside Slack's block and section limits on a busy day", () => {
    const busy: TickEvent[] = Array.from({ length: 300 }, (_, i) => ({
      t: "attack" as const,
      from: "alaska",
      to: "kamchatka",
      attacker: i % 2 === 0 ? "f1" : "f2",
      committed: 3,
      survivors: 1,
      captured: false,
    }))
    const { blocks } = renderRecap({ state: stateWith(busy), previous, lengthDays: 21 })
    expect(blocks.length).toBeLessThanOrEqual(MAX_RECAP_BLOCKS)
    for (const t of texts(blocks)) expect(t.length).toBeLessThanOrEqual(MAX_SECTION_CHARS)
  })

  it("says how many lines it dropped rather than truncating silently", () => {
    const busy: TickEvent[] = Array.from({ length: 300 }, () => ({
      t: "rejected" as const,
      faction: "f1",
      field: "deploys",
      reason: "exceeds reserve",
    }))
    const { blocks } = renderRecap({ state: stateWith(busy), previous, lengthDays: 21 })
    expect(texts(blocks).join("\n")).toMatch(/\d+ more/)
  })

  it("marks a correction", () => {
    // A rerun posts a visible correction note rather than a silent second recap.
    const { blocks } = renderRecap({
      state: stateWith([]),
      previous,
      lengthDays: 21,
      correction: true,
    })
    expect(texts(blocks).join("\n")).toMatch(/correction/i)
  })
})
