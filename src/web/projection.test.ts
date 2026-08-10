import { describe, expect, it } from "vitest"
import type { GameMap } from "../engine/index.js"
import { COORDS } from "../map/coords.js"
import { WORLD } from "../map/world.js"
import { edges, equalEarth, focusRegion, project, regionStats } from "./projection.js"

const tiny: GameMap = {
  regions: [{ id: "x", name: "X", bonus: 0 }],
  territories: [
    { id: "a", name: "A", region: "x", neighbors: ["b"] },
    { id: "b", name: "B", region: "x", neighbors: ["a"] },
  ],
}

describe("equalEarth", () => {
  it("puts the origin at the origin", () => {
    const p = equalEarth(0, 0)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(0)
  })

  it("is symmetric about the equator and the prime meridian", () => {
    expect(equalEarth(40, 0).y).toBeCloseTo(-equalEarth(-40, 0).y)
    expect(equalEarth(0, 60).x).toBeCloseTo(-equalEarth(0, -60).x)
  })

  it("compresses longitude toward the poles, monotonically", () => {
    // Under equirectangular, 20 degrees of longitude is the SAME width at the
    // equator and at 70 north -- which is why Siberia and Canada looked
    // enormous. Measured widths as a fraction of the equatorial width:
    //
    //   lat    Equal Earth   equirectangular   true (cos)
    //    30       0.935           1.000          0.866
    //    45       0.857           1.000          0.707
    //    60       0.753           1.000          0.500
    //    70       0.679           1.000          0.342
    //
    // Equal Earth sits between the two because it is a COMPROMISE: it buys back
    // shape by stretching latitude, which is why it stays equal-area without
    // squashing the high latitudes flat the way a sinusoidal does. Asserting
    // the ordering rather than a magic constant.
    const width = (lat: number) => equalEarth(lat, 20).x - equalEarth(lat, 0).x
    const widths = [0, 30, 45, 60, 70, 80].map(width)
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!, `${i}`).toBeLessThan(widths[i - 1]!)
    }
    // And it is genuinely narrower up there, not a rounding difference.
    expect(width(70) / width(0)).toBeLessThan(0.75)
    // ...but not as narrow as a sinusoidal, which is what keeps shapes usable.
    expect(width(70) / width(0)).toBeGreaterThan(Math.cos((70 * Math.PI) / 180))
  })

  it("preserves area to within a fraction of a percent", () => {
    // The property the whole projection is chosen for, and the one a wrong
    // constant would silently break. Territory COUNT is the win condition, so a
    // projection that inflates the north would make the board misread.
    const cell = (lat: number) => {
      const d = 0.5
      const a = equalEarth(lat - d, -d)
      const b = equalEarth(lat - d, d)
      const c = equalEarth(lat + d, d)
      const e = equalEarth(lat + d, -d)
      // Shoelace over the quadrilateral.
      return (
        Math.abs(
          a.x * b.y - b.x * a.y + (b.x * c.y - c.x * b.y) + (c.x * e.y - e.x * c.y) + (e.x * a.y - a.x * e.y),
        ) / 2
      )
    }
    // A 1x1 degree cell shrinks with cos(lat) on the sphere; the projected area
    // must shrink by the same factor.
    for (const lat of [0, 30, 45, 60, 75]) {
      const ratio = cell(lat) / (cell(0) * Math.cos((lat * Math.PI) / 180))
      expect(ratio, `${lat} degrees`).toBeGreaterThan(0.99)
      expect(ratio, `${lat} degrees`).toBeLessThan(1.01)
    }
  })

  it("survives the poles without NaN", () => {
    for (const lat of [90, -90, 89.9999]) {
      const p = equalEarth(lat, 0)
      expect(Number.isFinite(p.x), `${lat}`).toBe(true)
      expect(Number.isFinite(p.y), `${lat}`).toBe(true)
    }
  })
})

