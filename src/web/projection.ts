import type { GameMap } from "../engine/index.js"
import type { LatLon } from "../map/coords.js"

export interface Point {
  x: number
  y: number
}

export interface Projection {
  width: number
  height: number
  at(id: string): Point | undefined
}

/**
 * Equal Earth (Šavrič, Patterson & Jenny, 2018).
 *
 * Equal-area, which matters here more than it usually would: territory COUNT is
 * the win condition, so a projection that inflates the north would make the
 * board misread — Siberia and Canada look enormous under equirectangular while
 * holding six territories between them.
 *
 * A closed-form polynomial in the parametric latitude, so it needs no
 * dependency and no iteration. The constants are the paper's.
 *
 *   x = 2√3·λ·cosθ / (3·(9A₄θ⁸ + 7A₃θ⁶ + 3A₂θ² + A₁))
 *   y = A₄θ⁹ + A₃θ⁷ + A₂θ³ + A₁θ
 *   where sinθ = (√3/2)·sinφ
 */
const A1 = 1.340264
const A2 = -0.081106
const A3 = 0.000893
const A4 = 0.003796
const SQRT3 = Math.sqrt(3)

/** Longitude/latitude in degrees to Equal Earth plane coordinates. */
export function equalEarth(lat: number, lon: number): { x: number; y: number } {
  const phi = (lat * Math.PI) / 180
  const lambda = (lon * Math.PI) / 180
  // clamp guards a floating-point |sin| a hair over 1 at the poles, which would
  // make asin return NaN and render an invisible, silent blank.
  const theta = Math.asin(Math.max(-1, Math.min(1, (SQRT3 / 2) * Math.sin(phi))))
  const t2 = theta * theta
  const t6 = t2 * t2 * t2
  const t8 = t6 * t2
  return {
    x: (2 * SQRT3 * lambda * Math.cos(theta)) / (3 * (9 * A4 * t8 + 7 * A3 * t6 + 3 * A2 * t2 + A1)),
    y: A4 * theta * t8 + A3 * theta * t6 + A2 * theta * t2 + A1 * theta,
  }
}

/**
 * Project a map's territories onto a fixed viewBox.
 *
 * A real projection rather than a graph layout, and that is the whole point: a
 * force-directed layout would place Chad beside Egypt BECAUSE they are adjacent
 * in the data, which hides the exact defect this view exists to catch. Real
 * coordinates make a wrong border visibly wrong.
 *
 * Pure and separate from the component so it can be tested without rendering.
 */
export function project(
  map: GameMap,
  coords: Record<string, LatLon>,
  width: number,
  height: number,
  pad: number,
): Projection {
  const points = map.territories.map((t) => coords[t.id]).filter((c): c is LatLon => c !== undefined)

  // A single-territory map, or one where every territory shares a longitude,
  // would divide by zero. Falling back to 1 puts everything on one line rather
  // than producing NaN coordinates, which render as an invisible, silent blank.
  const planar = points.map((c) => equalEarth(c.lat, c.lon))
  const xs = planar.map((p) => p.x)
  const ys = planar.map((p) => p.y)
  const x0 = Math.min(...xs)
  const y1 = Math.max(...ys)
  const spanX = Math.max(...xs) - x0
  const spanY = y1 - Math.min(...ys)

  // ONE scale for both axes, chosen so the wider span fits. Scaling x and y
  // independently would stretch the board back to the aspect distortion the
  // projection exists to remove -- an equal-area projection squashed to fill a
  // box is no longer equal-area.
  //
  // A degenerate axis (every territory on one line, or a single territory) does
  // NOT constrain the scale. Substituting 1 for a zero span would let a
  // one-unit-tall imaginary extent decide the scale for both axes.
  const fitX = spanX > 0 ? (width - 2 * pad) / spanX : Number.POSITIVE_INFINITY
  const fitY = spanY > 0 ? (height - 2 * pad) / spanY : Number.POSITIVE_INFINITY
  const scale = Number.isFinite(Math.min(fitX, fitY)) ? Math.min(fitX, fitY) : 1
  // Centre the leftover on the axis that did not bind.
  const offsetX = (width - spanX * scale) / 2
  const offsetY = (height - spanY * scale) / 2

  const at = (id: string): Point | undefined => {
    const c = coords[id]
    if (c === undefined) return undefined
    const p = equalEarth(c.lat, c.lon)
    return {
      x: offsetX + (p.x - x0) * scale,
      // Plane y grows north; SVG y grows down.
      y: offsetY + (y1 - p.y) * scale,
    }
  }

  return { width, height, at }
}

/** Each region's size and the number of its territories that border another. */
export function regionStats(
  map: GameMap,
): { id: string; name: string; size: number; entries: number; bonus: number }[] {
  return map.regions.map((c) => {
    const members = map.territories.filter((t) => t.region === c.id)
    const ids = new Set(members.map((t) => t.id))
    return {
      id: c.id,
      name: c.name,
      size: members.length,
      entries: members.filter((t) => t.neighbors.some((n) => !ids.has(n))).length,
      bonus: c.bonus,
    }
  })
}

export interface Focus {
  /** The region and everything bordering it, as a standalone map. */
  map: GameMap
  /** Territories belonging to the focused region itself. */
  inFocus: Set<string>
}

/**
 * One region plus every territory that borders it.
 *
 * The whole-world view cannot do the job it exists for. Europe packs ~75
 * territories into roughly 15° of latitude by 40° of longitude while Siberia
 * spreads 6 across 100° of longitude, and equirectangular gives every degree the
 * same pixels — so Europe collapses into an unreadable blob, which is exactly
 * where a wrong border is most likely and least visible.
 *
 * Neighbours are included rather than the region alone because a region's
 * borders LEAVE it: showing only its members would hide every edge worth
 * checking.
 *
 * Returns `undefined` for an unknown region rather than an empty map, so the
 * caller can 404 instead of rendering a blank page.
 */
export function focusRegion(map: GameMap, regionId: string): Focus | undefined {
  const region = map.regions.find((r) => r.id === regionId)
  if (region === undefined) return undefined

  const members = map.territories.filter((t) => t.region === regionId)
  const inFocus = new Set(members.map((t) => t.id))

  const keep = new Set(inFocus)
  for (const t of members) for (const n of t.neighbors) keep.add(n)

  const territories = map.territories
    .filter((t) => keep.has(t.id))
    // Copies with neighbours filtered to the kept set, or the sub-map fails the
    // same symmetry invariant the world has to pass.
    .map((t) => ({ ...t, neighbors: t.neighbors.filter((n) => keep.has(n)) }))

  const present = new Set(territories.map((t) => t.region))
  return {
    map: { regions: map.regions.filter((r) => present.has(r.id)), territories },
    inFocus,
  }
}

/** Every border once, as an unordered pair. */
export function edges(map: GameMap): [string, string][] {
  const seen = new Set<string>()
  const out: [string, string][] = []
  for (const t of map.territories) {
    for (const n of t.neighbors) {
      const key = [t.id, n].sort().join("|")
      if (seen.has(key)) continue
      seen.add(key)
      out.push([t.id, n])
    }
  }
  return out
}
