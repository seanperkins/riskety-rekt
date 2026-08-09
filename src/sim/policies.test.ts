import { describe, expect, it } from "vitest"
import { RISK_MAP, createSeason } from "../engine/index.js"
import { POLICIES, makeRng } from "./policies.js"
import type { Faction, Market } from "../engine/index.js"

const factions: Faction[] = ["f1", "f2"].map((id) => ({ id, playerName: id, color: "#000" }))
const ids = RISK_MAP.territories.map((t) => t.id)
const slate: Market[] = [
  { id: "m1", question: "q", priceYes: 0.4, priceNo: 0.6, closeTime: "T18:00" },
]

describe("policies", () => {
  it("includes all six named policies", () => {
    expect(POLICIES.map((p) => p.name).sort()).toEqual([
      "Arbitrageur",
      "Blitz",
      "Gambler",
      "GymRat",
      "Slacker",
      "Turtle",
    ])
  })

  it("every policy returns a well-formed order", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 20
    for (const p of POLICIES) {
      const o = p.decide(s, "f1", slate, makeRng(1))
      expect(o.factionId).toBe("f1")
      expect(Array.isArray(o.deploys)).toBe(true)
      expect(Array.isArray(o.attacks)).toBe(true)
      expect(Array.isArray(o.wagers)).toBe(true)
    }
  })

  it("every policy is deterministic for a seed", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 20
    for (const p of POLICIES) {
      expect(p.decide(s, "f1", slate, makeRng(9))).toEqual(p.decide(s, "f1", slate, makeRng(9)))
    }
  })

  it("Turtle never attacks", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 20
    const turtle = POLICIES.find((p) => p.name === "Turtle")!
    expect(turtle.decide(s, "f1", slate, makeRng(1)).attacks).toHaveLength(0)
  })

  it("Blitz attacks when it can win", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 50
    const blitz = POLICIES.find((p) => p.name === "Blitz")!
    expect(blitz.decide(s, "f1", slate, makeRng(1)).attacks.length).toBeGreaterThan(0)
  })

  it("Slacker posts no IRL actions and GymRat posts the maximum", () => {
    expect(POLICIES.find((p) => p.name === "Slacker")!.irlActionsPerDay).toBe(0)
    expect(POLICIES.find((p) => p.name === "GymRat")!.irlActionsPerDay).toBe(2)
  })

  it("Arbitrageur attempts to stake both sides of one market", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 100
    const arb = POLICIES.find((p) => p.name === "Arbitrageur")!
    const wagers = arb.decide(s, "f1", slate, makeRng(1)).wagers
    expect(wagers.filter((w) => w.marketId === "m1")).toHaveLength(2)
    expect(new Set(wagers.map((w) => w.side))).toEqual(new Set(["yes", "no"]))
  })

  it("Arbitrageur attempts a protect pick while still alive", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 10
    const arb = POLICIES.find((p) => p.name === "Arbitrageur")!
    expect(arb.decide(s, "f1", slate, makeRng(1)).protect).not.toBeNull()
  })

  it("makeRng is deterministic for a seed and differs across seeds", () => {
    const a = makeRng(7)
    const b = makeRng(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
    expect(makeRng(7)()).not.toEqual(makeRng(8)())
  })
})
