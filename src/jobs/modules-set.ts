import { MODULE_REGISTRY } from "../engine/modules/index.js"
import { validateModules } from "../engine/registry.js"
import type { SeasonStore, StateStore, Transactional } from "../store/types.js"

export type ModulesSetOutcome =
  | { status: "applied"; modules: string[] }
  | { status: "refused"; reason: string }

export interface ModulesSetDeps {
  store: SeasonStore & StateStore & Transactional
  seasonId: string
  modules: string[]
  log?: (msg: string) => void
}

/**
 * The operator's mid-season module change. Applied between ticks, recorded in
 * each subsequent day's frozen context, never retroactive.
 *
 * Disabling a module is REFUSED while its escrow is non-zero — a config change
 * must not orphan escrowed soldiers in state no active module owns. The gate is
 * `escrowed(own) > 0`, not slot presence: markets' slot is `{pending: []}` even
 * when idle, and refusing on that would refuse forever. A permitted disable
 * needs no slot surgery — the engine rebuilds `moduleState` from active modules
 * every tick, so a disabled module's stale slot drops at the next tick and a
 * re-enable starts the module fresh.
 */
export function runModulesSet(deps: ModulesSetDeps): ModulesSetOutcome {
  const { store, seasonId, modules } = deps
  const log = deps.log ?? (() => {})

  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`modules-set: unknown season ${seasonId}`)

  try {
    validateModules(modules, MODULE_REGISTRY)
  } catch (err) {
    return { status: "refused", reason: err instanceof Error ? err.message : String(err) }
  }

  return store.transaction((): ModulesSetOutcome => {
    const latestDay = store.latestSavedDay(seasonId)
    const latest = latestDay === undefined ? undefined : store.loadState(seasonId, latestDay)
    const next = new Set(modules)
    const current = season.modules ?? ["markets", "irl", "veto"]
    for (const id of current) {
      if (next.has(id)) continue
      const m = MODULE_REGISTRY.get(id)
      const escrow = latest && m?.escrowed ? m.escrowed(latest.moduleState[id]) : 0
      if (escrow > 0) {
        return {
          status: "refused",
          reason: `${id} holds ${escrow} escrowed soldier(s); disabling would orphan them`,
        }
      }
    }
    store.setSeasonModules(seasonId, modules)
    log(`season ${seasonId} modules set to [${modules.join(", ")}]`)
    return { status: "applied", modules }
  })
}
