import type { Rule } from "../mechanics.js"

/**
 * No attacks land today. Locks gate attacks only — moves and deploys still
 * run, and the description says "attacks" so the recap never promises that
 * nothing moved. Deliberately NO per-territory events: a whole-map lock would
 * bury the log under one protected line per territory; the recap names the
 * rule itself.
 */
export const truceRule: Rule = {
  // The id is frozen in tick_context history; only the display copy changed.
  // "Moves and deploys still run" is load-bearing copy, not filler: locks gate
  // attacks only, and the recap must never promise that nothing moved.
  id: "truce",
  name: "Log Off",
  description: "No attacks land today. Moves and deploys still run. Go outside.",
  lock(state) {
    return state.map.territories.map((t) => ({ territory: t.id }))
  },
}
