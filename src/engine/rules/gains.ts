import { territoriesOf } from "../setup.js"
import type { Rule } from "../mechanics.js"

/**
 * Factions that posted a workout today are paid, on top of the IRL module's
 * own grant.
 *
 * The first consumer of `needs`. With `irl` disabled this rule is never
 * OFFERED — the daily draw filters it out — rather than offered and silently
 * inert, which is the whole point of the offer filter: the vote can never
 * select a rule the season cannot honor.
 *
 * Keyed on `postedToday` (posting), not on approvals, so it pays the act
 * rather than the popularity contest.
 */
export const gainsRule: Rule = {
  id: "gains",
  name: "Gains",
  description: "Posted a workout? Gain 2 troops. Actual gains, for once.",
  needs: ["irl"],
  grant(state, ctx) {
    const posted = new Set(ctx.postedToday)
    return state.factions
      .map((f) => f.id)
      .sort()
      .filter((faction) => posted.has(faction) && territoriesOf(state, faction).length > 0)
      .map((faction) => ({
        faction,
        amount: 2,
        event: { t: "grant" as const, source: "gains", faction, amount: 2 },
      }))
  },
}
