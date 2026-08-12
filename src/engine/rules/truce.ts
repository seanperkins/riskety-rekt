import type { Rule } from "../mechanics.js"

/**
 * No attacks land today. Locks gate attacks only — moves and deploys still
 * run, and the description says "attacks" so the recap never promises that
 * nothing moved. Deliberately NO per-territory events: a whole-map lock would
 * bury the log under one protected line per territory; the recap names the
 * rule itself.
 */
export const truceRule: Rule = {
  id: "truce",
  name: "Truce",
  description: "No attacks land today. Moves and deploys still run.",
  lock(state) {
    return state.map.territories.map((t) => ({ territory: t.id }))
  },
}
