import { territoriesOf } from "./setup.js"
import type { DailyContext, GameState, Order, TerritoryId, TickEvent } from "./types.js"

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0

/**
 * Sanitize a submitted order against the current state.
 *
 * Rejection is field-level: a bad line item is dropped and the rest of the order
 * stands. Whole-order rejection would be a griefing lever — a player could append
 * a deliberately malformed attack to void their own committed orders.
 *
 * Never throws on player data. System errors still propagate.
 */
export function validateOrder(
  state: GameState,
  order: Order,
  context: DailyContext,
): { clean: Order; rejections: TickEvent[] } {
  const f = order.factionId
  const rejections: TickEvent[] = []
  const reject = (field: string, reason: string) =>
    rejections.push({ t: "rejected", faction: f, field, reason })

  const byId = new Map(state.map.territories.map((t) => [t.id, t]))
  const reserve = state.reserves[f] ?? 0

  // Deploys: owned territory, valid count, aggregate <= reserve, applied in listed order.
  const deploys: Order["deploys"] = []
  let spent = 0
  for (const d of order.deploys) {
    if (!isCount(d.count) || d.count === 0) {
      reject("deploys", `bad count for ${d.territory}`)
      continue
    }
    if (state.ownership[d.territory] !== f) {
      reject("deploys", `does not own ${d.territory}`)
      continue
    }
    if (spent + d.count > reserve) {
      reject("deploys", `exceeds reserve at ${d.territory}`)
      continue
    }
    spent += d.count
    deploys.push(d)
  }

  // Post-deploy garrisons drive the per-origin attack cap, so the web app and the
  // engine agree for anyone deploying into a launch point.
  const postDeploy: Record<TerritoryId, number> = { ...state.garrisons }
  for (const d of deploys) postDeploy[d.territory] = (postDeploy[d.territory] ?? 0) + d.count

  // Moves: owned origin, owned adjacent target. They share the attacker's
  // per-origin cap through the same `committed` ledger, and validate FIRST --
  // when an origin is over-committed, the reinforcement survives and the
  // attack is what dies, because a rejected defence loses ground already held
  // while a rejected attack merely fails to gain some.
  const moves: NonNullable<Order["moves"]> = []
  const committed: Record<TerritoryId, number> = {}
  for (const m of order.moves ?? []) {
    if (!isCount(m.count) || m.count === 0) {
      reject("moves", `bad count ${m.from} -> ${m.to}`)
      continue
    }
    if (state.ownership[m.from] !== f) {
      reject("moves", `does not own ${m.from}`)
      continue
    }
    if (state.ownership[m.to] !== f) {
      reject("moves", `${m.to} is not yours to reinforce`)
      continue
    }
    if (!byId.get(m.from)?.neighbors.includes(m.to)) {
      reject("moves", `${m.to} is not adjacent to ${m.from}`)
      continue
    }
    const cap = Math.max(0, (postDeploy[m.from] ?? 0) - 1)
    const used = committed[m.from] ?? 0
    if (used + m.count > cap) {
      reject("moves", `exceeds garrison cap at ${m.from}`)
      continue
    }
    committed[m.from] = used + m.count
    moves.push(m)
  }

  // Attacks: owned origin, adjacent enemy target, aggregate per origin <= garrison - 1.
  const attacks: Order["attacks"] = []
  for (const a of order.attacks) {
    if (!isCount(a.count) || a.count === 0) {
      reject("attacks", `bad count ${a.from} -> ${a.to}`)
      continue
    }
    if (state.ownership[a.from] !== f) {
      reject("attacks", `does not own ${a.from}`)
      continue
    }
    if (state.ownership[a.to] === f) {
      reject("attacks", `${a.to} is friendly`)
      continue
    }
    if (!byId.get(a.from)?.neighbors.includes(a.to)) {
      reject("attacks", `${a.to} is not adjacent to ${a.from}`)
      continue
    }
    const cap = Math.max(0, (postDeploy[a.from] ?? 0) - 1)
    const used = committed[a.from] ?? 0
    if (used + a.count > cap) {
      reject("attacks", `exceeds garrison cap at ${a.from}`)
      continue
    }
    committed[a.from] = used + a.count
    attacks.push(a)
  }

  // Wagers: on today's slate, at most one per market, aggregate <= reserve - deploys.
  const wagers: Order["wagers"] = []
  const slate = new Map(context.slate.map((m) => [m.id, m]))
  const seen = new Set<string>()
  let staked = 0
  for (const w of order.wagers) {
    if (!isCount(w.stake) || w.stake === 0) {
      reject("wagers", `bad stake on ${w.marketId}`)
      continue
    }
    if (w.side !== "yes" && w.side !== "no") {
      reject("wagers", `bad side on ${w.marketId}`)
      continue
    }
    if (!slate.has(w.marketId)) {
      reject("wagers", `${w.marketId} is not on today's slate`)
      continue
    }
    if (seen.has(w.marketId)) {
      reject("wagers", `at most one wager per market (${w.marketId})`)
      continue
    }
    if (staked + w.stake > reserve - spent) {
      reject("wagers", `exceeds remaining reserve on ${w.marketId}`)
      continue
    }
    seen.add(w.marketId)
    staked += w.stake
    wagers.push(w)
  }

  // Protect: eliminated factions only, and a real territory.
  let protect = order.protect
  if (protect !== null) {
    if (territoriesOf(state, f).length > 0) {
      reject("protect", "faction is not eliminated")
      protect = null
    } else if (!byId.has(protect)) {
      reject("protect", `unknown territory ${protect}`)
      protect = null
    }
  }

  return { clean: { factionId: f, deploys, attacks, moves, wagers, protect }, rejections }
}
