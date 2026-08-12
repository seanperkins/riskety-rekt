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
 * ADDITIVE ONLY. Leaving the channel does not remove a faction, because the
 * board is dealt from the roster at `season-init` and a faction that vanishes
 * mid-season would strand its territories with no owner. Removing someone is a
 * deliberate act, not a side effect of them muting a channel.
 */
export interface RosterSyncResult {
  added: { slackUserId: string; factionId: string; displayName: string }[]
  /** Already on the roster. Their display name is refreshed from Slack. */
  updated: { slackUserId: string; factionId: string; displayName: string }[]
  /** On the roster but no longer in the channel — reported, never removed. */
  absent: { slackUserId: string; factionId: string; displayName: string }[]
}

/**
 * A faction id from a display name: lowercase, ASCII, hyphen-separated.
 *
 * Readable ids matter more than they look. The id is what appears in the tick
 * log, in a rejection event and in `roster:list`, so `sean` beats `f3` every
 * time somebody has to read one at 21:05.
 */
export function factionIdFrom(displayName: string, taken: ReadonlySet<string>): string {
  const base =
    displayName
      .normalize("NFKD")
      // Strip combining marks, so "José" becomes "jose" rather than "jos".
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "player"
  if (!taken.has(base)) return base
  // Collisions are two people with the same display name, which is common
  // enough in a workspace that silently overwriting one would be a real bug.
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
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

  const result: RosterSyncResult = { added: [], updated: [], absent: [] }

  for (const m of members) {
    const already = byUser.get(m.userId)
    if (already !== undefined) {
      // Keep the faction id — it is baked into saved states and every log line
      // once a season has started. Only the display name follows Slack.
      if (already.displayName !== m.name) {
        result.updated.push({
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
    for (const m of [...result.added, ...result.updated]) {
      deps.store.addRosterMember({
        slackUserId: m.slackUserId,
        factionId: m.factionId,
        displayName: m.displayName,
      })
    }
  }

  for (const m of result.added) log(`+ ${m.factionId}\t${m.slackUserId}\t${m.displayName}`)
  for (const m of result.updated) log(`~ ${m.factionId}\t${m.slackUserId}\t${m.displayName}`)
  for (const m of result.absent) log(`? ${m.factionId}\t${m.slackUserId}\t${m.displayName} — not in the channel, left alone`)
  return result
}
