import { MAX_ATTEMPTS, MIN_REGIONS } from "../config.js"
import type { GameMap, RegionId, Territory } from "../engine/index.js"
import type { Rng } from "../rng.js"
import { COORDS } from "./coords.js"
import type { LatLon } from "./coords.js"

/**
 * How far a region's size fit may be from the best and still be considered.
 *
 * This is the dial that trades board tightness against board variety, and both
 * ends are bad: 0 gives sprawling boards, and dropping the size term entirely
 * gives the same Mediterranean board every season. Measured at 2.
 */
const SIZE_SLACK = 2

/** Great-circle kilometres. Only ever used to COMPARE distances. */
function distanceKm(a: LatLon, b: LatLon): number {
  const R = 6371
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Mean position of a set of territories.
 *
 * A naive mean of longitudes, which is wrong across the date line — a board
 * spanning it would get a centre on the far side of the planet. Accepted
 * because the centre is only ever used to RANK candidates against each other,
 * and the one date-line crossing in the world (the Bering Strait) is exactly
 * the sprawl this ranking exists to discourage.
 */
function centroidOf(ids: string[]): LatLon {
  const points = ids.map((id) => COORDS[id]).filter((c): c is LatLon => c !== undefined)
  if (points.length === 0) return { lat: 0, lon: 0 }
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
  }
}

/**
 * A region's bonus.
 *
 * `floor(size / 2) + floor(entries / 3)`, calibrated against classic Risk,
 * which it reproduces exactly on four of its six continents:
 *
 *   Australia      4 territories, 1 entry  -> 2   (Risk: 2)
 *   South America  4 territories, 2 entries -> 2  (Risk: 2)
 *   Africa         6 territories, 3 entries -> 4  (Risk: 3)
 *   Europe         7 territories, 4 entries -> 4  (Risk: 5)
 *   North America  9 territories, 3 entries -> 5  (Risk: 5)
 *   Asia          12 territories, 5 entries -> 7  (Risk: 7)
 *
 * The two misses are by one and in opposite directions, so it is not
 * systematically generous or stingy. It ships as written and the simulator
 * judges it — the same way VOLUME_FLOOR was settled from measurement rather
 * than from argument.
 */
export function bonusFor(size: number, entries: number): number {
  return Math.max(1, Math.floor(size / 2) + Math.floor(entries / 3))
}

/**
 * A contiguous sub-map sized to the roster.
 *
 * Whole regions only: a half-region would make its bonus meaningless — an
 * objective you complete by holding three of six real territories is not the
 * mechanic — and selection relies on regions being internally contiguous, which
 * `validateMap` guarantees.
 *
 * Bonuses are computed HERE and not carried in the world data, because a
 * region's defensibility depends on which of its neighbours were selected. The
 * Maghreb with Iberia and Italy on the board has several ways in; on a board
 * with neither it is a fortress.
 */
