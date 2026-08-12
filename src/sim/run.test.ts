import { describe, expect, it } from "vitest"
import { SEASON_LENGTH } from "../config.js"
import { checkDeal } from "../season.js"
import { parseInstant } from "../engine/mechanics.js"
import { runMany, runSeason, seatsFor, simInstant } from "./run.js"

const four = ["Turtle", "Blitz", "GymRat", "Slacker"]

describe("runSeason", () => {
  it("runs a full season and returns a winner from the roster", () => {
    const r = runSeason(four, 1)
    expect(r.days).toBe(SEASON_LENGTH)
    expect(four).toContain(r.winner)
  })

  it("is deterministic for a seed", () => {
    expect(runSeason(four, 42)).toEqual(runSeason(four, 42))
  })

  it("produces different seasons for different seeds", () => {
    expect(runSeason(four, 1)).not.toEqual(runSeason(four, 2))
  })

  it("never leaves a negative reserve", () => {
    const r = runSeason(four, 7)
    expect(Object.values(r.finalReserves).every((v) => v >= 0)).toBe(true)
  })

  it("still accounts for every territory at season end", () => {
    // Conservation. Deliberately NOT a constant: the board is selected, so its
    // size varies with the roster and the seed, and a hardcoded 42 was really
    // asserting "this is RISK_MAP" rather than "nothing was lost".
    const r = runSeason(four, 3)
    expect(Object.values(r.finalTerritories).reduce((a, b) => a + b, 0)).toBe(r.territories)
  })

  it("deals a board sized to the roster", () => {
    for (const seed of [1, 2, 3]) {
      const r = runSeason(four, seed)
      expect(checkDeal(four.length, r.territories), `seed ${seed}`).toBeNull()
    }
  })

  it("rejects an unknown policy name loudly", () => {
    expect(() => runSeason(["Turtle", "NotAPolicy"], 1)).toThrow(/unknown policy/)
  })
})

describe("runMany", () => {
  it("reports win counts summing to the season count", () => {
    const rep = runMany(four, 40)
    expect(Object.values(rep.wins).reduce((a, b) => a + b, 0)).toBe(40)
  })

  it("reports day-3 leader conversion as a rate", () => {
    const rep = runMany(four, 20)
    expect(rep.day3LeaderWinRate).toBeGreaterThanOrEqual(0)
    expect(rep.day3LeaderWinRate).toBeLessThanOrEqual(1)
  })

  it("does not let the Arbitrageur dominate — the key regression signal", () => {
    // If the both-sides hedge, the over-commit, the over-deploy or the
    // live-faction protect ever come back, this policy wins nearly everything.
    const rep = runMany(["Arbitrageur", "Blitz", "Turtle", "GymRat"], 60)
    expect(rep.wins["Arbitrageur"]).toBeDefined()
    expect(rep.wins["Arbitrageur"]! / 60).toBeLessThan(0.6)
  })
})

describe("seats", () => {
  it("keeps a bare name when a policy appears once", () => {
    // So existing rosters and every committed balance figure stay comparable.
    expect(seatsFor(["Turtle", "Blitz"])).toEqual([
      { id: "Turtle", policy: "Turtle" },
      { id: "Blitz", policy: "Blitz" },
    ])
  })

  it("gives a repeated policy distinct seat ids", () => {
    // Faction ids used to be policy names directly, so two Blitz seats shared
    // one faction id and one reserve. Both spent from it and the engine's
    // closing invariant fired with "reserve for Blitz is -2".
    expect(seatsFor(["Blitz", "Turtle", "Blitz"])).toEqual([
      { id: "Blitz#1", policy: "Blitz" },
      { id: "Turtle", policy: "Turtle" },
      { id: "Blitz#2", policy: "Blitz" },
    ])
  })

  it("runs a 15-faction season from 8 policies", () => {
    // The roster size the world map exists to support, and it was unmeasurable
    // before: repeats collided and the season died on the reserve invariant.
    const roster = Array.from({ length: 15 }, (_, i) => four[i % four.length]!)
    const r = runSeason(roster, 1)
    expect(r.seats).toHaveLength(15)
    expect(new Set(r.seats.map((s) => s.id)).size).toBe(15)
    expect(Object.values(r.finalTerritories).reduce((a, b) => a + b, 0)).toBe(r.territories)
  })

  it("aggregates wins by policy and reports the seats behind them", () => {
    // A two-seat policy's baseline is 2/N, not 1/N. Without the seat count you
    // would read its win rate as twice as impressive as it is.
    const rep = runMany(["Blitz", "Blitz", "Turtle", "Hunter"], 20)
    expect(rep.seats).toEqual({ Blitz: 2, Turtle: 1, Hunter: 1 })
    expect(Object.values(rep.wins).reduce((a, b) => a + b, 0)).toBe(20)
  })

  it("completes a season with every module off — plain deterministic Risk", () => {
    const out = runSeason(["Blitz", "Turtle", "Hunter", "Consolidator"], 7, { modules: [] })
    expect(out.days).toBeGreaterThan(0)
    expect(out.winner).toBeDefined()
  })

  it("orders the sim calendar so every close is strictly before its tick", () => {
    // Wrong ordering here silently measures the pre-fix (deploys-senior) game
    // while reporting it as the balance run.
    expect(parseInstant(simInstant(5, 18))).toBeLessThan(parseInstant(simInstant(5, 21)))
  })
})
