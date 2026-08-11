import { describe, expect, it } from "vitest"
import { COORDS } from "./coords.js"
import { LABELS, LABEL_BOXES, SHAPES } from "./shapes.js"
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

describe("clipping artifacts", () => {
  // Two faults that both drew as a bar across the map, and neither of which
  // MIN_AREA can catch, because both have a large AREA and a degenerate SHAPE.
  it("has no ring stretched into a sliver", () => {
    // Karelia carried a ring 29 degrees wide and 0.5 tall with four points --
    // roughly 14 square degrees, hundreds of times MIN_AREA. It rendered as a
    // maroon bar straight across the board. Elongation plus an absence of
    // detail is the signature of a half-plane cut, not of land.
    const bad: string[] = []
    for (const [id, rings] of Object.entries(SHAPES)) {
      for (const ring of rings) {
        if (ring.length > 6) continue
        const xs = ring.map((p) => p[0])
        const ys = ring.map((p) => p[1])
        const w = Math.max(...xs) - Math.min(...xs)
        const h = Math.max(...ys) - Math.min(...ys)
        const short = Math.min(w, h)
        const aspect = short === 0 ? Infinity : Math.max(w, h) / short
        if (aspect > 8) bad.push(`${id} ${w.toFixed(1)}x${h.toFixed(1)}deg, ${ring.length}pts`)
      }
    }
    expect(bad).toEqual([])
  })

  it("has no ring spanning the antimeridian", () => {
    // Natural Earth stores Fiji as a single ring running -180..+180. Drawn
    // literally that is a polygon wrapping the globe, painted as a bar at
    // Fiji's latitude. Any ring wider than half the world is that bug.
    const bad: string[] = []
    for (const [id, rings] of Object.entries(SHAPES)) {
      for (const ring of rings) {
        const xs = ring.map((p) => p[0])
        const span = Math.max(...xs) - Math.min(...xs)
        if (span > 180) bad.push(`${id} spans ${span.toFixed(0)} degrees of longitude`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe("label points", () => {
  const inRing = (lon: number, lat: number, ring: [number, number][]): boolean => {
    let hit = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }

  it("puts every garrison count inside its own territory", () => {
    // The hand-entered COORDS centroid is a centre of the COUNTRY, and 12 of
    // 264 fall outside the drawn shape -- visible the moment anyone zooms in,
    // as a number floating in the sea.
    const outside: string[] = []
    for (const [id, rings] of Object.entries(SHAPES)) {
      if (rings.length === 0) continue
      const p = LABELS[id]
      if (p === undefined || !rings.some((r) => inRing(p[0], p[1], r))) outside.push(id)
    }
    expect(outside).toEqual([])
  })

  it("has a label for every territory that has a shape", () => {
    for (const [id, rings] of Object.entries(SHAPES)) {
      if (rings.length === 0) continue
      expect(LABELS[id], id).toBeDefined()
    }
  })
})

describe("label boxes", () => {
  const inRing = (lon: number, lat: number, ring: [number, number][]): boolean => {
    let hit = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }

  it("gives every shaped territory a box", () => {
    for (const [id, rings] of Object.entries(SHAPES)) {
      if (rings.length === 0) continue
      expect(LABEL_BOXES[id], id).toBeDefined()
    }
  })

  it("centres the label inside the box, and the box inside the territory", () => {
    // The box is the room a garrison count actually has. If its centre drifted
    // outside the territory the number would sit in the sea -- which is what
    // measuring the BOUNDING box used to allow.
    const outside: string[] = []
    for (const [id, rings] of Object.entries(SHAPES)) {
      if (rings.length === 0) continue
      const b = LABEL_BOXES[id]!
      const c = LABELS[id]!
      expect(c[0], id).toBeCloseTo((b[0] + b[2]) / 2, 2)
      expect(c[1], id).toBeCloseTo((b[1] + b[3]) / 2, 2)
      if (!rings.some((r) => inRing(c[0], c[1], r))) outside.push(id)
    }
    expect(outside).toEqual([])
  })

  it("never claims more room than the territory's own bounds", () => {
    // A box wider than the territory would let a number through that cannot
    // possibly fit.
    for (const [id, rings] of Object.entries(SHAPES)) {
      if (rings.length === 0) continue
      const b = LABEL_BOXES[id]!
      const xs = rings.flat().map((p) => p[0])
      const ys = rings.flat().map((p) => p[1])
      expect(b[2] - b[0], `${id} width`).toBeLessThanOrEqual(Math.max(...xs) - Math.min(...xs) + 0.001)
      expect(b[3] - b[1], `${id} height`).toBeLessThanOrEqual(Math.max(...ys) - Math.min(...ys) + 0.001)
    }
  })
})
