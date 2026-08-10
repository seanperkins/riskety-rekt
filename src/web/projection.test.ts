import { describe, expect, it } from "vitest"
import type { GameMap } from "../engine/index.js"
import { COORDS } from "../map/coords.js"
import { WORLD } from "../map/world.js"
import { edges, focusRegion, project, regionStats } from "./projection.js"

const tiny: GameMap = {
  regions: [{ id: "x", name: "X", bonus: 0 }],
  territories: [
    { id: "a", name: "A", region: "x", neighbors: ["b"] },
    { id: "b", name: "B", region: "x", neighbors: ["a"] },
  ],
}

describe("project", () => {
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
