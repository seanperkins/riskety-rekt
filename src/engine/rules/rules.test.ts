import { describe, expect, it } from "vitest"
import { RISK_MAP, createSeason } from "../index.js"
import { territoryIncome } from "../income.js"
import {
  RULE_CATALOGUE,
  RULE_DESCRIPTION_MAX_CHARS,
  RULE_REGISTRY,
  buildCatalogue,
  eligibleRules,
} from "./index.js"
import { attritionRule } from "./attrition.js"
import { boomRule } from "./boom.js"
import { truceRule } from "./truce.js"
import type { Rule } from "../mechanics.js"
import type { DailyContext, GameState } from "../types.js"

const ctx = (over: Partial<DailyContext> = {}): DailyContext => ({
  slate: [],
  approvals: [],
  postedToday: [],
  settlements: {},
  tickInstant: "2026-09-01T21:00:00.000Z",
  modules: [],
  rules: [],
  ...over,
})

const dealt = (): GameState =>
  createSeason(
    "s",
    [
      { id: "f1", playerName: "A", color: "#000" },
      { id: "f2", playerName: "B", color: "#000" },
    ],
    RISK_MAP.territories.map((t) => t.id),
    RISK_MAP,
  )

describe("boom", () => {
  it("grants exactly core income again, per faction, logged as a boom grant", () => {
    const s = dealt()
    const grants = boomRule.grant!(s, ctx())
    expect(grants.length).toBeGreaterThan(0)
    for (const g of grants) {
      expect(g.amount).toBe(territoryIncome(s, g.faction))
      expect(g.event).toEqual({ t: "grant", source: "boom", faction: g.faction, amount: g.amount })
    }
  })

  it("skips zero-income (eliminated) factions rather than logging +0", () => {
    const s = dealt()
    const wiped: GameState = {
      ...s,
      ownership: Object.fromEntries(Object.keys(s.ownership).map((t) => [t, "f1"])),
    }
    expect(boomRule.grant!(wiped, ctx()).some((g) => g.faction === "f2")).toBe(false)
  })
})

describe("truce", () => {
  it("locks every territory and supplies no events", () => {
    const s = dealt()
    const locks = truceRule.lock!(s, [], ctx())
    expect(locks.map((l) => l.territory).sort()).toEqual(
      s.map.territories.map((t) => t.id).sort(),
    )
    expect(locks.every((l) => l.event === undefined)).toBe(true)
  })
})

describe("attrition", () => {
  it("returns the flat departure-cost dial", () => {
    expect(attritionRule.combatDials!(dealt(), ctx())).toEqual({ attackDepartureCost: 1 })
  })
})

describe("the catalogue", () => {
  it("ships at least three rules, each with display fields", () => {
    expect(RULE_CATALOGUE.length).toBeGreaterThanOrEqual(3)
    for (const r of RULE_CATALOGUE) {
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.description.length).toBeGreaterThan(0)
      expect(RULE_REGISTRY.get(r.id)).toBe(r)
    }
  })

  it("buildCatalogue refuses a duplicate id, a module-id collision, and an unknown needs", () => {
    const mods = new Set(["markets", "irl", "veto"])
    const r = (id: string, extra: Partial<Rule> = {}): Rule => ({
      id,
      name: id,
      description: "d",
      ...extra,
    })
    expect(() => buildCatalogue([r("x"), r("x")], mods)).toThrow(/duplicate/)
    expect(() => buildCatalogue([r("markets")], mods)).toThrow(/collides/)
    expect(() => buildCatalogue([r("x", { needs: ["ghost"] })], mods)).toThrow(/needs/)
  })

  it("buildCatalogue refuses an over-long description", () => {
    const long: Rule = { id: "x", name: "x", description: "d".repeat(101) }
    expect(() => buildCatalogue([long], new Set())).toThrow(/description/)
  })

  it("eligibleRules filters by needs — with real consumers, not a synthetic rule", () => {
    const all = eligibleRules(["markets", "irl", "veto"]).map((r) => r.id)
    expect(all).toContain("gains")
    expect(all).toContain("diamond-hands")

    // markets off: the wager rule is never OFFERED, rather than offered and inert.
    const noMarkets = eligibleRules(["irl", "veto"]).map((r) => r.id)
    expect(noMarkets).not.toContain("diamond-hands")
    expect(noMarkets).toContain("gains")

    // irl off: likewise for the workout rule.
    const noIrl = eligibleRules(["markets"]).map((r) => r.id)
    expect(noIrl).not.toContain("gains")
    expect(noIrl).toContain("diamond-hands")

    // Plain Risk offers only the rules that need nothing.
    const none = eligibleRules([]).map((r) => r.id)
    expect(none).not.toContain("gains")
    expect(none).not.toContain("diamond-hands")
    expect(none.length).toBe(RULE_CATALOGUE.length - 2)
  })

  it("every entry's display copy fits the ballot", () => {
    // A future witty entry must not silently overflow the offer message or
    // the recap line. buildCatalogue enforces the description bound at import;
    // this pins the name too, against RECAP_NAME_MAX_CHARS.
    for (const r of RULE_CATALOGUE) {
      expect(r.description.length).toBeLessThanOrEqual(RULE_DESCRIPTION_MAX_CHARS)
      expect(r.name.length).toBeLessThanOrEqual(40)
    }
  })

  it("keeps the shipped ids frozen — they live in tick_context history", () => {
    // Display copy may change freely; ids may not. A rename here orphans every
    // frozen context that named the old id.
    const ids = RULE_CATALOGUE.map((r) => r.id)
    for (const frozen of ["boom", "attrition", "truce"]) expect(ids).toContain(frozen)
  })
})
