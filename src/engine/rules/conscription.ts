import { territoriesOf } from "../setup.js"
import type { Rule } from "../mechanics.js"

/**
 * A flat payment to every surviving faction.
 *
 * Flat is the point: the same 3 troops are a larger relative gain for a
 * faction earning the 5-troop income floor than for one earning fifteen, so
 * the simplest possible rule leans mildly against the leader.
 */
export const conscriptionRule: Rule = {
  id: "bring-a-friend",
  name: "Bring a Friend",
  description: "Every surviving faction gains 3 troops. No cover charge, no guest pass.",
  grant(state) {
    return state.factions
      .map((f) => f.id)
      .sort()
      .filter((faction) => territoriesOf(state, faction).length > 0)
      .map((faction) => ({
        faction,
        amount: 3,
        event: { t: "grant" as const, source: "bring-a-friend", faction, amount: 3 },
      }))
  },
}
