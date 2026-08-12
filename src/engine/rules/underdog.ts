import { territoriesOf } from "../setup.js"
import type { Rule } from "../mechanics.js"

/**
 * The smallest surviving faction(s) are paid.
 *
 * EVERY tie is paid, not just the first. An arbitrary tiebreak here would hand
 * one player troops for sorting lower, which is a rule nobody could reason
 * about at the ballot. Eliminated factions are skipped, mirroring core
 * income's own zero-territory skip.
 */
export const underdogRule: Rule = {
  id: "underdog",
  name: "Participation Trophy",
  description: "The smallest factions each gain 3 troops. Everyone's a winner. Some less so.",
  grant(state) {
    const alive = state.factions
      .map((f) => ({ faction: f.id, n: territoriesOf(state, f.id).length }))
      .filter((x) => x.n > 0)
    if (alive.length === 0) return []
    const min = Math.min(...alive.map((x) => x.n))
    return alive
      .filter((x) => x.n === min)
      .map((x) => x.faction)
      .sort()
      .map((faction) => ({
        faction,
        amount: 3,
        event: { t: "grant" as const, source: "underdog", faction, amount: 3 },
      }))
  },
}
