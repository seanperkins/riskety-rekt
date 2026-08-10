import { resolveCombat } from "./combat.js"
import { territoryIncome } from "./income.js"
import { irlGrants } from "./irl.js"
import { ENGINE_VERSION } from "./types.js"
import { validateOrder } from "./validate.js"
import { escrow, settleAll } from "./wagers.js"
import type {
  DailyContext,
  FactionId,
  GameState,
  Order,
  PendingWager,
  TerritoryId,
  TickEvent,
} from "./types.js"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The seven-step tick.
 *
 * 1 settle matured wagers (credit only)   5 escrow new wagers
 * 2 grant approved IRL actions            6 protections, field battles, attacks
 * 3 grant territory income                7 season-end check (caller's job)
 * 4 apply deploys
 *
 * Orders are validated AFTER steps 1-3, because deploys and wagers draw from the
 * reserve as it stands at step 4 — income earned this tick is spendable this tick.
 *
 * Pure: no I/O, no clock, no randomness. The input state is never mutated.
 */
export function resolve(state: GameState, orders: Order[], context: DailyContext): GameState {
  const day = state.day + 1
  const reserves: Record<FactionId, number> = { ...state.reserves }
  const log: TickEvent[] = []
  const factionIds = state.factions.map((f) => f.id).sort()

  // 1 — settle matured wagers. Credit only; the stake left at escrow.
  const settled = settleAll(state.pending, context.settlements, day)
  for (const [f, amount] of [...settled.credits].sort((a, b) => cmp(a[0], b[0]))) {
    reserves[f] = (reserves[f] ?? 0) + amount
  }
  log.push(...settled.events)

  // 2 — IRL grants.
  const grants = irlGrants(context.approvals)
  for (const f of factionIds) {
    const g = grants.get(f)
    if (!g) continue
    reserves[f] = (reserves[f] ?? 0) + g.actions + g.bonus
    log.push({ t: "irl", faction: f, actions: g.actions, bonus: g.bonus })
  }

  // 3 — territory income. Eliminated factions earn nothing.
  for (const f of factionIds) {
    const amount = territoryIncome(state, f)
    if (amount === 0) continue
    reserves[f] = (reserves[f] ?? 0) + amount
    log.push({ t: "income", faction: f, amount })
  }

  // Validate against the post-income reserve.
  const working: GameState = { ...state, reserves }
  const clean: Order[] = []
  for (const o of [...orders].sort((a, b) => cmp(a.factionId, b.factionId))) {
    const { clean: c, rejections } = validateOrder(working, o, context)
    clean.push(c)
    log.push(...rejections)
  }

  // 4 — deploys.
  const garrisons: Record<TerritoryId, number> = { ...state.garrisons }
  for (const o of clean) {
    for (const d of o.deploys) {
      garrisons[d.territory] = (garrisons[d.territory] ?? 0) + d.count
      reserves[o.factionId] = (reserves[o.factionId] ?? 0) - d.count
      log.push({ t: "deploy", faction: o.factionId, territory: d.territory, count: d.count })
    }
  }

  // 5 — escrow new wagers.
  const pending: PendingWager[] = [...settled.keep]
  for (const o of clean) {
    const staked = o.wagers.reduce((s, w) => s + w.stake, 0)
    if (staked === 0) continue
    reserves[o.factionId] = (reserves[o.factionId] ?? 0) - staked
    pending.push(...escrow(o, context.slate, day, pending.length))
  }

  // 6 — combat, against the post-deploy garrisons.
  const combat = resolveCombat({ ...state, garrisons, reserves }, clean, context.postedToday)
  log.push(...combat.events)

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
    pending,
    log,
    engineVersion: ENGINE_VERSION,
  }
}
