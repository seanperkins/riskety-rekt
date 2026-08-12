import { territoriesOf } from "../setup.js"
import { cmp } from "../sort.js"
import type { LockResult, Mechanic } from "../mechanics.js"
import type { TerritoryId, TickEvent } from "../types.js"

export const vetoModule: Mechanic = {
  id: "veto",

  /**
   * Parity over eliminated posters — moved verbatim from combat's old 6a.
   * Both halves of the gate are load-bearing: eliminated, so a living faction
   * cannot claim a free veto while holding a full army; and POSTED, never
   * approved — an approval gate gives players a concrete reason to withhold
   * a reaction from someone whose veto they fear.
   */
  lock(state, orders, ctx): LockResult[] {
    const posted = new Set(ctx.postedToday)
    const picks: Record<TerritoryId, number> = {}
    for (const o of [...orders].sort((a, b) => cmp(a.factionId, b.factionId))) {
      if (o.protect && posted.has(o.factionId) && territoriesOf(state, o.factionId).length === 0) {
        picks[o.protect] = (picks[o.protect] ?? 0) + 1
      }
    }
    return Object.keys(picks)
      .sort()
      .filter((t) => picks[t]! % 2 === 1)
      .map((t) => ({
        territory: t,
        event: { t: "protected" as const, territory: t, byCount: picks[t]! },
      }))
  },

  /** Protect legality — moved from core validateOrder. */
  validate(state, order) {
    if (order.protect === null) return []
    const rejections: TickEvent[] = []
    if (territoriesOf(state, order.factionId).length > 0) {
      rejections.push({
        t: "rejected",
        faction: order.factionId,
        field: "protect",
        reason: "faction is not eliminated",
      })
    } else if (!state.map.territories.some((t) => t.id === order.protect)) {
      rejections.push({
        t: "rejected",
        faction: order.factionId,
        field: "protect",
        reason: `unknown territory ${order.protect}`,
      })
    }
    return rejections
  },
}
