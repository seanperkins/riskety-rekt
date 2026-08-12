import type { Rule } from "../mechanics.js"

/**
 * Territories holding exactly one troop cannot be attacked.
 *
 * THE TIMING IS DELIBERATE. `lock` runs at pipeline step 4, AFTER allocation,
 * so the garrisons read here already include today's landed deploys. A player
 * who reinforces a one-troop territory therefore FORFEITS its protection, and
 * a player who wants the protection must leave it alone. That is the rule's
 * central decision, not an ordering accident — do not "fix" it by reading
 * pre-allocation garrisons.
 *
 * No per-territory events: a busy map can hold dozens of one-troop
 * territories, and burying the log is exactly why LockResult.event is
 * optional. The recap names the rule instead.
 */
export const soleSurvivorRule: Rule = {
  id: "sole-survivor",
  name: "Sole Survivor",
  description: "A territory down to exactly one troop cannot be attacked. Have a heart.",
  lock(state) {
    return Object.keys(state.garrisons)
      .sort()
      .filter((t) => state.garrisons[t] === 1)
      .map((territory) => ({ territory }))
  },
}
