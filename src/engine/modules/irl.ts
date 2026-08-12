import { irlGrants } from "../irl.js"
import { cmp } from "../sort.js"
import type { Mechanic } from "../mechanics.js"

export const irlModule: Mechanic = {
  id: "irl",

  grant(_state, ctx) {
    return [...irlGrants(ctx.approvals)]
      .sort(([a], [b]) => cmp(a, b))
      .map(([faction, g]) => ({
        faction,
        amount: g.actions + g.bonus,
        event: { t: "irl" as const, faction, actions: g.actions, bonus: g.bonus },
      }))
  },
}
