import { describe, expect, it } from "vitest"
import { RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction, GameState, TickEvent } from "../engine/index.js"
import { MARKETS, replayFor } from "./replay-data.js"
import { REPLAY } from "./replay.js"
import { renderReplay } from "./render.js"

const factions: Faction[] = ["f1", "f2"].map((id) => ({
  id,
  playerName: `Player ${id}`,
  color: "#123456",
}))

function states(log: TickEvent[]): { before: GameState; after: GameState } {
  const before = createSeason(
    "s1",
    factions,
    RISK_MAP.territories.map((t) => t.id),
  )
  return { before, after: { ...before, day: before.day + 1, log } }
}

describe("the replay script", () => {
  it("parses", () => {
    // A stray backtick or dollar-brace in a comment silently ends the template
    // literal. It has shipped twice in this codebase; the client has the same
    // test for the same reason.
    expect(() => new Function("window", "document", "L", REPLAY)).not.toThrow()
  })
})

describe("replayFor", () => {
  it("collects soldiers into the bank rather than staging them", () => {
    // Income, workouts and settled wagers land at one instant and change
    // nothing on the map; three beats in a row would look identical.
    const r = replayFor(
      states([
        { t: "income", faction: "f1", amount: 5 },
        { t: "irl", faction: "f1", actions: 2, bonus: 1 },
        // No faction on the event — a settlement names the WAGER, not its
        // owner, which is why payouts bank under "markets" rather than a
        // player. Getting this wrong is a type error, not a wrong picture.
        { t: "wagerSettle", wagerId: "w1", outcome: "yes", stake: 4, payout: 9 },
      ]),
    )
    expect(r.beats).toHaveLength(0)
    expect(r.bank).toHaveLength(3)
    expect(r.bank.map((b) => b.faction)).toEqual(["f1", "f1", MARKETS])
    expect(r.bank[1]!.text).toBe("+3 workout")
  })

  it("keeps the engine's own numbers in the attack beat", () => {
    const r = replayFor(
      states([
        {
          t: "attack",
          from: "alaska",
          to: "kamchatka",
          attacker: "f1",
          committed: 6,
          survivors: 4,
          captured: true,
          lost: 2,
          defenderLost: 2,
        },
      ]),
    )
    const beat = r.beats[0]!
    expect(beat.kind).toBe("attack")
    if (beat.kind !== "attack") throw new Error("wrong kind")
    expect(beat.committed).toBe(6)
    expect(beat.survivors).toBe(4)
    expect(beat.captured).toBe(true)
    // fee is optional on the event and must not reach the client as undefined.
    expect(beat.fee).toBe(0)
    expect(beat.text).toContain("taken, 4 hold it")
  })

  it("narrates every event kind the engine can log", () => {
    // The switch is exhaustive at the type level; this checks each arm actually
    // produces something rather than silently falling through to a bank row.
    const r = replayFor(
      states([
        { t: "deploy", faction: "f1", territory: "alaska", count: 3 },
        { t: "move", faction: "f1", from: "alaska", to: "alberta", count: 2 },
        { t: "fieldBattle", a: "alaska", b: "kamchatka", aContinues: 3, bContinues: 0, aLost: 1, bLost: 4 },
        { t: "protected", territory: "brazil", byCount: 1 },
        { t: "rejected", faction: "f2", field: "attacks", reason: "protected" },
      ]),
    )
    expect(r.beats.map((b) => b.kind)).toEqual(["deploy", "move", "battle", "protect", "note"])
    for (const b of r.beats) expect(b.text.length).toBeGreaterThan(0)
  })

  it("carries both persisted states, so the closing frame needs no arithmetic", () => {
    const r = replayFor(states([]))
    expect(Object.keys(r.before.ownership).length).toBeGreaterThan(0)
    expect(r.after.ownership).toBeDefined()
    expect(r.after.garrisons).toBeDefined()
  })

  it("shares one board geometry with the player board", () => {
    // staticBoard is the shared source. A replay drawn from different shapes
    // than the board is a picture of a game nobody played.
    const r = replayFor(states([]))
    expect(r.territories.length).toBe(RISK_MAP.territories.length)
    expect(Object.keys(r.shapes).length).toBe(RISK_MAP.territories.length)
  })
})

describe("renderReplay", () => {
  it("ships the payload and the leaflet board", () => {
    const html = renderReplay(replayFor(states([])))
    expect(html).toContain("window.__RRP__")
    expect(html).toContain('id="map"')
    expect(html).toContain('id="btn-skip"')
  })

  it("offers playback controls, not just a transcript", () => {
    const html = renderReplay(replayFor(states([])))
    for (const id of ["btn-play", "btn-step", "spd-1", "spd-2", "spd-4", "steps", "bank"]) {
      expect(html, id).toContain(`id="${id}"`)
    }
  })

  it("carries no viewer — a resolved night is public", () => {
    // No factionId, no reserve, no plan: there is nobody this page is "for",
    // which is what lets it render without a session.
    const html = renderReplay(replayFor(states([])))
    const payload = html.slice(html.indexOf("window.__RRP__"))
    for (const key of ['"factionId"', '"reserve"', '"plan"', '"wagers"']) {
      expect(payload, key).not.toContain(key)
    }
  })
})
