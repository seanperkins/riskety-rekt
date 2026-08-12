import { cmp } from "./sort.js"
import type { Mechanic, Rule } from "./mechanics.js"

/**
 * Validate a season's enabled-module list against the registry, at season-init
 * and again at every tick (the check is cheap, and a tick must never resolve
 * under a configuration season-init would have refused).
 *
 * The veto→irl dependency is HARDCODED, not a general `requires` field: a
 * declared-dependency subsystem for a single edge is machinery with one
 * consumer. Generalize the day a second dependency exists.
 */
export function validateModules(
  enabled: string[],
  registry: Map<string, Mechanic>,
): Mechanic[] {
  const seen = new Set<string>()
  for (const id of enabled) {
    if (seen.has(id)) throw new Error(`duplicate module id: ${id}`)
    seen.add(id)
    if (!registry.has(id)) throw new Error(`unknown module id: ${id}`)
  }
  if (seen.has("veto") && !seen.has("irl")) {
    throw new Error(
      "veto requires irl: with IRL off the veto would fire ungated for every eliminated faction, or vanish",
    )
  }
  const out = enabled.map((id) => registry.get(id)!).sort((a, b) => cmp(a.id, b.id))
  for (const x of out) {
    if (x.advance && !x.escrowed) {
      throw new Error(
        `${x.id} implements advance but not escrowed — the conservation invariant cannot see its soldiers`,
      )
    }
  }
  return out
}

/**
 * The rules half of the per-namespace check: every id the vote system can
 * select must be a registered RULE. A module id lands here as "unknown rule",
 * exactly as a rule id in season.modules lands in validateModules as
 * "unknown module" — the two registries are separate maps on purpose.
 */
export function validateRules(enabled: string[], registry: Map<string, Rule>): Rule[] {
  const seen = new Set<string>()
  for (const id of enabled) {
    if (seen.has(id)) throw new Error(`duplicate rule id: ${id}`)
    seen.add(id)
    if (!registry.has(id)) throw new Error(`unknown rule id: ${id}`)
  }
  const out = enabled.map((id) => registry.get(id)!).sort((a, b) => cmp(a.id, b.id))
  for (const x of out) {
    if (x.advance && !x.escrowed) {
      throw new Error(
        `${x.id} implements advance but not escrowed — the conservation invariant cannot see its soldiers`,
      )
    }
  }
  return out
}
