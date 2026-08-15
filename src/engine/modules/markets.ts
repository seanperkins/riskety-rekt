import { escrow, settleAll } from "../wagers.js"
import type { Mechanic, ModuleStateValue, SpendClaim } from "../mechanics.js"
import type { GameState, MarketId, PendingWager } from "../types.js"

/**
 * Validating parser for this module's own slot — module code (including these
 * exported helpers) is the ONLY code that interprets the shape, wherever the
 * call happens to live. An absent slot is an empty book, not an error: a
 * fresh season and a markets-off season both look like that.
 */
export function marketsStateOf(state: GameState): { pending: PendingWager[] } {
  const own = state.moduleState["markets"]
  if (own === undefined || own === null) return { pending: [] }
  const p = (own as { pending?: unknown }).pending
  if (!Array.isArray(p)) {
    throw new Error("markets moduleState is corrupt: pending is not an array")
  }
  return { pending: p as PendingWager[] }
}

/** The job layer's settlement-lookup set, without interpreting the shape. */
export function marketIdsOf(state: GameState): Set<MarketId> {
  return new Set(marketsStateOf(state).pending.map((w) => w.marketId))
}

/** A read-only view for the simulator's settlement weighting (side/price). */
export function pendingWagersOf(state: GameState): readonly PendingWager[] {
  return marketsStateOf(state).pending
}

export const marketsModule: Mechanic = {
  id: "markets",

  // Step 1 — settlement payouts. Credit-only; the stake left at escrow. A
  // loss contributes amount 0 but its event still logs — the recap shows
  // losing wagers today and must keep doing so.
  grant(state, ctx) {
    const settled = settleAll(marketsStateOf(state).pending, ctx.settlements, state.day + 1)
    // The event carries its own faction now. This used to rebuild a wagerId ->
    // PendingWager map purely to recover it, which is also why the recap could
    // not name anyone.
    return settled.events.flatMap((e) =>
      e.t === "wagerSettle" ? [{ faction: e.faction, amount: e.payout, event: e }] : [],
    )
  },

  // Step 2 — one claim per validated wager. lockedAt is the market's slate
  // close: the commitment became irrevocable when the market closed, hours
  // before a deploy locks at the tick — that seniority is the whole fix for
  // the deploy-inflation exploit.
  spend(_state, orders, ctx) {
    const closes = new Map(ctx.slate.map((m) => [m.id, m.closeTime]))
    const claims: SpendClaim[] = []
    for (const o of orders) {
      for (const w of o.wagers) {
        claims.push({
          faction: o.factionId,
          amount: w.stake,
          lockedAt: closes.get(w.marketId)!,
          ref: `wager:${w.marketId}`,
        })
      }
    }
    return claims
  },

  // Step 7 — drop settled, keep unsettled, append THIS tick's honored escrow.
  // Only honored claims escrow: a wager dropped by the allocation must not
  // reach the pending book, or soldiers the reserve never gave up would
  // settle later as a payout.
  advance(state, orders, ctx, honored): ModuleStateValue {
    const day = state.day + 1
    const prior = marketsStateOf(state).pending
    const settled = settleAll(prior, ctx.settlements, day)
    const pending: PendingWager[] = [...settled.keep]
    const honoredRefs = new Set(honored.map((h) => `${h.faction}|${h.ref}`))
    for (const o of orders) {
      const kept = o.wagers.filter((w) => honoredRefs.has(`${o.factionId}|wager:${w.marketId}`))
      if (kept.length === 0) continue
      pending.push(...escrow({ ...o, wagers: kept }, ctx.slate, day, pending.length))
    }
    return { pending }
  },

  escrowed(own) {
    if (own === undefined || own === null) return 0
    const p = (own as { pending?: PendingWager[] }).pending ?? []
    return p.reduce((a, w) => a + w.stake, 0)
  },
}
