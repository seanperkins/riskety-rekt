import { cmp } from "../sort.js"
import { MODULE_REGISTRY } from "../modules/index.js"
import { attritionRule } from "./attrition.js"
import { boomRule } from "./boom.js"
import { truceRule } from "./truce.js"
import type { Rule } from "../mechanics.js"

export { attritionRule, boomRule, truceRule }

/**
 * Engine-local: src/engine cannot import src/config, and this is a load-time
 * check on in-tree constants. Render sinks still cap and escape themselves.
 */
export const RULE_DESCRIPTION_MAX_CHARS = 100

/**
 * Validate the closed catalogue: unique ids, no collision with any module id
 * (the per-namespace claim), display fields present and bounded, every
 * `needs` entry a registered module. Throws at import — an unknown needs
 * refuses at catalogue load rather than silently filtering the rule out of
 * every offer forever.
 */
export function buildCatalogue(
  rules: readonly Rule[],
  moduleIds: ReadonlySet<string>,
): Map<string, Rule> {
  const out = new Map<string, Rule>()
  for (const r of rules) {
    if (out.has(r.id)) throw new Error(`duplicate rule id: ${r.id}`)
    if (moduleIds.has(r.id)) throw new Error(`rule id ${r.id} collides with a module id`)
    if (r.name.length === 0) throw new Error(`rule ${r.id} has an empty name`)
    if (r.description.length === 0 || r.description.length > RULE_DESCRIPTION_MAX_CHARS) {
      throw new Error(`rule ${r.id} description must be 1..${RULE_DESCRIPTION_MAX_CHARS} chars`)
    }
    for (const m of r.needs ?? []) {
      if (!moduleIds.has(m)) throw new Error(`rule ${r.id} needs unknown module ${m}`)
    }
    out.set(r.id, r)
  }
  return out
}

export const RULE_CATALOGUE: readonly Rule[] = [attritionRule, boomRule, truceRule]

export const RULE_REGISTRY: Map<string, Rule> = buildCatalogue(
  RULE_CATALOGUE,
  new Set(MODULE_REGISTRY.keys()),
)

/**
 * The daily draw's offer filter: a rule is offered only when every module it
 * needs is enabled. Display-side — the engine never checks `needs`.
 */
export function eligibleRules(
  modules: readonly string[],
  catalogue: ReadonlyMap<string, Rule> = RULE_REGISTRY,
): Rule[] {
  const on = new Set(modules)
  return [...catalogue.values()]
    .filter((r) => (r.needs ?? []).every((m) => on.has(m)))
    .sort((a, b) => cmp(a.id, b.id))
}
