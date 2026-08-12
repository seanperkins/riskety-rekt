import { RISK_MAP } from "./map.js"
import { ENGINE_VERSION } from "./types.js"
import type { Faction, FactionId, GameMap, GameState, TerritoryId } from "./types.js"

export function territoriesOf(state: GameState, factionId: FactionId): TerritoryId[] {
  return Object.keys(state.ownership)
    .sort()
    .filter((t) => state.ownership[t] === factionId)
}

export function regionBonusesFor(state: GameState, factionId: FactionId): number {
  let bonus = 0
  for (const c of state.map.regions) {
    const members = state.map.territories.filter((t) => t.region === c.id)
    if (members.every((t) => state.ownership[t.id] === factionId)) bonus += c.bonus
  }
  return bonus
}

/**
 * Deal a board. Still pure: the caller shuffles.
 *
 * `map` is an optional trailing parameter so every existing 3-argument call site
 * keeps compiling. It was hardcoded to RISK_MAP while the territory list was
 * already an argument, which is a worse failure than it looks: the dealt set and
 * the adjacency graph came from different places, and a territory in the map but
 * not in the deal is a FREE CAPTURE, not a crash. It has no owner and no
 * garrison, `validateOrder` builds adjacency from `state.map` so an attack on it
 * passes validation, and combat reads `garrisons[to] ?? 0` — so one troop takes
 * it. Silent, and it corrupts the board rather than stopping the tick.
 *
 * Hence the set check rather than a length check: equal sizes with different
 * members is the same bug.
 */
export function createSeason(
  seasonId: string,
  factions: Faction[],
  shuffledTerritoryIds: TerritoryId[],
  map: GameMap = RISK_MAP,
): GameState {
  const mapIds = new Set(map.territories.map((t) => t.id))
  const dealt = new Set(shuffledTerritoryIds)
  if (mapIds.size !== dealt.size || [...dealt].some((id) => !mapIds.has(id))) {
    throw new Error(
      `createSeason: the dealt territories must be exactly the map's territory set ` +
        `(map ${mapIds.size}, dealt ${dealt.size})`,
    )
  }

  const ownership: Record<TerritoryId, FactionId> = {}
  const garrisons: Record<TerritoryId, number> = {}
  shuffledTerritoryIds.forEach((tid, i) => {
    ownership[tid] = factions[i % factions.length]!.id
    garrisons[tid] = 2
  })
  const reserves: Record<FactionId, number> = {}
  for (const f of factions) reserves[f.id] = 0

  return {
    seasonId,
    day: 0,
    map,
    factions,
    ownership,
    garrisons,
    reserves,
    moduleState: {},
    log: [],
    engineVersion: ENGINE_VERSION,
  }
}
