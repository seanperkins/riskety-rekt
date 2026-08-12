import type { Rule } from "../mechanics.js"

/** Attacks cost one extra troop per movement at departure — the one flat dial. */
export const attritionRule: Rule = {
  id: "attrition",
  name: "Attrition",
  description: "Attacks cost one extra troop today.",
  combatDials() {
    return { attackDepartureCost: 1 }
  },
}
