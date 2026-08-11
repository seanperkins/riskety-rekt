import type {
  FactionId,
  Market,
  Order,
  PendingWager,
  Settlement,
  TickEvent,
} from "./types.js"

export const HOUSE_BONUS = 1.1
export const REFUND_AFTER_TICKS = 2
export const PRICE_FLOOR = 0.1
export const PRICE_CEIL = 0.9

/**
 * Winning payout for a stake at a snapshotted price.
 *
 * round(), not floor(): under floor() the intended +10% edge only existed for
 * stakes above 10p, making small hedge bets negative-EV — worst case about
 * -45% of stake just above p = 0.55.
 *
 * The clamp matches the slate's own price filter, so it can only fire on a
 * filter bug, and caps the damage at 11x rather than something unbounded.
 */
export function payout(stake: number, price: number): number {
  const p = Math.min(PRICE_CEIL, Math.max(PRICE_FLOOR, price))
  return Math.round((stake / p) * HOUSE_BONUS)
}

/**
 * Move validated wagers into escrow.
 *
 * Price comes from the WAGER when it carries one — the price at the moment it
 * was placed — and from the slate otherwise. The slate is the 08:00 snapshot,
 * so using it for a wager placed at 20:59 is what made late betting on a
 * nearly-decided market worth roughly +94% EV.
 */
export function escrow(order: Order, slate: Market[], day: number, seq: number): PendingWager[] {
  const byId = new Map(slate.map((m) => [m.id, m]))
  return order.wagers.map((w, i) => {
    const m = byId.get(w.marketId)!
    return {
      wagerId: `${day}-${order.factionId}-${seq + i}`,
      factionId: order.factionId,
      marketId: w.marketId,
      side: w.side,
      stake: w.stake,
      price: w.price ?? (w.side === "yes" ? m.priceYes : m.priceNo),
      placedOnDay: day,
    }
  })
}

/**
 * Settle every matured pending wager. Credit-only.
 *
 * The stake already left the reserve at escrow and a loss returns nothing, so
 * there is nothing to debit here — treating this as "credit or debit" would
 * charge losers twice and drive reserves negative.
 *
 * Maturity is counted in ticks, not wall-clock hours, so a DST transition
 * cannot shift the refund boundary.
 */
export function settleAll(
  pending: PendingWager[],
  settlements: Record<string, Settlement>,
  today: number,
): { keep: PendingWager[]; credits: Map<FactionId, number>; events: TickEvent[] } {
  const keep: PendingWager[] = []
  const credits = new Map<FactionId, number>()
  const events: TickEvent[] = []
  const credit = (f: FactionId, n: number) => credits.set(f, (credits.get(f) ?? 0) + n)

  for (const w of [...pending].sort((a, b) => (a.wagerId < b.wagerId ? -1 : a.wagerId > b.wagerId ? 1 : 0))) {
    const outcome = settlements[w.marketId] ?? "unsettled"

    if (outcome === "unsettled") {
      if (today - w.placedOnDay >= REFUND_AFTER_TICKS) {
        credit(w.factionId, w.stake)
        events.push({ t: "wagerSettle", wagerId: w.wagerId, outcome, payout: w.stake })
      } else {
        keep.push(w)
      }
      continue
    }

    const amount = outcome === w.side ? payout(w.stake, w.price) : 0
    if (amount > 0) credit(w.factionId, amount)
    events.push({ t: "wagerSettle", wagerId: w.wagerId, outcome, payout: amount })
  }

  return { keep, credits, events }
}
