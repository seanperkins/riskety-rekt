import type { TerritoryId } from "../engine/index.js"
import { SPECS } from "./world.js"

export interface LatLon {
  lat: number
  lon: number
}

/**
 * Approximate centroids, for the viewer and later the web map.
 *
 * Deliberately NOT fields on `Territory`. Three reasons, in increasing order of
 * how much they cost:
 *
 * - The engine has no use for geometry. The same rule that keeps the clock out
 *   of it keeps coordinates out of it.
 * - `GameState.map` is serialised into every daily `states` row, so these would
 *   be stored fifteen times a season to be read by nothing.
 * - The golden file serialises the whole map, so two fields on `Territory` would
 *   churn `__golden__/season-1.json` by 84 values with no behavioural change —
 *   which is how people learn to regenerate a golden file without reading it.
 *
 * Derived from the same records as the world itself, so a territory can never
 * be added without its coordinate or renamed out from under one.
 */
export const COORDS: Record<TerritoryId, LatLon> = Object.fromEntries(
  SPECS.map((s) => [s.id, { lat: s.lat, lon: s.lon }]),
)
