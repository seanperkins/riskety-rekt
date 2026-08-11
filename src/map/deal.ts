import type { GameMap, TerritoryId } from "../engine/index.js"
import type { Rng } from "../rng.js"
import { COORDS } from "./coords.js"

/**
 * Deal each faction a CONTIGUOUS holding rather than scattered specks.
 *
 * A plain shuffle deals round-robin, which maximises scatter: measured on
 * 10-faction boards, each player held 5.7 to 6.3 separate clumps out of seven
 * territories, and their largest connected holding averaged 1.9. Almost every
 * territory was an island, which makes the whole defensive layer of the game
 * inert — you cannot hold a line that does not exist, `protect` covers one
 * territory of seven, and a region bonus needs a whole region nobody can
 * assemble.
 *
 * This does NOT change the engine. `createSeason` deals `ids[i]` to
 * `factions[i % n]`, so the assignment is entirely determined by the ORDER it
 * is handed — emit that order interleaved and round-robin reproduces any
 * assignment. The engine stays pure, the golden file stays valid, and the deal
 * remains something the caller decides.
 *
 * Two phases:
 *
 * 1. **Seeds**, by farthest-point sampling. The first is drawn from the rng;
 *    each next one is the territory whose nearest existing seed is furthest
 *    away. Random seeds clump — two players starting as neighbours are in a
 *    knife fight before anyone has income — and spreading them is the whole
 *    point of dealing blocks.
 * 2. **Growth**, round-robin, each faction claiming an unclaimed territory on
 *    its own frontier. Round-robin rather than one faction at a time, so nobody
 *    is boxed in by whoever went first.
 */
export function clusteredOrder(
  map: GameMap,
  factionCount: number,
  rng: Rng,
): TerritoryId[] {
  const ids = map.territories.map((t) => t.id)
  const neighbors = new Map(map.territories.map((t) => [t.id, t.neighbors]))

  // Exactly what round-robin would give each faction, remainder included: with
  // 71 territories and 10 factions the first gets eight. Growing to any other
  // shape and interleaving it would silently drop territories.
  const target = Array.from(
    { length: factionCount },
    (_, f) => Math.floor((ids.length - f - 1) / factionCount) + 1,
  )

  const dist = (a: TerritoryId, b: TerritoryId): number => {
    const p = COORDS[a]
    const q = COORDS[b]
    if (p === undefined || q === undefined) return 0
    // Comparison only, so squared degrees with longitude compressed by latitude
    // is enough — and much cheaper than a great circle in an O(n^2) loop.
    const dx = (p.lon - q.lon) * Math.cos((((p.lat + q.lat) / 2) * Math.PI) / 180)
    const dy = p.lat - q.lat
    return dx * dx + dy * dy
  }

  const seeds: TerritoryId[] = [ids[Math.floor(rng() * ids.length)]!]
  while (seeds.length < factionCount) {
    let best = ids[0]!
    let bestD = -1
    for (const id of ids) {
      if (seeds.includes(id)) continue
      let nearest = Infinity
      for (const s of seeds) nearest = Math.min(nearest, dist(id, s))
      if (nearest > bestD) {
        bestD = nearest
        best = id
      }
    }
    seeds.push(best)
  }

  const owned: TerritoryId[][] = seeds.map((s) => [s])
  const claimed = new Set<TerritoryId>(seeds)

  let progress = true
  while (claimed.size < ids.length && progress) {
    progress = false
    for (let f = 0; f < factionCount; f++) {
      if (owned[f]!.length >= target[f]!) continue

      const frontier: TerritoryId[] = []
      for (const mine of owned[f]!) {
        for (const n of neighbors.get(mine) ?? []) {
          if (!claimed.has(n) && !frontier.includes(n)) frontier.push(n)
        }
      }

      // Boxed in: everything reachable is taken. Fall back to the nearest
      // unclaimed territory anywhere, which keeps the counts exact at the cost
      // of one detached outpost. Preferable to leaving a territory unowned,
      // which createSeason rejects outright.
      const pool =
        frontier.length > 0
          ? frontier
          : ids.filter((id) => !claimed.has(id))
      if (pool.length === 0) continue

      const pick =
        frontier.length > 0
          ? // Nearest the faction's seed, drawn from the nearer half so the
            // shape stays compact without every board looking identical.
            (() => {
              const sorted = [...pool].sort((a, b) => dist(a, seeds[f]!) - dist(b, seeds[f]!))
              const near = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)))
              return near[Math.floor(rng() * near.length)]!
            })()
          : [...pool].sort((a, b) => dist(a, seeds[f]!) - dist(b, seeds[f]!))[0]!

      owned[f]!.push(pick)
      claimed.add(pick)
      progress = true
    }
  }

  // Anything left over — only reachable if every faction hit its target early,
  // which the exact-count arithmetic rules out. Kept so the function cannot
  // return a short list even if that arithmetic is later changed.
  for (const id of ids) {
    if (claimed.has(id)) continue
    let smallest = 0
    for (let f = 1; f < factionCount; f++) {
      if (owned[f]!.length < owned[smallest]!.length) smallest = f
    }
    owned[smallest]!.push(id)
    claimed.add(id)
  }

  // Interleave, so `createSeason`'s `i % factionCount` reproduces exactly this.
  const order: TerritoryId[] = []
  for (let j = 0; ; j++) {
    let added = false
    for (let f = 0; f < factionCount; f++) {
      const t = owned[f]![j]
      if (t === undefined) continue
      order.push(t)
      added = true
    }
    if (!added) break
  }
  return order
}
