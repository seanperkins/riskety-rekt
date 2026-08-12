import type { DailyContext, GameState, Order, TickEvent } from "./types.js"

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0

/**
 * Sanitize a submitted order's SHAPE and LEGALITY against the current state.
 *
 * Rejection is field-level: a bad line item is dropped and the rest of the
 * order stands. Whole-order rejection would be a griefing lever — a player
 * could append a deliberately malformed attack to void their own orders.
 *
 * What does NOT live here anymore, and where it went:
 * - reserve budgeting (deploys and wagers) → the allocation phase, which
 *   honors claims by lockedAt seniority; a sequential check here would
 *   preempt cross-mechanic ordering and reopen the deploy-inflation exploit
 * - move/attack garrison caps → combat's movement validation, which runs
 *   against POST-ALLOCATION garrisons and merges duplicate attack directions
 *   before capping (a dropped deploy must shrink the cap it fed)
 * - protect legality → the veto module's validate hook
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

  // Deploys: owned territory, valid count.
  const deploys: Order["deploys"] = []
  for (const d of order.deploys) {
    if (!isCount(d.count) || d.count === 0) {
      reject("deploys", `bad count for ${d.territory}`)
      continue
    }
    if (state.ownership[d.territory] !== f) {
      reject("deploys", `does not own ${d.territory}`)
      continue
    }
    deploys.push(d)
  }

  // Moves: owned origin, owned adjacent target.
  const moves: NonNullable<Order["moves"]> = []
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
    moves.push(m)
  }

  // Attacks: owned origin, adjacent enemy target.
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
    attacks.push(a)
  }

  // Wagers: on today's slate, at most one per market, valid stake and side.
  // A markets-off season has an empty slate, so every wager rejects here —
  // the web layer refuses them upstream with a clearer reason.
  const wagers: Order["wagers"] = []
  const slate = new Map(context.slate.map((m) => [m.id, m]))
  const seen = new Set<string>()
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
    seen.add(w.marketId)
    wagers.push(w)
  }

  return { clean: { factionId: f, deploys, attacks, moves, wagers, protect: order.protect }, rejections }
}
