import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { validateMap } from "../map/validate.js"

describe("RISK_MAP", () => {
  it("has 42 territories and 6 continents", () => {
    expect(RISK_MAP.territories).toHaveLength(42)
    expect(RISK_MAP.regions).toHaveLength(6)
  })

  it("has classic continent bonuses summing to 24", () => {
    const total = RISK_MAP.regions.reduce((s, c) => s + c.bonus, 0)
    expect(total).toBe(24)
    const byId = Object.fromEntries(RISK_MAP.regions.map((c) => [c.id, c.bonus]))
    expect(byId).toEqual({ na: 5, sa: 2, eu: 5, af: 3, as: 7, au: 2 })
  })

  it("has classic per-continent territory counts", () => {
    const counts: Record<string, number> = {}
    for (const t of RISK_MAP.territories) counts[t.region] = (counts[t.region] ?? 0) + 1
    expect(counts).toEqual({ na: 9, sa: 4, eu: 7, af: 6, as: 12, au: 4 })
  })

  it("passes the shared structural invariants apart from Asia's size", () => {
    // The invariants now live in src/map/validate.ts because every generated
    // sub-map needs them too. Asia is 12 territories, outside the 4-9 band the
    // world holds to; RISK_MAP predates that rule and is grandfathered -- it is
    // the golden fixture and is never selected from.
    expect(validateMap(RISK_MAP)).toEqual([{ kind: "region-size", region: "as", size: 12 }])
  })
})
