import { continentBonusesFor, territoriesOf } from "./setup.js"
import type { FactionId, GameState } from "./types.js"

/**
 * Baseline daily income: max(5, floor(territories / 2)) plus continent bonuses.
 *
 * An eliminated faction earns nothing. Without that carve-out the floor would
 * pay a faction with zero territories forever, funding wagers it could never
 * spend on the map.
 */
export function territoryIncome(state: GameState, factionId: FactionId): number {
  const count = territoriesOf(state, factionId).length
  if (count === 0) return 0
  return Math.max(5, Math.floor(count / 2)) + continentBonusesFor(state, factionId)
}
