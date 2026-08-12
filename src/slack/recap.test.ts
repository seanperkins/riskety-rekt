import { readFileSync } from "node:fs"
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
          lost: 3,
          defenderLost: 1,
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
      state: stateWith([{ t: "wagerSettle", wagerId: "w1", outcome: "yes", payout: 22, stake: 10 }]),
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
      lost: 1,
      defenderLost: 0,
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

describe("recap event coverage", () => {
  // The recap is a per-type filter, not a switch — no assertNever can make a
  // missed variant a build error. Instead: HANDLED ∪ IGNORED must equal
  // TickEvent["t"] at the TYPE level (a new variant fails compilation below),
  // and each HANDLED entry must actually be queried in the source (so the
  // union cannot become a hand-maintained lie).
  const RECAP_HANDLED = [
    "income",
    "irl",
    "grant",
    "protected",
    "move",
    "fieldBattle",
    "attack",
    "wagerSettle",
    "rejected",
  ] as const
  // deploy is DELIBERATELY unrendered: the recap narrates the night's combat
  // and economy; per-territory deploy counts are the board's job.
  const RECAP_IGNORED = ["deploy"] as const

  type Covered = (typeof RECAP_HANDLED)[number] | (typeof RECAP_IGNORED)[number]
  // Both directions: a new TickEvent variant breaks the first, a stale entry
  // in these lists breaks the second.
  const _allCovered: TickEvent["t"] extends Covered ? true : never = true
  const _noExtras: Covered extends TickEvent["t"] ? true : never = true
  void _allCovered
  void _noExtras

  it("queries every HANDLED type in the source, and never the IGNORED ones", () => {
    const src = readFileSync("src/slack/recap.ts", "utf8")
    for (const t of RECAP_HANDLED) {
      expect(src, `recap.ts must query of("${t}")`).toContain(`of("${t}")`)
    }
    for (const t of RECAP_IGNORED) {
      expect(src, `recap.ts deliberately ignores "${t}"`).not.toContain(`of("${t}")`)
    }
  })

  it("renders a module grant with its source", () => {
    const { blocks } = renderRecap({
      state: stateWith([{ t: "grant", source: "boom", faction: "f1", amount: 5 }]),
      previous: stateWith([], 2),
      lengthDays: 21,
    })
    expect(texts(blocks).join("\n")).toContain("(boom)")
  })

  it("announces the day's rule with name AND description", () => {
    // The user-visible record of why a Truce day had no captures — and the
    // description says moves still run, so the copy never promises stillness.
    const { blocks } = renderRecap({
      state: stateWith([]),
      previous: stateWith([], 2),
      lengthDays: 21,
      ruleIds: ["truce"],
    })
    const all = texts(blocks).join("\n")
    expect(all).toContain("Rule in force: Truce — No attacks land today. Moves and deploys still run.")
  })

  it("renders an id the catalogue no longer knows as the bare id, without throwing", () => {
    const { blocks } = renderRecap({
      state: stateWith([]),
      previous: stateWith([], 2),
      lengthDays: 21,
      ruleIds: ["retired-rule"],
    })
    expect(texts(blocks).join("\n")).toContain("Rule in force: retired-rule")
  })

  it("renders no rule block when the day had no winning rule", () => {
    const { blocks } = renderRecap({ state: stateWith([]), previous: stateWith([], 2), lengthDays: 21 })
    expect(texts(blocks).join("\n")).not.toContain("Rule in force")
  })
})
