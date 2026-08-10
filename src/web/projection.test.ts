import { describe, expect, it } from "vitest"
import type { GameMap } from "../engine/index.js"
import { COORDS } from "../map/coords.js"
import { WORLD } from "../map/world.js"
import { continentStats, edges, project } from "./projection.js"

const tiny: GameMap = {
  continents: [{ id: "x", name: "X", bonus: 0 }],
  territories: [
    { id: "a", name: "A", continent: "x", neighbors: ["b"] },
    { id: "b", name: "B", continent: "x", neighbors: ["a"] },
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

describe("continentStats", () => {
  it("counts entry points as territories with a border leaving the continent", () => {
    const stats = continentStats(WORLD)
    const cape = stats.find((c) => c.id === "cape")!
    expect(cape.size).toBe(8)
    expect(cape.entries).toBeGreaterThan(0)
    expect(cape.entries).toBeLessThanOrEqual(cape.size)
  })

  it("reports zero entries for a continent that is the whole map", () => {
    expect(continentStats(tiny)[0]).toEqual({
      id: "x",
      name: "X",
      size: 2,
      entries: 0,
      bonus: 0,
    })
  })
})
