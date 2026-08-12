import { territoriesOf } from "../setup.js"
import type { Rule } from "../mechanics.js"

/**
 * Everyone except the leader(s) is paid.
 *
 * Expressed as "pay everyone else" rather than "tax the leader" because
 * `grant` cannot subtract — `Contribution.amount` is a non-negative integer.
 *
 * When every surviving faction is tied for the lead the payable set is empty
 * and the rule is a deliberate no-op: there is no leader to tax. That is not a
 * bug to fix by paying everyone — paying everyone is `bring-a-friend`.
 */
export const tributeRule: Rule = {
  id: "eat-the-rich",
  name: "Eat the Rich",
  description: "Everyone except the leader gains 2 troops. The leader gains perspective.",
  grant(state) {
    const alive = state.factions
      .map((f) => ({ faction: f.id, n: territoriesOf(state, f.id).length }))
      .filter((x) => x.n > 0)
    if (alive.length === 0) return []
    const max = Math.max(...alive.map((x) => x.n))
    return alive
      .filter((x) => x.n < max)
      .map((x) => x.faction)
      .sort()
      .map((faction) => ({
        faction,
        amount: 2,
        event: { t: "grant" as const, source: "eat-the-rich", faction, amount: 2 },
      }))
  },
}
