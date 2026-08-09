import { RISK_MAP } from "./map.js"
import { ENGINE_VERSION } from "./types.js"
import type { Faction, FactionId, GameState, TerritoryId } from "./types.js"

export function territoriesOf(state: GameState, factionId: FactionId): TerritoryId[] {
  return Object.keys(state.ownership)
    .sort()
    .filter((t) => state.ownership[t] === factionId)
}

export function continentBonusesFor(state: GameState, factionId: FactionId): number {
  let bonus = 0
  for (const c of state.map.continents) {
    const members = state.map.territories.filter((t) => t.continent === c.id)
    if (members.every((t) => state.ownership[t.id] === factionId)) bonus += c.bonus
  }
  return bonus
}

export function createSeason(
  seasonId: string,
  factions: Faction[],
  shuffledTerritoryIds: TerritoryId[],
): GameState {
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
    map: RISK_MAP,
    factions,
    ownership,
    garrisons,
    reserves,
    pending: [],
    log: [],
    engineVersion: ENGINE_VERSION,
  }
}
