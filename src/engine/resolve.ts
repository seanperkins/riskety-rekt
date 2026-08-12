import { resolveCombat } from "./combat.js"
import { territoryIncome } from "./income.js"
import { MAX_DEPARTURE_COST, checkContribution, parseInstant, sortClaims } from "./mechanics.js"
import { MODULE_REGISTRY } from "./modules/index.js"
import { validateModules } from "./registry.js"
import { cmp } from "./sort.js"
import { ENGINE_VERSION } from "./types.js"
import { validateOrder } from "./validate.js"
import type { CombatDials, OwnedClaim } from "./mechanics.js"
import type {
  DailyContext,
  GameState,
  Order,
  TerritoryId,
  TickEvent,
} from "./types.js"

/**
 * The tick.
 *
 * 1 grant     core territory income, then every active grant hook, ONCE —
 *             settlement payouts live inside the markets module's grant
 * 2 claims    order-shape validation (core + module validate hooks), then the
 *             claim list: one core claim per deploy (lockedAt = tickInstant),
 *             plus every spend hook's claims
 * 3 allocate  ALL claims by ascending PARSED lockedAt (ties: mechanic id then
 *             index; core is ""); a claim that no longer fits DROPS with a
 *             rejected event; honored deploys LAND here
 * 4 locks     union of lock hooks; the engine logs each supplied event
 * 5+6 combat  movement validation against post-allocation garrisons, then
 *             field battles and attacks, parameterized by the merged dial
 * 7 advance   each module returns its next state value, seeing ITS OWN
 *             honored claims
 *
 * Why allocation precedes movement validation: attack and move caps derive
 * from post-deploy garrisons, so a deploy dropped after validation would
 * leave an attack legal for troops that never arrived — soldiers from
 * nothing. Seniority itself is the deploy-inflation fix: the commitment that
 * became irrevocable first is senior, so a 20:59 deploy can no longer evict
 * a wager locked at its market's close hours earlier.
 *
 * Pure: no I/O, no clock, no randomness. Time enters as ctx.tickInstant.
 */
export function resolve(state: GameState, orders: Order[], context: DailyContext): GameState {
  const day = state.day + 1
  const reserves = { ...state.reserves }
  const log: TickEvent[] = []
  const factionIds = state.factions.map((f) => f.id).sort()
  const factionSet: ReadonlySet<string> = new Set(factionIds)
  const active = validateModules(context.modules, MODULE_REGISTRY)

  // 1 — grant, once. Core income first, then hooks sorted by id (the registry
  // returns them sorted), so the log is deterministic.
  for (const f of factionIds) {
    const amount = territoryIncome(state, f)
    if (amount === 0) continue
    reserves[f] = (reserves[f] ?? 0) + amount
    log.push({ t: "income", faction: f, amount })
  }
  for (const m of active) {
    for (const c of m.grant?.(state, context) ?? []) {
      checkContribution(c, factionSet)
      reserves[c.faction] = (reserves[c.faction] ?? 0) + c.amount
      log.push(c.event)
    }
  }

  // 2 — claims. Shape and legality only; reserve budgeting belongs entirely
  // to the allocation, or a sequential check would preempt seniority.
  const working: GameState = { ...state, reserves }
  const clean: Order[] = []
  for (const o of [...orders].sort((a, b) => cmp(a.factionId, b.factionId))) {
    const { clean: shaped, rejections } = validateOrder(working, o, context)
    let c = shaped
    for (const m of active) {
      const rej = m.validate?.(working, c, context) ?? []
      if (rej.some((r) => r.t === "rejected" && r.field === "protect")) c = { ...c, protect: null }
      rejections.push(...rej)
    }
    clean.push(c)
    log.push(...rejections)
  }

  let coreIndex = 0
  const claims: OwnedClaim[] = []
  for (const o of clean) {
    for (const d of o.deploys) {
      claims.push({
        faction: o.factionId,
        amount: d.count,
        lockedAt: context.tickInstant,
        ref: `deploy:${d.territory}`,
        mechanicId: "",
        index: coreIndex++,
        event: { t: "deploy", faction: o.factionId, territory: d.territory, count: d.count },
      })
    }
  }
  for (const m of active) {
    ;(m.spend?.(working, clean, context) ?? []).forEach((s, i) => {
      checkContribution(s, factionSet)
      parseInstant(s.lockedAt) // an unparseable instant refuses the tick loudly
      claims.push({ ...s, mechanicId: m.id, index: i })
    })
  }

  // 3 — allocate. Honored deploys land in garrisons at this step's end,
  // which is what movement validation caps against.
  const honored: OwnedClaim[] = []
  const garrisons: Record<TerritoryId, number> = { ...state.garrisons }
  for (const c of sortClaims(claims)) {
    if (c.amount > (reserves[c.faction] ?? 0)) {
      log.push({
        t: "rejected",
        faction: c.faction,
        field: c.mechanicId === "" ? "deploys" : c.mechanicId === "markets" ? "wagers" : c.mechanicId,
        reason: "reserve short",
        ref: c.ref,
      })
      continue
    }
    reserves[c.faction] = (reserves[c.faction] ?? 0) - c.amount
    honored.push(c)
    if (c.event) log.push(c.event)
    if (c.mechanicId === "") {
      const territory = c.ref.slice("deploy:".length)
      garrisons[territory] = (garrisons[territory] ?? 0) + c.amount
    }
  }

  // 4 — locks: union across mechanics; idempotent; the engine logs each
  // first-seen territory's supplied event.
  const allocated: GameState = { ...state, garrisons, reserves }
  const locked = new Set<TerritoryId>()
  for (const m of active) {
    for (const r of m.lock?.(allocated, clean, context) ?? []) {
      if (!locked.has(r.territory) && r.event) log.push(r.event)
      locked.add(r.territory)
    }
  }

  // 5+6 — the merged dial, then movement validation and combat.
  const rawCost = active.reduce(
    (s, m) => s + (m.combatDials?.(allocated, context)?.attackDepartureCost ?? 0),
    0,
  )
  const dials: CombatDials = {
    attackDepartureCost: Math.min(MAX_DEPARTURE_COST, Math.max(0, rawCost)),
  }
  const combat = resolveCombat(allocated, clean, locked, dials)
  log.push(...combat.events)

  // 7 — advance: each module's next state, given ITS OWN honored claims.
  const moduleState: Record<string, unknown> = {}
  for (const m of active) {
    if (!m.advance) continue
    moduleState[m.id] = m.advance(
      state,
      clean,
      context,
      honored.filter((h) => h.mechanicId === m.id),
    )
  }

  for (const f of factionIds) {
    if ((reserves[f] ?? 0) < 0) {
      throw new Error(`engine invariant violated: reserve for ${f} is ${reserves[f]}`)
    }
  }

  return {
    ...state,
    day,
    ownership: combat.ownership,
    garrisons: combat.garrisons,
    reserves,
    moduleState,
    log,
    engineVersion: ENGINE_VERSION,
  }
}
