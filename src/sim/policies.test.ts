import { describe, expect, it } from "vitest"
import { RISK_MAP, createSeason, territoriesOf } from "../engine/index.js"
import { POLICIES } from "./policies.js"
import { makeRng } from "../rng.js"
import type { Faction, GameState, Market } from "../engine/index.js"

const factions: Faction[] = ["f1", "f2", "f3"].map((id) => ({ id, playerName: id, color: "#000" }))
const ids = RISK_MAP.territories.map((t) => t.id)
const slate: Market[] = [
  { id: "m1", question: "q", priceYes: 0.4, priceNo: 0.6, closeTime: "T18:00" },
]

const policy = (name: string) => POLICIES.find((p) => p.name === name)!

function eliminated(self: string): GameState {
  const s = createSeason("s", factions, ids)
  // f1 wiped out; f2 dominant; f3 the underdog with a single territory.
  for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
  s.ownership["brazil"] = "f3"
  s.reserves[self] = 10
  return s
}

describe("policy roster", () => {
  it("includes all eight named policies", () => {
    expect(POLICIES.map((p) => p.name).sort()).toEqual([
      "Arbitrageur",
      "Blitz",
      "Consolidator",
      "Gambler",
      "GymRat",
      "Hunter",
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
})

describe("attacking policies", () => {
  it("Turtle never attacks", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 20
    expect(policy("Turtle").decide(s, "f1", slate, makeRng(1)).attacks).toHaveLength(0)
  })

  it("Blitz, Consolidator, Hunter, Slacker and GymRat all attack when they can win", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 50
    for (const name of ["Blitz", "Consolidator", "Hunter", "Slacker", "GymRat"]) {
      expect(policy(name).decide(s, "f1", slate, makeRng(1)).attacks.length, name).toBeGreaterThan(0)
    }
  })

  it("Hunter prefers a target owned by the leader", () => {
    const s = createSeason("s", factions, ids)
    // f2 is the runaway leader; f3 holds a lone weak territory.
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    s.ownership["alaska"] = "f1"
    s.ownership["alberta"] = "f1"
    s.ownership["kamchatka"] = "f3"
    s.garrisons["alaska"] = 20
    s.garrisons["kamchatka"] = 1
    s.garrisons["northwest_territory"] = 1
    s.reserves["f1"] = 0
    const attack = policy("Hunter").decide(s, "f1", slate, makeRng(1)).attacks[0]
    expect(attack).toBeDefined()
    expect(s.ownership[attack!.to]).toBe("f2")
  })

  it("Consolidator prefers a target in a continent it is closest to completing", () => {
    const s = createSeason("s", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    // f1 holds 3 of Australia's 4 plus a bridgehead in Asia.
    for (const t of ["indonesia", "new_guinea", "western_australia"]) s.ownership[t] = "f1"
    s.ownership["siam"] = "f1"
    for (const t of RISK_MAP.territories) s.garrisons[t.id] = 1
    s.garrisons["western_australia"] = 20
    s.garrisons["siam"] = 20
    s.reserves["f1"] = 0
    const attack = policy("Consolidator").decide(s, "f1", slate, makeRng(1)).attacks[0]
    expect(attack).toBeDefined()
    expect(attack!.to).toBe("eastern_australia") // completes Australia
  })

  it("Slacker and GymRat differ only in IRL actions, so the pair isolates the grant", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 20
    const a = policy("Slacker").decide(s, "f1", slate, makeRng(1))
    const b = policy("GymRat").decide(s, "f1", slate, makeRng(1))
    expect(a.attacks).toEqual(b.attacks)
    expect(a.deploys).toEqual(b.deploys)
    expect(policy("Slacker").irlActionsPerDay).toBe(0)
    expect(policy("GymRat").irlActionsPerDay).toBe(2)
  })
})

describe("Gambler", () => {
  it("plays the map as well as wagering", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 50
    const o = policy("Gambler").decide(s, "f1", slate, makeRng(1))
    expect(o.wagers.length).toBeGreaterThan(0)
    expect(o.deploys.length).toBeGreaterThan(0)
  })

  it("stakes at most half its reserve, leaving the rest for the board", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 50
    const o = policy("Gambler").decide(s, "f1", slate, makeRng(1))
    expect(o.wagers.reduce((sum, w) => sum + w.stake, 0)).toBeLessThanOrEqual(25)
  })
})

describe("kingmaker protection", () => {
  it("an eliminated policy submits a protect pick instead of orders", () => {
    for (const name of ["Turtle", "Blitz", "Consolidator", "Hunter", "Gambler", "Slacker", "GymRat"]) {
      const s = eliminated("f1")
      expect(territoriesOf(s, "f1")).toHaveLength(0)
      const o = policy(name).decide(s, "f1", slate, makeRng(1))
      expect(o.protect, name).not.toBeNull()
      expect(o.attacks, name).toHaveLength(0)
      expect(o.deploys, name).toHaveLength(0)
    }
  })

  it("shields the weakest surviving faction, not the leader", () => {
    const s = eliminated("f1")
    const o = policy("Turtle").decide(s, "f1", slate, makeRng(1))
    expect(s.ownership[o.protect!]).toBe("f3") // f3 is the underdog
  })
})

describe("Arbitrageur", () => {
  it("attempts to stake both sides of one market", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 100
    const wagers = policy("Arbitrageur").decide(s, "f1", slate, makeRng(1)).wagers
    expect(wagers.filter((w) => w.marketId === "m1")).toHaveLength(2)
    expect(new Set(wagers.map((w) => w.side))).toEqual(new Set(["yes", "no"]))
  })

  it("attempts a protect pick while still alive", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 10
    expect(policy("Arbitrageur").decide(s, "f1", slate, makeRng(1)).protect).not.toBeNull()
  })
})
