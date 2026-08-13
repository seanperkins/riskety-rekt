import { factionIdFrom } from "../roster.js"
import type { Directory } from "../slack/post.js"
import type { RosterStore } from "../store/types.js"

/**
 * Build the roster from who is in the game channel.
 *
 * Everyone joins the channel; this reads it. That is one instruction to send
 * friends instead of collecting ten opaque `U0…` ids by hand, and it is the
 * difference between a roster that is right and a roster that is right except
 * for the person whose id got pasted twice.
 *
 * ADDITIVE ONLY, in both directions. Leaving the channel does not remove a
 * faction, because the board is dealt from the roster at `season-init` and a
 * faction that vanishes mid-season would strand its territories with no owner.
 * Removing someone is a deliberate act, not a side effect of them muting a
 * channel.
 *
 * And a display name that already exists is REPORTED, never rewritten. It used
 * to follow Slack, which was right while Slack was the only place a name could
 * come from — but a player can now set their own with `/name` or from the
 * board, and that is the more specific intent. Overwriting it would revert
 * every self-chosen name the next time an operator ran this, silently, and the
 * operator would have no reason to suspect it. The same protection covers a
 * name an operator set by hand with `roster:add`.
 */
export interface RosterSyncResult {
  added: { slackUserId: string; factionId: string; displayName: string }[]
  /**
   * Already on the roster, under a different name in Slack. REPORTED ONLY —
   * nothing here is written, whatever `apply` says. `displayName` is the Slack
   * name that was NOT adopted, so the report can show the operator the drift.
   */
  unchanged: { slackUserId: string; factionId: string; displayName: string }[]
  /** On the roster but no longer in the channel — reported, never removed. */
  absent: { slackUserId: string; factionId: string; displayName: string }[]
}

export async function runRosterSync(deps: {
  store: RosterStore
  directory: Directory
  channelId: string
  /** Report only. Nothing is written unless this is true. */
  apply: boolean
  log?: (msg: string) => void
}): Promise<RosterSyncResult> {
  const log = deps.log ?? (() => {})
  const members = await deps.directory.membersOf(deps.channelId)

  const existing = deps.store.roster()
  const byUser = new Map(existing.map((m) => [m.slackUserId, m]))
  const taken = new Set(existing.map((m) => m.factionId))
  const inChannel = new Set(members.map((m) => m.userId))

  const result: RosterSyncResult = { added: [], unchanged: [], absent: [] }

  for (const m of members) {
    const already = byUser.get(m.userId)
    if (already !== undefined) {
      // Neither field follows Slack once the member exists. The faction id is
      // baked into saved states and every log line, and the display name may
      // have been chosen deliberately — by the player with `/name`, or by an
      // operator with `roster:add`.
      if (already.displayName !== m.name) {
        result.unchanged.push({
          slackUserId: m.userId,
          factionId: already.factionId,
          displayName: m.name,
        })
      }
      continue
    }
    const factionId = factionIdFrom(m.name, taken)
    taken.add(factionId)
    result.added.push({ slackUserId: m.userId, factionId, displayName: m.name })
  }

  for (const m of existing) {
    if (!inChannel.has(m.slackUserId)) result.absent.push({ ...m })
  }

  if (deps.apply) {
    // `added` only. `unchanged` is a report, and writing it here is exactly the
    // regression this function is shaped to prevent.
    for (const m of result.added) {
      deps.store.addRosterMember({
        slackUserId: m.slackUserId,
        factionId: m.factionId,
        displayName: m.displayName,
      })
    }
  }

  for (const m of result.added) log(`+ ${m.factionId}\t${m.slackUserId}\t${m.displayName}`)
  for (const m of result.unchanged) {
    log(`= ${m.factionId}\t${m.slackUserId}\tSlack says "${m.displayName}" — kept the roster's, not written`)
  }
  for (const m of result.absent) log(`? ${m.factionId}\t${m.slackUserId}\t${m.displayName} — not in the channel, left alone`)
  return result
}
