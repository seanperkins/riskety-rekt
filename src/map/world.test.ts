import { describe, expect, it } from "vitest"
import { REGION_MAX, REGION_MIN } from "../config.js"
import { readFileSync } from "node:fs"
import { COORDS } from "./coords.js"
import { SHAPES } from "./shapes.js"
import { validateMap } from "./validate.js"
import { WORLD } from "./world.js"

/**
 * Sea links whose endpoints are legitimately far apart. Everything else must be
 * a short hop, which is what makes the proximity check below a useful smell test
 * for a mistyped border.
 */
const LONG_LINKS = new Set<string>(
  [
    // The Bering Strait. Kamchatka is ~159°E and Alaska ~150°W, so the raw
    // longitude delta is 308° — the date line, not a mistyped border. Do NOT
    // "fix" this by wrapping the longitude: the equirectangular projection draws
    // the link straight across the map, which is what classic Risk's board does
    // too, and wrapping would put Alaska off the right edge of the world.
    "alaska|kamchatka",
    // Greenland and Nunavut are genuinely far apart in longitude at that
    // latitude, where a degree of longitude is about 40 km.
    "greenland|nunavut",
  ].map((k) => k.split("|").sort().join("|")),
)

/**
 * Sea links, read out of the source so the list cannot drift from the data.
 * A land border must be between shapes that nearly touch; a sea link may not.
 */
const SEA_LINKS = new Set(
  [...readFileSync(new URL("./world.ts", import.meta.url), "utf8").matchAll(
    /\["([a-z_]+)", "([a-z_]+)"\]/g,
  )].map((m) => [m[1]!, m[2]!].sort().join("|")),
)

/** Smallest distance between any two vertices of two territories, in degrees. */
function shapeGap(a: string, b: string): number {
  let best = Infinity
  for (const ra of SHAPES[a] ?? []) {
    for (const pa of ra) {
      for (const rb of SHAPES[b] ?? []) {
        for (const pb of rb) {
          const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1])
          if (d < best) best = d
        }
      }
    }
  }
  return best
}

describe("WORLD", () => {
  it("is structurally valid", () => {
    expect(validateMap(WORLD)).toEqual([])
  })

  it("is in the planned size band", () => {
    // The plan estimated 220-250 territories in 42-50 regions. Writing out the
    // real decomposition landed at 264/49: the estimate was the guess and the
    // decomposition is the measurement, so the band follows the data. These
    // exist to catch drift during later edits, not to defend the original guess.
    expect(WORLD.territories.length).toBeGreaterThanOrEqual(250)
    expect(WORLD.territories.length).toBeLessThanOrEqual(280)
    expect(WORLD.regions.length).toBeGreaterThanOrEqual(45)
    expect(WORLD.regions.length).toBeLessThanOrEqual(55)
  })

  it("has a mean degree close to classic Risk's", () => {
    // RISK_MAP is 3.95. A board much denser than that has no chokepoints and
    // plays as a hairball; much sparser and it is a set of corridors.
    const degree =
      WORLD.territories.reduce((s, t) => s + t.neighbors.length, 0) / WORLD.territories.length
    expect(degree).toBeGreaterThan(3.3)
    expect(degree).toBeLessThan(4.7)
  })

  it("gives every region at least one way in, and the isolated ones a real one", () => {
    // Appearance rate tracks adjacency closely: at one neighbour a region lands
    // on ~10% of boards, at six on ~50%. Korea and Japan and the Guinea Coast
    // were the two worst and were given real crossings -- the Yellow Sea, the
    // Kurils, the South Atlantic narrows -- which moved them to 17.9% and
    // 20.8%. This pins that they keep those doors.
    const owner = new Map(WORLD.territories.map((t) => [t.id, t.region]))
    const degree = new Map<string, Set<string>>()
    for (const r of WORLD.regions) degree.set(r.id, new Set())
    for (const t of WORLD.territories) {
      for (const n of t.neighbors) {
        const other = owner.get(n)
        if (other !== undefined && other !== t.region) degree.get(t.region)!.add(other)
      }
    }
    for (const r of WORLD.regions) {
      expect(degree.get(r.id)!.size, `${r.id} is unreachable`).toBeGreaterThanOrEqual(1)
    }
    expect(degree.get("korea_japan")!.size, "korea_japan").toBeGreaterThanOrEqual(3)
    expect(degree.get("guinea_coast")!.size, "guinea_coast").toBeGreaterThanOrEqual(3)
    expect(degree.get("australia")!.size, "australia").toBeGreaterThanOrEqual(2)
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

  it("puts every LAND border between shapes that are actually close", () => {
    // The geographic audit, and the only one that can be automated. Symmetry
    // and connectivity say nothing about whether a border is real, but two
    // territories that share a land border have polygons that nearly touch --
    // so a large gap is a border somebody invented.
    //
    // It found two: carolinas|texas, with Georgia, Alabama, Mississippi and
    // Louisiana between them, and gulf_states|kuwait, which is across the
    // Persian Gulf and is now a sea link.
    //
    // The threshold is loose because Voronoi-carved territories have
    // approximate internal borders by design, and Natural Earth at 110m
    // renders small countries crudely -- Djibouti and Somalia really do meet.
    const seen = new Set<string>()
    for (const t of WORLD.territories) {
      for (const n of t.neighbors) {
        const key = [t.id, n].sort().join("|")
        if (seen.has(key) || SEA_LINKS.has(key)) continue
        seen.add(key)
        expect(shapeGap(t.id, n), `${key} is a land border but the shapes are far apart`).toBeLessThan(6)
      }
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
