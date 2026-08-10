import { describe, expect, it } from "vitest"
import { SEASON_LENGTH } from "../config.js"
import { runMany, runSeason } from "./run.js"

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

  it("still accounts for all 42 territories at season end", () => {
    const r = runSeason(four, 3)
    expect(Object.values(r.finalTerritories).reduce((a, b) => a + b, 0)).toBe(42)
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
