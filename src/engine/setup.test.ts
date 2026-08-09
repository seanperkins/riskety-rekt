import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { continentBonusesFor, createSeason, territoriesOf } from "./setup.js"
import type { Faction } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
  { id: "f3", playerName: "Cy", color: "#11e" },
]
const ids = RISK_MAP.territories.map((t) => t.id)

describe("createSeason", () => {
  it("deals every territory exactly once, evenly to within one", () => {
    const s = createSeason("s1", factions, ids)
    expect(Object.keys(s.ownership)).toHaveLength(42)
    const counts = factions.map((f) => territoriesOf(s, f.id).length)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(42)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  it("deals evenly for 4, 5 and 6 factions", () => {
    for (const n of [4, 5, 6]) {
      const fs = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, playerName: `p${i}`, color: "#000" }))
      const s = createSeason("s1", fs, ids)
      const counts = fs.map((f) => territoriesOf(s, f.id).length)
      expect(counts.reduce((a, b) => a + b, 0)).toBe(42)
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
    }
  })

  it("starts every territory at 2 troops and every reserve at 0", () => {
    const s = createSeason("s1", factions, ids)
    expect(Object.values(s.garrisons).every((g) => g === 2)).toBe(true)
    expect(Object.values(s.reserves).every((r) => r === 0)).toBe(true)
  })

  it("starts at day 0 with empty pending and log", () => {
    const s = createSeason("s1", factions, ids)
    expect(s.day).toBe(0)
    expect(s.pending).toEqual([])
    expect(s.log).toEqual([])
    expect(s.engineVersion).toBe("1.0.0")
  })

  it("is deterministic for a given shuffle", () => {
    expect(createSeason("s1", factions, ids)).toEqual(createSeason("s1", factions, ids))
  })
})

describe("territoriesOf", () => {
  it("returns ids in sorted order for determinism", () => {
    const s = createSeason("s1", factions, ids)
    const owned = territoriesOf(s, "f1")
    expect([...owned].sort()).toEqual(owned)
  })
})

describe("continentBonusesFor", () => {
  it("pays exactly 2 for holding all of Australia", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    for (const t of RISK_MAP.territories.filter((x) => x.continent === "au")) s.ownership[t.id] = "f1"
    expect(continentBonusesFor(s, "f1")).toBe(2)
  })

  it("pays 0 once a single territory of that continent is lost", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    const au = RISK_MAP.territories.filter((x) => x.continent === "au")
    for (const t of au) s.ownership[t.id] = "f1"
    expect(continentBonusesFor(s, "f1")).toBe(2)
    s.ownership[au[0]!.id] = "f2"
    expect(continentBonusesFor(s, "f1")).toBe(0)
  })

  it("sums bonuses across multiple held continents", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    for (const t of RISK_MAP.territories.filter((x) => x.continent === "au" || x.continent === "sa")) {
      s.ownership[t.id] = "f1"
    }
    expect(continentBonusesFor(s, "f1")).toBe(4)
  })

  it("pays 24 to a faction holding the whole board", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f1"
    expect(continentBonusesFor(s, "f1")).toBe(24)
  })
})
