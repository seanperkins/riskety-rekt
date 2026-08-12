import type { Rule } from "../mechanics.js"

/** Attacks cost one extra troop per movement at departure — the one flat dial. */
export const attritionRule: Rule = {
  // The id is frozen in tick_context history; only the display copy changed.
  id: "attrition",
  name: "Leg Day",
  description: "Attacks cost one extra troop today. Feel the burn.",
  combatDials() {
    return { attackDepartureCost: 1 }
  },
}
