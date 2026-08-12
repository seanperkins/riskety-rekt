import { territoriesOf } from "../setup.js"
import { cmp } from "../sort.js"
import type { Rule } from "../mechanics.js"

/**
 * Each faction's single largest garrison is locked.
 *
 * Symmetric by construction — every surviving faction gets exactly one
 * protected territory, so the rule adds a defensive beat without favouring
 * anyone's position. Ties within a faction break on territory id.
 *
 * No per-territory events: with a full roster this locks one territory per
 * faction, and the recap naming the rule reads better than a list.
 */
export const fortressRule: Rule = {
  id: "too-big-to-fail",
  name: "Too Big to Fail",
  description: "Every faction's largest garrison is untouchable. Systemically important troops.",
  lock(state) {
    const out: { territory: string }[] = []
    for (const f of state.factions.map((x) => x.id).sort()) {
      const mine = territoriesOf(state, f)
      if (mine.length === 0) continue
      const best = [...mine].sort(
        (a, b) => (state.garrisons[b] ?? 0) - (state.garrisons[a] ?? 0) || cmp(a, b),
      )[0]!
      out.push({ territory: best })
    }
    return out
  },
}
