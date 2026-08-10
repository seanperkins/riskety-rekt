import { REGION_MAX, REGION_MIN } from "../config.js"
import type { RegionId, GameMap, TerritoryId } from "../engine/index.js"

export type MapProblem =
  | { kind: "duplicate-territory"; id: TerritoryId }
  | { kind: "self-loop"; id: TerritoryId }
  | { kind: "duplicate-neighbor"; id: TerritoryId; neighbor: TerritoryId }
  | { kind: "unknown-neighbor"; id: TerritoryId; neighbor: TerritoryId }
  | { kind: "asymmetric"; id: TerritoryId; neighbor: TerritoryId }
  | { kind: "unknown-region"; id: TerritoryId; region: RegionId }
  | { kind: "empty-region"; region: RegionId }
  | { kind: "region-size"; region: RegionId; size: number }
  | { kind: "region-split"; region: RegionId }
  | { kind: "disconnected"; reachable: number; total: number }

/** Everything reachable from `start`, walking only inside `within` when given. */
function reach(
  start: TerritoryId,
  byId: Map<TerritoryId, { neighbors: TerritoryId[] }>,
  within: Set<TerritoryId> | null,
): Set<TerritoryId> {
  const seen = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    for (const n of byId.get(queue.pop()!)?.neighbors ?? []) {
      if (seen.has(n)) continue
      if (within !== null && !within.has(n)) continue
      if (!byId.has(n)) continue
      seen.add(n)
      queue.push(n)
    }
  }
  return seen
}

/**
 * Structural checks on a map.
 *
 * Lifted out of `src/engine/map.test.ts`, which ran them against `RISK_MAP`
 * alone. Every selected sub-map is generated rather than reviewed, so these stop
 * being a one-off check on one hand-authored board and become the thing that
 * makes generation safe.
 *
 * Returns EVERY problem rather than throwing on the first: a hand-authored world
 * has several on its first pass, and fixing them one run at a time is miserable.
 *
 * It cannot check geography. "Chad borders Egypt" is symmetric, connected,
 * in-band and wrong — that is what the viewer is for.
 */
export function validateMap(map: GameMap): MapProblem[] {
  const problems: MapProblem[] = []
  const byId = new Map(map.territories.map((t) => [t.id, t]))
  const regionIds = new Set(map.regions.map((c) => c.id))

  const seenIds = new Set<TerritoryId>()
  for (const t of map.territories) {
    if (seenIds.has(t.id)) problems.push({ kind: "duplicate-territory", id: t.id })
    seenIds.add(t.id)

    if (!regionIds.has(t.region)) {
      problems.push({ kind: "unknown-region", id: t.id, region: t.region })
    }

    const seenNeighbors = new Set<TerritoryId>()
    for (const n of t.neighbors) {
      if (n === t.id) {
        problems.push({ kind: "self-loop", id: t.id })
        continue
      }
      if (seenNeighbors.has(n)) {
        problems.push({ kind: "duplicate-neighbor", id: t.id, neighbor: n })
        continue
      }
      seenNeighbors.add(n)
      const other = byId.get(n)
      if (other === undefined) {
        problems.push({ kind: "unknown-neighbor", id: t.id, neighbor: n })
      } else if (!other.neighbors.includes(t.id)) {
        problems.push({ kind: "asymmetric", id: t.id, neighbor: n })
      }
    }
  }

  for (const c of map.regions) {
    const members = map.territories.filter((t) => t.region === c.id)
    if (members.length === 0) {
      problems.push({ kind: "empty-region", region: c.id })
      continue
    }
    if (members.length < REGION_MIN || members.length > REGION_MAX) {
      problems.push({ kind: "region-size", region: c.id, size: members.length })
    }
    const within = new Set(members.map((t) => t.id))
    if (reach(members[0]!.id, byId, within).size !== members.length) {
      problems.push({ kind: "region-split", region: c.id })
    }
  }

  const first = map.territories[0]
  if (first !== undefined) {
    const reachable = reach(first.id, byId, null).size
    if (reachable !== map.territories.length) {
      problems.push({ kind: "disconnected", reachable, total: map.territories.length })
    }
  }

  return problems
}
