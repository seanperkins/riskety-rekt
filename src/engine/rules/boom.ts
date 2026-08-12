import { territoryIncome } from "../income.js"
import type { Rule } from "../mechanics.js"

/**
 * Income doubled today: recompute core territory income from state (pure) and
 * grant it again. Logged as {t:"grant", source:"boom"} so the recap reads it
 * as the rule that caused it, not as ordinary income. Zero-income factions
 * are skipped, mirroring core income's own `amount === 0` skip.
 */
export const boomRule: Rule = {
  id: "boom",
  name: "Boom",
  description: "Territory income is doubled today.",
  grant(state) {
    return state.factions
      .map((f) => f.id)
      .sort()
      .flatMap((faction) => {
        const amount = territoryIncome(state, faction)
        if (amount === 0) return []
        return [
          { faction, amount, event: { t: "grant" as const, source: "boom", faction, amount } },
        ]
      })
  },
}