export function selectSubMap(world: GameMap, factionCount: number, rng: Rng): GameMap {
  const lo = 5 * factionCount
  const hi = 11 * factionCount
  const target = 7 * factionCount

  const members = new Map<RegionId, Territory[]>()
  for (const r of world.regions) members.set(r.id, [])
  for (const t of world.territories) members.get(t.region)?.push(t)

  const sizeOf = (id: RegionId): number => members.get(id)?.length ?? 0

  // Region centroids are constant, and the walk compares them on every step
  // against every candidate. Recomputing them made the 2,000-season balance run
  // take 8.4s instead of 2s.
  const centres = new Map<RegionId, LatLon>(
    world.regions.map((r) => [r.id, centroidOf((members.get(r.id) ?? []).map((t) => t.id))]),
  )
  const centreOf = (id: RegionId): LatLon => centres.get(id) ?? { lat: 0, lon: 0 }

  // Region adjacency, derived from borders rather than stored. A second source
  // of truth could drift from the territory records.
  const owner = new Map(world.territories.map((t) => [t.id, t.region]))
  const adjacent = new Map<RegionId, Set<RegionId>>()
  for (const r of world.regions) adjacent.set(r.id, new Set())
  for (const t of world.territories) {
    for (const n of t.neighbors) {
      const other = owner.get(n)
      if (other !== undefined && other !== t.region) adjacent.get(t.region)?.add(other)
    }
  }

  const starts = world.regions.map((r) => r.id)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const first = starts[Math.floor(rng() * starts.length)]!
    const picked = new Set<RegionId>([first])
    let size = sizeOf(first)
    // Running sums, so the board's centre is O(1) per step rather than a fresh
    // pass over every territory picked so far.
    let sumLat = 0
    let sumLon = 0
    for (const t of members.get(first) ?? []) {
      const c = COORDS[t.id]
      if (c !== undefined) {
        sumLat += c.lat
        sumLon += c.lon
      }
    }

    // Two different reasons to keep walking, and conflating them was a bug:
    // stopping the moment `size >= lo` parks every board at the FLOOR of the
    // legal window. Measured, that put a 15-faction season at 79 territories —
    // 5.3 each — when the target is 7. Legal, but the lower bound exists
    // because a thin holding dies to one focused attack, so sitting on it by
    // construction is the wrong default. Grow past the floor toward `target`
    // and stop when there is nothing that fits.
    while (size < lo || picked.size < MIN_REGIONS || size < target) {
      const candidates = new Set<RegionId>()
      for (const r of picked) {
        for (const n of adjacent.get(r) ?? []) {
          if (!picked.has(n) && size + sizeOf(n) <= hi) candidates.add(n)
        }
      }
      if (candidates.size === 0) break // stranded; restart from a new seed region

      // Size fit stays primary, but candidates within SIZE_SLACK of the best are
      // treated as equally good; among those, prefer the one nearest the board's
      // centre, and draw from the nearer half so the walk stays varied.
      //
      // Without the distance term a 15-faction board averaged a 15,400 km
      // widest span -- Canada to Kamchatka to the Congo, contiguous through
      // Greenland and the Bering Strait but not anywhere. Measured over 60
      // seeds:
      //
      //   rule                     mean span   p90      distinct boards
      //   size fit only              15,410   18,355         59/60
      //   size fit, distance tie     13,914   18,355         13/60
      //   THIS (slack, then near)    11,384   14,647         59/60
      //   distance only              10,988   14,647          8/60
      //
      // The obvious softening -- keep size fit and break ties by distance --
      // is the WORST of them: it barely tightens the board and collapses
      // variety, because a deterministic tiebreak removes the rng from most
      // choices. Widening the bucket first is what keeps a real pool to draw
      // from.
      const list = [...candidates].sort((a, b) => (a < b ? -1 : 1))
      const fit = (c: RegionId): number => Math.abs(size + sizeOf(c) - target)
      const best = Math.min(...list.map(fit))
      const centre: LatLon = { lat: sumLat / size, lon: sumLon / size }
      const pool = list
        .filter((c) => fit(c) <= best + SIZE_SLACK)
        .sort((a, b) => distanceKm(centreOf(a), centre) - distanceKm(centreOf(b), centre))
      const nearer = pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)))
      const chosen = nearer[Math.floor(rng() * nearer.length)]!
      picked.add(chosen)
      size += sizeOf(chosen)
      for (const t of members.get(chosen) ?? []) {
        const c = COORDS[t.id]
        if (c !== undefined) {
          sumLat += c.lat
          sumLon += c.lon
        }
      }
    }

    if (size >= lo && size <= hi && picked.size >= MIN_REGIONS) {
      return induce(world, picked, members)
    }
  }

  throw new Error(
    `selectSubMap: no board for ${factionCount} factions in ${MAX_ATTEMPTS} attempts ` +
      `(needed ${lo}-${hi} territories from >= ${MIN_REGIONS} regions)`,
  )
}

function induce(
  world: GameMap,
  picked: Set<RegionId>,
  members: Map<RegionId, Territory[]>,
): GameMap {
  const kept = world.territories.filter((t) => picked.has(t.region))
  const ids = new Set(kept.map((t) => t.id))

  // Copies, never the world's own records. Filtering neighbours in place would
  // corrupt WORLD for every later season in the same process — which is exactly
  // what the simulator does, 2000 times.
  const territories: Territory[] = kept.map((t) => ({
    ...t,
    neighbors: t.neighbors.filter((n) => ids.has(n)),
  }))

  const regions = [...picked]
    .sort()
    .map((id) => {
      const source = world.regions.find((r) => r.id === id)!
      const own = new Set((members.get(id) ?? []).map((t) => t.id))
      const size = own.size
      const entries = (members.get(id) ?? []).filter((t) =>
        t.neighbors.some((n) => ids.has(n) && !own.has(n)),
      ).length
      return { ...source, bonus: bonusFor(size, entries) }
    })

  return { regions, territories }
}
