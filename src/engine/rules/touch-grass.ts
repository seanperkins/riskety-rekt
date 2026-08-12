import { territoriesOf } from "../setup.js"
import type { Rule } from "../mechanics.js"

/**
 * Factions that did not attack yesterday are paid.
 *
 * Keyed on the ATTACKER because that is the only side of a capture the log
 * attributes: an `attack` event carries `attacker` and `to`, but not who owned
 * `to`, and `state.ownership` is already post-capture. "Reward the faction
 * that LOST ground yesterday" is unimplementable for exactly that reason —
 * see the expansion design's cut list.
 *
 * `state.log` on entry is yesterday's log, from the tick that produced this
 * state. An empty log means day 1, so everyone qualifies. That is correct,
 * not an edge case to suppress.
 */
export const touchGrassRule: Rule = {
  id: "touch-grass",
  name: "Touch Grass",
  description: "Didn't attack yesterday? Gain 3 troops. Violence was never the answer.",
  grant(state) {
    const attacked = new Set(state.log.flatMap((e) => (e.t === "attack" ? [e.attacker] : [])))
    return state.factions
      .map((f) => f.id)
      .sort()
      .filter((faction) => !attacked.has(faction) && territoriesOf(state, faction).length > 0)
      .map((faction) => ({
        faction,
        amount: 3,
        event: { t: "grant" as const, source: "touch-grass", faction, amount: 3 },
      }))
  },
}
