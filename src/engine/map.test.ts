import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"

describe("RISK_MAP", () => {
  it("has 42 territories and 6 continents", () => {
    expect(RISK_MAP.territories).toHaveLength(42)
    expect(RISK_MAP.continents).toHaveLength(6)
  })

  it("has classic continent bonuses summing to 24", () => {
    const total = RISK_MAP.continents.reduce((s, c) => s + c.bonus, 0)
    expect(total).toBe(24)
    const byId = Object.fromEntries(RISK_MAP.continents.map((c) => [c.id, c.bonus]))
    expect(byId).toEqual({ na: 5, sa: 2, eu: 5, af: 3, as: 7, au: 2 })
  })

  it("has classic per-continent territory counts", () => {
    const counts: Record<string, number> = {}
    for (const t of RISK_MAP.territories) counts[t.continent] = (counts[t.continent] ?? 0) + 1
    expect(counts).toEqual({ na: 9, sa: 4, eu: 7, af: 6, as: 12, au: 4 })
  })

  it("has unique territory ids", () => {
    const ids = RISK_MAP.territories.map((t) => t.id)
    expect(new Set(ids).size).toBe(42)
  })

  it("has symmetric adjacency and no self-loops", () => {
    const byId = new Map(RISK_MAP.territories.map((t) => [t.id, t]))
    for (const t of RISK_MAP.territories) {
      expect(t.neighbors).not.toContain(t.id)
      expect(new Set(t.neighbors).size, `${t.id} has duplicate neighbors`).toBe(t.neighbors.length)
      for (const n of t.neighbors) {
        const other = byId.get(n)
        expect(other, `${t.id} -> unknown ${n}`).toBeDefined()
        expect(other!.neighbors, `${n} missing back-edge to ${t.id}`).toContain(t.id)
      }
    }
  })

  it("is fully connected", () => {
    const byId = new Map(RISK_MAP.territories.map((t) => [t.id, t]))
    const seen = new Set<string>(["alaska"])
    const queue = ["alaska"]
    while (queue.length) {
      for (const n of byId.get(queue.pop()!)!.neighbors) {
        if (!seen.has(n)) {
          seen.add(n)
          queue.push(n)
        }
      }
    }
    expect(seen.size).toBe(42)
  })
})
