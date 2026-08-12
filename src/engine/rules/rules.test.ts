import { describe, expect, it } from "vitest"
import { RISK_MAP, createSeason } from "../index.js"
import { territoryIncome } from "../income.js"
import { RULE_CATALOGUE, RULE_REGISTRY, buildCatalogue, eligibleRules } from "./index.js"
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

  it("eligibleRules filters by needs against the enabled modules", () => {
    // Season-one rules have no needs, so the filter needs a synthetic rule to
    // be falsifiable — same reasoning as the synthetic tie-break mechanic.
    const needy: Rule = { id: "zz-needy", name: "N", description: "d", needs: ["markets"] }
    const cat = buildCatalogue([...RULE_CATALOGUE, needy], new Set(["markets", "irl", "veto"]))
    expect(cat.has("zz-needy")).toBe(true)
    expect(eligibleRules(["irl"], cat).map((r) => r.id)).not.toContain("zz-needy")
    expect(eligibleRules(["markets"], cat).map((r) => r.id)).toContain("zz-needy")
    expect(eligibleRules([], cat).map((r) => r.id)).toEqual(["attrition", "boom", "truce"])
  })
})
