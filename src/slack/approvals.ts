import type { ApprovedAction, FactionId } from "../engine/index.js"
import type { ApprovalStore, SlateStore } from "../store/types.js"
import { etDateAdd, etInstant } from "../time.js"
import { TICK_HOUR } from "./config.js"

export interface DailyIrl {
  approvals: ApprovedAction[]
  postedToday: FactionId[]
}

/**
 * Everything the IRL channel contributes to one tick's DailyContext.
 *
 * Two lists rather than one because the two mechanics gate differently: the +1
 * soldier needs two distinct other players to react, while the elimination veto
 * needs only that the player showed up. See the spec's "Approval is social, not
 * adversarial".
 *
 * Both are filtered by Slack timestamps, never by database write time. A
 * reaction at 20:59:59 delivered at 21:00:01 must still count, or an eliminated
 * player's veto silently evaporates.
 */
export function dailyApprovals(
  store: ApprovalStore & SlateStore,
  seasonId: string,
  day: number,
): DailyIrl {
  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`dailyApprovals: unknown season ${seasonId}`)

  const date = etDateAdd(season.startDate, day)
  const cutoff = etInstant(date, TICK_HOUR).toISOString()

  const posts = store.postsOn(date).filter((p) => p.postedAt <= cutoff)

  const approvals: ApprovedAction[] = []
  for (const post of posts) {
    const approvers = store
      .approversOf(post.messageTs)
      // "Two distinct OTHER players." interpretReaction drops a self-approval
      // at ingest; this is the second gate, for a row written before an alt
      // account was mapped onto the poster's faction.
      .filter((a) => a.factionId !== post.factionId && a.reactedAt <= cutoff)

    const second = approvers[1]
    if (second === undefined) continue

    approvals.push({
      // The post's own ts. Unique per action and stable, where a reaction's
      // event_ts moves whenever an approval is removed and re-added.
      eventId: post.messageTs,
      playerId: post.factionId,
      postedAt: post.postedAt,
      approvedAt: second.reactedAt,
    })
  }

  // postsOn already orders by posted_at then message_ts, and approvals follows
  // that order. postedToday is a set, so it is sorted independently.
  const postedToday = [...new Set(posts.map((p) => p.factionId))].sort()

  return { approvals, postedToday }
}
