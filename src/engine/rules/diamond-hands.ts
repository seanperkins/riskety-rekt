import { pendingWagersOf } from "../modules/markets.js"
import { territoriesOf } from "../setup.js"
import type { Rule } from "../mechanics.js"

/**
 * Factions holding a live wager are paid a token troop.
 *
 * Reads the markets module's slot through `pendingWagersOf`, its own exported
 * helper — "owner-only access" means module code is the only code that
 * INTERPRETS the shape, and module code includes its exported helpers wherever
 * they are called from. This rule never touches `moduleState` directly.
 *
 * `needs: ["markets"]` keeps it off the ballot in a markets-off season, where
 * there are no wagers to hold.
 */
export const diamondHandsRule: Rule = {
  id: "diamond-hands",
  name: "Diamond Hands",
  description: "Everyone holding a live wager gains 1 troop. Paid for having the stomach.",
  needs: ["markets"],
  grant(state) {
    const holders = new Set(pendingWagersOf(state).map((w) => w.factionId))
    return state.factions
      .map((f) => f.id)
      .sort()
      .filter((faction) => holders.has(faction) && territoriesOf(state, faction).length > 0)
      .map((faction) => ({
        faction,
        amount: 1,
        event: { t: "grant" as const, source: "diamond-hands", faction, amount: 1 },
      }))
  },
}
