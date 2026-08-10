import { cmp } from "./sort.js"
import type { ApprovedAction, FactionId } from "./types.js"

export interface IrlGrant {
  actions: number
  bonus: number
}

/**
 * Convert a day's approved actions into per-faction soldier grants.
 *
 * Up to 2 actions count at +1 each. Two timing bonuses are available:
 * Early Bird for the first player to POST, Under the Wire for the last
 * approval before cutoff. Maximum one bonus per player — if one player holds
 * both ends they keep Early Bird and Under the Wire passes to the latest
 * different player.
 *
 * Early Bird keys on post time rather than approval time on purpose: keying on
 * approval would reward having friends awake rather than exercising early.
 *
 * All ordering falls back to eventId then playerId so ties are deterministic.
 */
export function irlGrants(approvals: ApprovedAction[]): Map<FactionId, IrlGrant> {
  const out = new Map<FactionId, IrlGrant>()
  if (approvals.length === 0) return out

  for (const a of approvals) {
    const g = out.get(a.playerId) ?? { actions: 0, bonus: 0 }
    g.actions = Math.min(2, g.actions + 1)
    out.set(a.playerId, g)
  }

  const byPost = [...approvals].sort(
    (x, y) => cmp(x.postedAt, y.postedAt) || cmp(x.eventId, y.eventId) || cmp(x.playerId, y.playerId),
  )
  const byApproval = [...approvals].sort(
    (x, y) => cmp(y.approvedAt, x.approvedAt) || cmp(y.eventId, x.eventId) || cmp(y.playerId, x.playerId),
  )

  const earlyBird = byPost[0]!.playerId
  out.get(earlyBird)!.bonus = 1

  const underWire = byApproval.find((a) => a.playerId !== earlyBird)
  if (underWire) out.get(underWire.playerId)!.bonus = 1

  return out
}
