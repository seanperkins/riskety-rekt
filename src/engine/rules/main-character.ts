import type { Rule } from "../mechanics.js"

/**
 * The territory the most attacks target today is protected.
 *
 * This rule exists because `lock` receives ORDERS and `grant` does not — it is
 * the one hook that can react to what players declared this tick. Nobody knows
 * the day's most-wanted prize until the tick resolves, so piling on is its own
 * risk.
 *
 * Exactly one territory, so it DOES supply its `protected` event: one line in
 * the recap naming the prize that evaporated is the whole point. `byCount` is
 * the number of attacks that targeted it, which is the same shape the veto
 * uses for its own parity count.
 *
 * A day with no attacks locks nothing and logs nothing.
 */
export const mainCharacterRule: Rule = {
  id: "main-character",
  name: "Main Character Energy",
  description: "Today's most-attacked territory is protected. Fame has its perks.",
  lock(_state, orders) {
    const counts = new Map<string, number>()
    for (const o of orders) {
      for (const a of o.attacks) counts.set(a.to, (counts.get(a.to) ?? 0) + 1)
    }
    if (counts.size === 0) return []
    const most = Math.max(...counts.values())
    const territory = [...counts.entries()]
      .filter(([, n]) => n === most)
      .map(([t]) => t)
      .sort()[0]!
    return [{ territory, event: { t: "protected" as const, territory, byCount: most } }]
  },
}
