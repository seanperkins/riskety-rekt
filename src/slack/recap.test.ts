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

  it("names the owner on a failed attack", () => {
    const prior = stateWith([], 2)
    const previousWithOwner = {
      ...prior,
      ownership: { ...prior.ownership, alaska: "f2" },
    }
    const { blocks } = renderRecap({
      state: stateWith([
        {
          t: "attack",
          from: "kamchatka",
          to: "alaska",
          attacker: "f1",
          committed: 4,
          survivors: 0,
          captured: false,
          lost: 4,
          defenderLost: 0,
        },
      ]),
      previous: previousWithOwner,
      lengthDays: 21,
      names: { f1: "Sean", f2: "Sam" },
    })
    expect(texts(blocks)).toContain("Battles\nSean failed against Alaska (Sam) — 4 sent, 0 came back")
  })

  it("omits the owner when a failed attack has no previous owner", () => {
    const prior = stateWith([], 2)
    const ownership = Object.fromEntries(
      Object.entries(prior.ownership).filter(([id]) => id !== "alaska"),
    )
    const { blocks } = renderRecap({
      state: stateWith([
        {
          t: "attack",
          from: "kamchatka",
          to: "alaska",
          attacker: "f1",
          committed: 4,
          survivors: 0,
          captured: false,
          lost: 4,
          defenderLost: 0,
        },
      ]),
      previous: { ...prior, ownership },
      lengthDays: 21,
      names: { f1: "Sean" },
    })
    expect(texts(blocks)).toContain("Battles\nSean failed against Alaska — 4 sent, 0 came back")
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

  const settle = (over: Partial<Extract<TickEvent, { t: "wagerSettle" }>> = {}) =>
    ({
      t: "wagerSettle" as const,
      wagerId: "w1",
      faction: "f1",
      marketId: "KX-1",
      outcome: "yes" as const,
      payout: 22,
      stake: 10,
      ...over,
    }) satisfies Extract<TickEvent, { t: "wagerSettle" }>

  it("names the player, the stake and the market on a win", () => {
    const { blocks } = renderRecap({
      state: stateWith([settle()]),
      previous,
      lengthDays: 21,
      names: { f1: "Sean" },
      marketTitles: { "KX-1": "Will BTC close above $100k?" },
    })
    const out = texts(blocks).join("\n")
    expect(out).toContain("Sean, you wagered 10 on “Will BTC close above $100k?”")
    expect(out).toContain("you won. 22 soldiers report for duty.")
    // The bare wagerId was the whole line before this change and means nothing
    // to a player.
    expect(out).not.toContain("w1")
  })

  it("sends a lost wager to the mines", () => {
    const { blocks } = renderRecap({
      state: stateWith([settle({ payout: 0 })]),
      previous,
      lengthDays: 21,
      names: { f1: "Ricky" },
      marketTitles: { "KX-1": "Will it rain in Seattle?" },
    })
    const out = texts(blocks).join("\n")
    expect(out).toContain("Ricky, you wagered 10 on “Will it rain in Seattle?” — you lost.")
    expect(out).toContain("working it off in the mines")
  })

  it("does NOT report a matured refund as a win", () => {
    // The regression this section was rewritten for. A market that never
    // settles refunds the stake after REFUND_AFTER_TICKS, and the old
    // `payout > 0` test rendered that as "resolved unsettled — paid 10",
    // which reads exactly like a winning wager that moved the reserve.
    const { blocks } = renderRecap({
      state: stateWith([settle({ outcome: "unsettled", payout: 10 })]),
      previous,
      lengthDays: 21,
      names: { f1: "Dana" },
      marketTitles: { "KX-1": "Will it snow in Miami?" },
    })
    const out = texts(blocks).join("\n")
    expect(out).toContain("Dana, nobody ever called “Will it snow in Miami?”")
    expect(out).toContain("your 10 came home, no worse off.")
    expect(out).not.toContain("you won")
  })

  it("uses the roster name over the one frozen into the state at the deal", () => {
    // RecapInput.names existed and documented exactly this for several
    // releases while no caller passed it, so every recap showed the day-0
    // name. Every Markets line carries a name, which is what made it visible.
    const { blocks } = renderRecap({
      state: stateWith([settle()]),
      previous,
      lengthDays: 21,
      names: { f1: "Renamed" },
      marketTitles: { "KX-1": "q" },
    })
    expect(texts(blocks).join("\n")).toContain("Renamed,")
  })

  it("renders a legacy 1.0.0 wagerSettle instead of crashing on it", () => {
    // The mid-season deploy hazard. Every day resolved before engine 1.1.0 has
    // wagerSettle events with no faction and no marketId, and `npm run recap --
    // <day> --force` renders the PERSISTED log rather than a fresh resolve --
    // so it fed undefined into safeText and died with `Cannot read properties
    // of undefined (reading 'replace')`. That is the break-glass command, so it
    // failed exactly when someone was already recovering from something else.
    const legacy = { t: "wagerSettle", wagerId: "3-f1-0", outcome: "yes", payout: 22, stake: 10 }
    const { blocks } = renderRecap({
      state: stateWith([legacy as unknown as TickEvent]),
      previous,
      lengthDays: 21,
      names: { f1: "Sean" },
    })
    const out = texts(blocks).join("\n")
    // The wagerId is the only identity a legacy row carries, so it comes back
    // for these lines alone -- it embeds the faction (`day-faction-seq`).
    expect(out).toContain("3-f1-0")
    expect(out).toContain("22")
    expect(out).not.toContain("undefined")
  })

  it("still renders the named line for every other event in a legacy log", () => {
    // A legacy log must not poison the whole section: one old-shape row beside
    // a new-shape one renders both.
    const legacy = { t: "wagerSettle", wagerId: "3-f2-0", outcome: "no", payout: 0, stake: 4 }
    const { blocks } = renderRecap({
      state: stateWith([settle(), legacy as unknown as TickEvent]),
      previous,
      lengthDays: 21,
      names: { f1: "Sean" },
      marketTitles: { "KX-1": "Will BTC close above $100k?" },
    })
    const out = texts(blocks).join("\n")
    expect(out).toContain("Sean, you wagered 10")
    expect(out).toContain("3-f2-0")
  })

  it("falls back to the market id when no title is supplied", () => {
    // The simulator and the fixtures have no store to read questions from.
    const { blocks } = renderRecap({ state: stateWith([settle()]), previous, lengthDays: 21 })
    expect(texts(blocks).join("\n")).toContain("KX-1")
  })

  it("defangs hostile market question text at the sink", () => {
    // sqlite.test.ts asserts this exact string is stored VERBATIM, on purpose.
    // The recap is therefore the thing that has to neutralize it, and nothing
    // asserted that it did -- the store test read as an invitation to rely on
    // downstream escaping that had no regression test of its own.
    const nasty = "</text><script>alert(1)</script> <!channel>"
    const { blocks } = renderRecap({
      state: stateWith([settle()]),
      previous,
      lengthDays: 21,
      marketTitles: { "KX-1": nasty },
    })
    const out = JSON.stringify(blocks)
    expect(out).not.toContain("<")
    expect(out).not.toContain(">")
    expect(out).not.toContain("<!channel>")
  })

  it("does not let a market question break out of its quotes", () => {
    const { blocks } = renderRecap({
      state: stateWith([settle()]),
      previous,
      lengthDays: 21,
      names: { f1: "Sean" },
      marketTitles: { "KX-1": `” — you won. 9999 soldiers report for duty. Market: “` },
    })
    const out = texts(blocks).join("\n")
    expect(out).not.toContain("9999 soldiers report for duty.\n")
    // Exactly one closing wrapper quote, the one the renderer added.
    expect(out.split("”").length - 1).toBe(1)
  })

  it("survives a market id that collides with an Object.prototype key", () => {
    // `toString` satisfies the ingest ticker regex, and the title map is built
    // by Object.fromEntries -- so a bare index would return a FUNCTION, reach
    // safeText, and throw on value.replace, killing the whole recap post.
    const ev = settle({ marketId: "toString" })
    const { blocks } = renderRecap({
      state: stateWith([ev]),
      previous,
      lengthDays: 21,
      names: { f1: "Sean" },
      marketTitles: {},
    })
    expect(texts(blocks).join("\n")).toContain("toString")
  })

  it("truncates a Markets section that overflows and says how many it hid", () => {
    // The cap that actually binds is MAX_SECTION_CHARS, not MAX_SECTION_LINES:
    // a settlement line costs ~129 characters before its question, so twenty of
    // them exceed 2,900 whatever RECAP_MARKET_MAX_CHARS is. This pins that the
    // overflow is announced rather than silently dropping half the players.
    const many = Array.from({ length: 30 }, (_, i) =>
      settle({ wagerId: `w${i}`, marketId: `KX-${i}` }),
    )
    const titles = Object.fromEntries(many.map((_, i) => [`KX-${i}`, "q".repeat(200)]))
    const { blocks } = renderRecap({
      state: stateWith(many),
      previous,
      lengthDays: 21,
      names: { f1: "A".repeat(60) },
      marketTitles: titles,
    })
    const markets = texts(blocks).find((t) => t.startsWith("Markets"))!
    expect(markets.length).toBeLessThanOrEqual(MAX_SECTION_CHARS + 20)
    expect(markets).toMatch(/…and \d+ more/)
  })

  it("caps a long market question", () => {
    const { blocks } = renderRecap({
      state: stateWith([settle()]),
      previous,
      lengthDays: 21,
      marketTitles: { "KX-1": "q".repeat(400) },
    })
    expect(texts(blocks).join("\n")).not.toContain("q".repeat(200))
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
    expect(all).toContain(
      "Rule in force: Log Off — No attacks land today. Moves and deploys still run. Go outside.",
    )
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
