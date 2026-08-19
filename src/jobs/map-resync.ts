import { UsageError } from "./flags.js"
import type { GameMap, Territory } from "../engine/index.js"
import type { SeasonStore, StateMapStore, StateStore, Transactional } from "../store/types.js"

export type MapResyncOutcome =
  | { status: "rewritten"; days: number[]; added: [string, string][]; removed: [string, string][] }
  | { status: "planned"; days: number[]; added: [string, string][]; removed: [string, string][] }
  | { status: "unchanged"; days: number[] }

export interface MapResyncDeps {
  store: SeasonStore & StateStore & StateMapStore & Transactional
  seasonId: string
  /** The corrected map — callers pass WORLD or RISK_MAP. */
  map: GameMap
  /** Writes only when true; otherwise reports and writes nothing. */
  confirm?: boolean
  log?: (msg: string) => void
}

/** `[a, b]` with `a < b` — the canonical, order-independent form of a border. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

function pairsOf(territories: { id: string; neighbors: string[] }[]): Set<string> {
  const pairs = new Set<string>()
  for (const t of territories) {
    for (const n of t.neighbors) pairs.add(pairKey(t.id, n))
  }
  return pairs
}

function toPairList(keys: Iterable<string>): [string, string][] {
  return [...keys]
    .map((k): [string, string] => {
      const [a, b] = k.split("\u0000") as [string, string]
      return [a, b]
    })
    .sort(([a1, b1], [a2, b2]) => (a1 === a2 ? a1.localeCompare(b1) : a1.localeCompare(a2)) || b1.localeCompare(b2))
}

/**
 * Recompute one saved day's territory list against the corrected map.
 *
 * The frozen map is a SUBSET of `map` — a season deal only ever holds some of
 * the world. For each frozen territory, the new neighbour list is `map`'s
 * neighbours for that id INTERSECTED with the ids present in THIS day's
 * frozen map: a corrected border to a territory nobody dealt would be
 * unreachable and would fail every downstream lookup that assumes a
 * neighbour is also a territory. A frozen id absent from `map` entirely (the
 * corrected data dropped or renamed it) keeps its existing neighbours
 * untouched, and is logged rather than silently changed — guessing here would
 * corrupt a live season's map with no operator visibility.
 *
 * `regions` (including each `bonus`) and every territory's `id`/`name`/
 * `region` are carried over exactly. Bonuses were computed at the deal from
 * the OLD adjacency; recomputing them mid-season would move scoring under the
 * players, so only `neighbors` changes.
 */
function resyncTerritories(
  frozenTerritories: Territory[],
  correctedById: Map<string, Territory>,
  seasonId: string,
  day: number,
  log: (msg: string) => void,
): Territory[] {
  const frozenIds = new Set(frozenTerritories.map((t) => t.id))
  return frozenTerritories.map((t): Territory => {
    const corrected = correctedById.get(t.id)
    if (corrected === undefined) {
      log(`map-resync: season ${seasonId} day ${day}: ${t.id} is absent from the corrected map; neighbors left unchanged`)
      return { ...t, neighbors: [...t.neighbors].sort() }
    }
    const neighbors = [...new Set(corrected.neighbors.filter((n) => frozenIds.has(n)))].sort()
    return { ...t, neighbors }
  })
}

/**
 * Assert every neighbour relationship in `territories` is mutual. An
 * asymmetric result here is a bug in the corrected map or in this job, not a
 * fact about the world — attacking across a border the far side doesn't
 * recognise breaks the engine's own invariants, so this throws rather than
 * writing a broken map to a live season.
 */
function assertSymmetric(territories: Territory[], seasonId: string, day: number): void {
  const byId = new Map(territories.map((t) => [t.id, t]))
  for (const t of territories) {
    for (const n of t.neighbors) {
      const other = byId.get(n)
      if (other === undefined || !other.neighbors.includes(t.id)) {
        throw new Error(
          `map-resync: asymmetric adjacency for season ${seasonId} day ${day}: ${t.id} -> ${n} is not mutual`,
        )
      }
    }
  }
}

/**
 * Rewrite the frozen map inside every saved day of a live season to match a
 * corrected adjacency, without moving any other rule the deal already fixed.
 *
 * Walks EVERY saved day from 0 upward — day 0 is the deal, and both the board
 * and the replay render old days, so a half-rewritten season would render two
 * different topologies depending on which day a viewer opens.
 *
 * The survey runs INSIDE the write transaction when it is going to write. The
 * tick appends a day, and a day appearing between `latestSavedDay` and the
 * rewrite would be skipped: the season would carry the corrected map on every
 * day but the newest, which is the exact half-rewritten state the walk above
 * exists to avoid. Planning re-surveys because it writes nothing, so a stale
 * read costs an operator one re-run rather than a torn season.
 */
export function runMapResync(deps: MapResyncDeps): MapResyncOutcome {
  const { store, seasonId, map } = deps
  const log = deps.log ?? (() => {})

  const season = store.season(seasonId)
  if (season === undefined) throw new UsageError(`map-resync: unknown season ${seasonId}`)

  const correctedById = new Map(map.territories.map((t) => [t.id, t]))

  const survey = (): {
    days: number[]
    rewritten: Map<number, GameMap>
    changed: boolean
    added: [string, string][]
    removed: [string, string][]
  } => {
    const latest = store.latestSavedDay(seasonId)
    const days: number[] = []
    const rewritten = new Map<number, GameMap>()
    let changed = false
    let dayZeroBefore: Territory[] = []
    let dayZeroAfter: Territory[] = []

    for (let d = 0; latest !== undefined && d <= latest; d++) {
      const frozen = store.loadState(seasonId, d)
      if (frozen === undefined) continue // a gap should not happen, but is not this job's to repair
      days.push(d)

      const before = frozen.map.territories
      const after = resyncTerritories(before, correctedById, seasonId, d, log)
      assertSymmetric(after, seasonId, d)

      if (d === 0) {
        dayZeroBefore = before
        dayZeroAfter = after
      }

      const beforeSorted = before.map((t) => [...t.neighbors].sort().join(","))
      if (beforeSorted.join("|") !== after.map((t) => t.neighbors.join(",")).join("|")) {
        changed = true
      }

      rewritten.set(d, { territories: after, regions: frozen.map.regions })
    }

    const oldPairs = pairsOf(dayZeroBefore)
    const newPairs = pairsOf(dayZeroAfter)
    return {
      days,
      rewritten,
      changed,
      added: toPairList([...newPairs].filter((p) => !oldPairs.has(p))),
      removed: toPairList([...oldPairs].filter((p) => !newPairs.has(p))),
    }
  }

  if (deps.confirm !== true) {
    const planned = survey()
    if (!planned.changed) return { status: "unchanged", days: planned.days }
    return { status: "planned", days: planned.days, added: planned.added, removed: planned.removed }
  }

  return store.transaction(() => {
    const found = survey()
    if (!found.changed) return { status: "unchanged", days: found.days }
    for (const d of found.days) store.updateStateMap(seasonId, d, found.rewritten.get(d)!)
    return { status: "rewritten", days: found.days, added: found.added, removed: found.removed }
  })
}
