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
 * Equirectangular projection of a map's territories onto a fixed viewBox.
 *
 * Equirectangular rather than a graph layout, and that is the whole point: a
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
  const lons = points.map((c) => c.lon)
  const lats = points.map((c) => c.lat)
  const lon0 = Math.min(...lons)
  const lat1 = Math.max(...lats)
  const spanLon = Math.max(...lons) - lon0 || 1
  const spanLat = lat1 - Math.min(...lats) || 1

  const at = (id: string): Point | undefined => {
    const c = coords[id]
    if (c === undefined) return undefined
    return {
      x: pad + ((c.lon - lon0) / spanLon) * (width - 2 * pad),
      y: pad + ((lat1 - c.lat) / spanLat) * (height - 2 * pad),
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
