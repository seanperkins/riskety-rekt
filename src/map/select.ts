import { MAX_ATTEMPTS, MIN_REGIONS } from "../config.js"
import type { GameMap, RegionId, Territory } from "../engine/index.js"
import type { Rng } from "../rng.js"

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

      // Nearest to target, with ties broken by rng so the walk is not
      // deterministically greedy in one direction.
      const list = [...candidates].sort((a, b) => (a < b ? -1 : 1))
      const best = Math.min(...list.map((c) => Math.abs(size + sizeOf(c) - target)))
      const near = list.filter((c) => Math.abs(size + sizeOf(c) - target) === best)
      const chosen = near[Math.floor(rng() * near.length)]!
      picked.add(chosen)
      size += sizeOf(chosen)
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
