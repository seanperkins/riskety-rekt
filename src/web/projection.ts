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

/** Each continent's size and the number of its territories that border another. */
export function continentStats(
  map: GameMap,
): { id: string; name: string; size: number; entries: number; bonus: number }[] {
  return map.continents.map((c) => {
    const members = map.territories.filter((t) => t.continent === c.id)
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