describe("project", () => {
  it("uses one scale for both axes", () => {
    // Scaling independently would stretch the board back to the aspect
    // distortion the projection exists to remove. Two pairs the same distance
    // apart on the sphere must be the same distance apart on screen.
    const coords = {
      a: { lat: 0, lon: -20 },
      b: { lat: 0, lon: 20 },
    }
    const p = project(tiny, coords, 1000, 1000, 50)
    const dx = Math.abs(p.at("b")!.x - p.at("a")!.x)
    const vertical = project(
      tiny,
      { a: { lat: -20, lon: 0 }, b: { lat: 20, lon: 0 } },
      1000,
      1000,
      50,
    )
    const dy = Math.abs(vertical.at("b")!.y - vertical.at("a")!.y)
    // Both spans bind their own axis, so both fill the same box.
    expect(dx).toBeCloseTo(dy, 0)
  })

  it("puts the westernmost and easternmost territories on the padding lines", () => {
    const coords = { a: { lat: 0, lon: -10 }, b: { lat: 0, lon: 10 } }
    const p = project(tiny, coords, 1000, 500, 50)
    expect(p.at("a")?.x).toBeCloseTo(50)
    expect(p.at("b")?.x).toBeCloseTo(950)
  })

  it("flips latitude, because SVG y grows downward and north is up", () => {
    const coords = { a: { lat: 40, lon: 0 }, b: { lat: -40, lon: 0 } }
    const p = project(tiny, coords, 1000, 500, 50)
    expect(p.at("a")!.y).toBeLessThan(p.at("b")!.y)
  })

  it("does not produce NaN when every territory shares a coordinate", () => {
    // A zero span would divide by zero and render an invisible, silent blank
    // rather than an obvious error.
    const coords = { a: { lat: 5, lon: 5 }, b: { lat: 5, lon: 5 } }
    const p = project(tiny, coords, 1000, 500, 50)
    expect(Number.isFinite(p.at("a")!.x)).toBe(true)
    expect(Number.isFinite(p.at("a")!.y)).toBe(true)
  })

  it("returns undefined for a territory with no coordinate", () => {
    expect(project(tiny, {}, 1000, 500, 50).at("nowhere")).toBeUndefined()
  })

  it("keeps every real territory inside the viewBox", () => {
    const p = project(WORLD, COORDS, 1160, 900, 52)
    for (const t of WORLD.territories) {
      const pt = p.at(t.id)!
      expect(pt.x, t.id).toBeGreaterThanOrEqual(52)
      expect(pt.x, t.id).toBeLessThanOrEqual(1108)
      expect(pt.y, t.id).toBeGreaterThanOrEqual(52)
      expect(pt.y, t.id).toBeLessThanOrEqual(848)
    }
  })
})

describe("edges", () => {
  it("returns each border once, not twice", () => {
    expect(edges(tiny)).toEqual([["a", "b"]])
  })

  it("counts the real world's borders as half its total degree", () => {
    const degree = WORLD.territories.reduce((s, t) => s + t.neighbors.length, 0)
    expect(edges(WORLD).length).toBe(degree / 2)
  })
})

describe("regionStats", () => {
  it("counts entry points as territories with a border leaving the region", () => {
    const stats = regionStats(WORLD)
    const cape = stats.find((c) => c.id === "cape")!
    expect(cape.size).toBe(8)
    expect(cape.entries).toBeGreaterThan(0)
    expect(cape.entries).toBeLessThanOrEqual(cape.size)
  })

  it("reports zero entries for a region that is the whole map", () => {
    expect(regionStats(tiny)[0]).toEqual({
      id: "x",
      name: "X",
      size: 2,
      entries: 0,
      bonus: 0,
    })
  })
})

describe("focusRegion", () => {
  it("includes the region and everything bordering it", () => {
    const f = focusRegion(WORLD, "balkans")!
    const ids = new Set(f.map.territories.map((t) => t.id))
    // Its own eight.
    for (const id of ["serbia", "croatia", "bosnia", "greece"]) expect(ids.has(id), id).toBe(true)
    // And the neighbours, which is the point -- a region's borders LEAVE it, so
    // showing only its members would hide every edge worth checking.
    for (const id of ["austria", "hungary", "romania", "bulgaria", "veneto", "thrace"]) {
      expect(ids.has(id), id).toBe(true)
    }
    // But nothing further out.
    expect(ids.has("morocco")).toBe(false)
  })

  it("marks only the region's own territories as in focus", () => {
    const f = focusRegion(WORLD, "balkans")!
    expect(f.inFocus.has("serbia")).toBe(true)
    expect(f.inFocus.has("hungary")).toBe(false)
    expect(f.inFocus.size).toBe(WORLD.territories.filter((t) => t.region === "balkans").length)
  })

  it("produces a structurally valid sub-map", () => {
    // Neighbour lists must be filtered to the kept set, or the sub-map fails the
    // same symmetry invariant the world has to pass.
    for (const r of WORLD.regions) {
      expect(validateMapForFocus(focusRegion(WORLD, r.id)!.map), r.id).toBe(true)
    }
  })

  it("does not mutate the world", () => {
    const before = JSON.stringify(WORLD)
    focusRegion(WORLD, "balkans")
    expect(JSON.stringify(WORLD)).toBe(before)
  })

  it("returns undefined for an unknown region", () => {
    // So the caller can 404 rather than render a blank page, which would
    // silently swallow a typo on a tool whose job is catching mistakes.
    expect(focusRegion(WORLD, "atlantis")).toBeUndefined()
  })
})

/** Symmetry and no dangling references, which is what filtering can break. */
function validateMapForFocus(map: GameMap): boolean {
  const ids = new Set(map.territories.map((t) => t.id))
  const byId = new Map(map.territories.map((t) => [t.id, t]))
  for (const t of map.territories) {
    for (const n of t.neighbors) {
      if (!ids.has(n)) return false
      if (!byId.get(n)!.neighbors.includes(t.id)) return false
    }
  }
  return true
}
