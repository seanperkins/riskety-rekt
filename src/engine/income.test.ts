import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason } from "./setup.js"
import { territoryIncome } from "./income.js"
import type { Faction } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
]
const ids = RISK_MAP.territories.map((t) => t.id)

/**
 * 36 territory ids that can never complete a continent: one territory of every
 * continent is deliberately excluded, so continent bonuses stay 0 for any n <= 36.
 */
const noBonusPool = (() => {
  const skipped = new Set<string>()
  return RISK_MAP.territories
    .filter((t) => {
      if (!skipped.has(t.continent)) {
        skipped.add(t.continent)
        return false
      }
      return true
    })
    .map((t) => t.id)
})()

function withCount(n: number) {
  const s = createSeason("s1", factions, ids)
  for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
  for (const id of noBonusPool.slice(0, n)) s.ownership[id] = "f1"
  return s
}

describe("territoryIncome", () => {
  it("has a bonus-free pool big enough for these tests", () => {
    expect(noBonusPool).toHaveLength(36)
  })

  it("pays 0 to an eliminated faction (regression: max(5,..) paid the floor forever)", () => {
    expect(territoryIncome(withCount(0), "f1")).toBe(0)
  })

  it("floors at 5", () => {
    expect(territoryIncome(withCount(1), "f1")).toBe(5)
    expect(territoryIncome(withCount(7), "f1")).toBe(5)
    expect(territoryIncome(withCount(10), "f1")).toBe(5)
  })

  it("exceeds the floor at 12 territories", () => {
    expect(territoryIncome(withCount(11), "f1")).toBe(5)
    expect(territoryIncome(withCount(12), "f1")).toBe(6)
    expect(territoryIncome(withCount(20), "f1")).toBe(10)
  })

  it("adds continent bonuses on top", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    for (const t of RISK_MAP.territories.filter((x) => x.continent === "au")) s.ownership[t.id] = "f1"
    // 4 territories -> floor of 5, plus Australia's 2
    expect(territoryIncome(s, "f1")).toBe(7)
  })

  it("pays 45 to a faction holding the whole board", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f1"
    // floor(42/2) = 21, plus all 24 continent bonuses
    expect(territoryIncome(s, "f1")).toBe(45)
  })
})
