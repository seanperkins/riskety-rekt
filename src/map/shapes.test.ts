import { describe, expect, it } from "vitest"
import { COORDS } from "./coords.js"
import { SHAPES } from "./shapes.js"
import { WORLD } from "./world.js"

/** Mean position of a ring, with longitude wrap handled via unit vectors. */
function centre(ring: [number, number][]): { lon: number; lat: number } {
  let lat = 0
  let x = 0
  let y = 0
  for (const [lon, la] of ring) {
    lat += la
    x += Math.cos((lon * Math.PI) / 180)
    y += Math.sin((lon * Math.PI) / 180)
  }
  return { lat: lat / ring.length, lon: (Math.atan2(y, x) * 180) / Math.PI }
}

const offset = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): number => {
  const dLon = Math.min(Math.abs(a.lon - b.lon), 360 - Math.abs(a.lon - b.lon))
  return Math.hypot(dLon, a.lat - b.lat)
}

describe("SHAPES", () => {
  it("has at least one ring for every territory", () => {
    // A territory with no shape renders as nothing, silently -- which is how
    // the closed-ring RDP bug hid: 157 of 264 collapsed to two points and
    // vanished, and only a count caught it.
    for (const t of WORLD.territories) {
      expect(SHAPES[t.id], t.id).toBeDefined()
      expect(SHAPES[t.id]!.length, t.id).toBeGreaterThan(0)
    }
  })

  it("has no shapes for territories that do not exist", () => {
    const ids = new Set(WORLD.territories.map((t) => t.id))
    for (const id of Object.keys(SHAPES)) expect(ids.has(id), `orphan ${id}`).toBe(true)
  })

  it("gives every ring at least three points", () => {
    for (const [id, rings] of Object.entries(SHAPES)) {
      for (const r of rings) expect(r.length, id).toBeGreaterThanOrEqual(3)
    }
  })

  it("keeps every coordinate on Earth", () => {
    for (const [id, rings] of Object.entries(SHAPES)) {
      for (const r of rings) {
        for (const [lon, lat] of r) {
          expect(Number.isFinite(lon) && Number.isFinite(lat), id).toBe(true)
          expect(Math.abs(lat), id).toBeLessThanOrEqual(90)
          expect(Math.abs(lon), id).toBeLessThanOrEqual(180)
        }
      }
    }
  })

  it("puts every ring near its own territory", () => {
    // Natural Earth files overseas territories under the metropole, so Aquitaine
    // collected French Guiana and California collected Hawaii until the build
    // filtered by distance. Svalbard keeps Norway at ~15 degrees, which is
    // correct -- it really is Norwegian.
    for (const t of WORLD.territories) {
      const home = COORDS[t.id]!
      for (const r of SHAPES[t.id]!) {
        expect(offset(centre(r), home), `${t.id} ring`).toBeLessThanOrEqual(35)
      }
    }
  })

  it("stays small enough to serve", () => {
    // The whole world goes to the browser on first load.
    const points = Object.values(SHAPES).reduce((n, rs) => n + rs.reduce((m, r) => m + r.length, 0), 0)
    expect(points).toBeGreaterThan(6000)
    expect(points).toBeLessThan(20_000)
  })
})
