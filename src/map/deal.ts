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
 *
 * And a third constraint over the top of both: **nobody starts holding a whole
 * region.** See `DEAL_ATTEMPTS`.
 */
export function clusteredOrder(
  map: GameMap,
  factionCount: number,
  rng: Rng,
): TerritoryId[] {
  let best: TerritoryId[][] | null = null
  let bestScore = Infinity
  for (let attempt = 0; attempt < DEAL_ATTEMPTS; attempt++) {
    const owned = growBlocks(map, factionCount, rng)
    const score = wholeRegionsHeld(map, owned)
    if (score === 0) return interleave(owned, factionCount)
    if (score < bestScore) {
      bestScore = score
      best = owned
    }
  }
  // Every attempt handed somebody a region. Take the least-skewed of them
  // rather than throwing: a season that refuses to start is worse than one that
  // starts with a single bonus on the board, and season:init has already sized
  // and selected the map by this point.
  return interleave(best!, factionCount)
}

/**
 * How many attempts to find a deal where nobody starts holding a whole region.
 *
 * Measured on the shipped deal, 80-90% of boards handed at least one faction a
 * complete region on day 0 — usually two — worth +2.7 income against a base of
 * `max(5, floor(t/2))`. On the live season-1 board that was +4 to one player
 * and +2 to two others, an 80% income lead on day 1 decided entirely by the
 * shuffle. It compounds, too: the 2026-08-12 run found the day-3 leader
 * converts ~39% of the time.
 *
 * Declining the completing territory DURING growth only takes it to ~68% —
 * a faction whose frontier is entirely inside the region it nearly owns has
 * nowhere else to go, and the fallback hands it over anyway. So the check is
 * made on the FINISHED deal and the whole thing is redealt when it fails, which
 * costs nothing but rng draws and leaves contiguity, the exact counts and the
 * seed spread untouched.
 *
 * Deterministic despite the loop: `rng` is a seeded stream, so attempt N always
 * consumes the same draws and the board is still reproducible from
 * `season:init`'s recorded seed alone.
 *
 * **40 because the attempts saturate, not because 40 is enough.** Only the
 * FIRST seed is drawn from the rng — the rest are farthest-point sampling and
 * follow from it — so there are only as many seed layouts as there are
 * territories, and retrying re-treads them. Measured over 400 sub-maps per
 * roster size, boards still handing somebody a region:
 *
 * | factions | shipped | 40 attempts | 300 attempts |
 * |---|---|---|---|
 * | 4  | 80.8% | 6.0%  | 3.3%  |
 * | 6  | 89.0% | 6.0%  | 0.8%  |
 * | 8  | 90.5% | 18.3% | 10.0% |
 * | 12 | 84.3% | 7.2%  | 1.8%  |
 *
 * 7.5x the work halves the residual, so the rest is structural: some selected
 * boards contain a region small and cornered enough that whichever faction
 * seeds beside it swallows it. Those keep the best-scoring deal of the 40
 * rather than refusing to deal at all.
 */
const DEAL_ATTEMPTS = 40

/** Regions held whole by a single faction — the thing a deal is scored on. */
function wholeRegionsHeld(map: GameMap, owned: TerritoryId[][]): number {
  const ownerOf = new Map<TerritoryId, number>()
  owned.forEach((block, f) => block.forEach((id) => ownerOf.set(id, f)))
  let held = 0
  for (const r of map.regions) {
    const members = map.territories.filter((t) => t.region === r.id)
    const first = ownerOf.get(members[0]!.id)
    if (first !== undefined && members.every((t) => ownerOf.get(t.id) === first)) held++
  }
  return held
}

/** Interleave, so `createSeason`'s `i % factionCount` reproduces exactly this. */
function interleave(owned: TerritoryId[][], factionCount: number): TerritoryId[] {
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

/** One deal: seeds by farthest-point sampling, then round-robin growth. */
function growBlocks(map: GameMap, factionCount: number, rng: Rng): TerritoryId[][] {
  const ids = map.territories.map((t) => t.id)
  const neighbors = new Map(map.territories.map((t) => [t.id, t.neighbors]))
  const regionOf = new Map(map.territories.map((t) => [t.id, t.region]))
  const regionMembers = new Map<string, TerritoryId[]>()
  for (const t of map.territories) {
    const list = regionMembers.get(t.region)
    if (list === undefined) regionMembers.set(t.region, [t.id])
    else list.push(t.id)
  }

  /** Which faction holds each territory, maintained as the blocks grow. */
  const ownerOf = new Map<TerritoryId, number>()

  /**
   * Would faction `f` taking `id` hand it a WHOLE region, and its bonus?
   *
   * Measured on the shipped deal, 80-90% of boards gave at least one faction a
   * complete region on day 0 — usually two of them — worth +2.7 income against
   * a base of max(5, ...). That is a >50% income lead before anyone has played
   * a turn, decided entirely by the shuffle, and it compounds: the 2026-08-12
   * run already found the day-3 leader converts ~39% of the time.
   *
   * Growth simply declines the territory that would close a region. It is a
   * preference, not a guarantee — see the fallback at the call site — so the
   * counts stay exact and the loop cannot stall.
   */
  const completesRegion = (f: number, id: TerritoryId): boolean => {
    const members = regionMembers.get(regionOf.get(id)!) ?? []
    return members.every((m) => m === id || ownerOf.get(m) === f)
  }

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
  seeds.forEach((s, f) => ownerOf.set(s, f))

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
      const reachable =
        frontier.length > 0
          ? frontier
          : ids.filter((id) => !claimed.has(id))
      if (reachable.length === 0) continue

      // Decline the territory that would close a region, unless declining
      // would mean taking nothing — the counts have to come out exact, and a
      // faction boxed inside a region it nearly owns has nowhere else to go.
      // Rare, and it leaves one bonus on the board rather than deadlocking.
      const open = reachable.filter((id) => !completesRegion(f, id))
      const pool = open.length > 0 ? open : reachable

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
      ownerOf.set(pick, f)
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
    ownerOf.set(id, smallest)
  }

  return owned
}
