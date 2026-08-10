import { describe, expect, it } from "vitest"
import { REGION_MAX, REGION_MIN } from "../config.js"
import { COORDS } from "./coords.js"
import { validateMap } from "./validate.js"
import { WORLD } from "./world.js"

/**
 * Sea links whose endpoints are legitimately far apart. Everything else must be
 * a short hop, which is what makes the proximity check below a useful smell test
 * for a mistyped border.
 */
const LONG_LINKS = new Set<string>([].map((k: string) => k.split("|").sort().join("|")))

describe("WORLD", () => {
  it("is structurally valid", () => {
    expect(validateMap(WORLD)).toEqual([])
  })

  it("keeps every region inside the size band", () => {
    for (const c of WORLD.regions) {
      const size = WORLD.territories.filter((t) => t.region === c.id).length
      expect(size, c.id).toBeGreaterThanOrEqual(REGION_MIN)
      expect(size, c.id).toBeLessThanOrEqual(REGION_MAX)
    }
  })

  it("carries no bonus in the data", () => {
    // Bonuses are computed per sub-map by selectSubMap, because defensibility
    // depends on which neighbours were selected. A non-zero value here would be
    // silently overwritten and would mislead anyone reading world.ts.
    for (const c of WORLD.regions) expect(c.bonus, c.id).toBe(0)
  })

  it("has a coordinate for every territory and no orphans", () => {
    // An orphan means a territory was renamed or removed and its coordinate was
    // left behind -- the viewer would silently draw nothing for the new id.
    const ids = new Set(WORLD.territories.map((t) => t.id))
    for (const t of WORLD.territories) expect(COORDS[t.id], t.id).toBeDefined()
    for (const id of Object.keys(COORDS)) expect(ids.has(id), `orphan ${id}`).toBe(true)
  })

  it("has coordinates on Earth", () => {
    for (const [id, c] of Object.entries(COORDS)) {
      expect(c.lat, id).toBeGreaterThanOrEqual(-90)
      expect(c.lat, id).toBeLessThanOrEqual(90)
      expect(c.lon, id).toBeGreaterThanOrEqual(-180)
      expect(c.lon, id).toBeLessThanOrEqual(180)
    }
  })

  it("places neighbours within 45 degrees of each other", () => {
    // A cheap smell test for a mistyped border. Real land neighbours are close;
    // an accidental "morocco borders kenya" shows up here even though it is
    // symmetric, connected and in-band, which is everything validateMap checks.
    for (const t of WORLD.territories) {
      for (const n of t.neighbors) {
        if (LONG_LINKS.has([t.id, n].sort().join("|"))) continue
        const a = COORDS[t.id]!
        const b = COORDS[n]!
        expect(Math.abs(a.lat - b.lat), `${t.id}-${n} latitude`).toBeLessThan(45)
        expect(Math.abs(a.lon - b.lon), `${t.id}-${n} longitude`).toBeLessThan(45)
      }
    }
  })
})
