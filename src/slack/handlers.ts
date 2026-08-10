import type { ApprovalStore, RosterStore } from "../store/types.js"
import {
  interpretMessage,
  interpretReaction,
  type DropReason,
  type MessageInput,
  type ReactionInput,
} from "./events.js"

export interface IngestDeps {
  store: ApprovalStore & RosterStore
  scope: { teamId: string; channelId: string }
  log: (msg: string) => void
}

export type IngestOutcome =
  | { kind: "post" | "delete" | "approve" | "unapprove" }
  | { kind: "duplicate" }
  | { kind: "drop"; reason: DropReason | "unknown-post" }

interface Envelope<E> {
  eventId: string
  teamId: string
  event: E
}

/**
 * The roster is read per event rather than cached at boot: adding a player
 * mid-season should not need a service restart, and the table has six rows.
 */
const scopeFor = (deps: IngestDeps) => ({
  teamId: deps.scope.teamId,
  channelId: deps.scope.channelId,
  roster: new Set(deps.store.roster().map((m) => m.slackUserId)),
})

/**
 * Dedupe first, and dedupe dropped events too. Slack redelivers up to three
 * times when an ack is slow, and re-running the scope checks on every retry
 * buys nothing.
 */
function seen(deps: IngestDeps, eventId: string): boolean {
  return !deps.store.markEventSeen(eventId, new Date())
}

export function handleMessageEvent(
  input: Envelope<MessageInput["event"]>,
  deps: IngestDeps,
): IngestOutcome {
  if (seen(deps, input.eventId)) return { kind: "duplicate" }

  const decision = interpretMessage({ teamId: input.teamId, event: input.event }, scopeFor(deps))
  if (decision.kind === "drop") return decision

  if (decision.kind === "delete") {
    deps.store.deletePost(decision.messageTs)
    return { kind: "delete" }
  }

  const factionId = deps.store.factionForSlackUser(decision.slackUserId)
  if (factionId === undefined) return { kind: "drop", reason: "not-on-roster" }

  deps.store.recordPost({ messageTs: decision.messageTs, factionId })
  deps.log(`post ${decision.messageTs} by ${factionId}`)
  return { kind: "post" }
}

export function handleReactionEvent(
  input: Envelope<ReactionInput["event"]>,
  deps: IngestDeps,
): IngestOutcome {
  if (seen(deps, input.eventId)) return { kind: "duplicate" }

  const decision = interpretReaction({ teamId: input.teamId, event: input.event }, scopeFor(deps))
  if (decision.kind === "drop") return decision

  // A reaction on ordinary channel chatter. Storing it would leave a row no
  // query reads.
  if (deps.store.postFor(decision.messageTs) === undefined) {
    return { kind: "drop", reason: "unknown-post" }
  }

  const factionId = deps.store.factionForSlackUser(decision.slackUserId)
  if (factionId === undefined) return { kind: "drop", reason: "not-on-roster" }

  if (decision.kind === "unapprove") {
    deps.store.removeApproval(decision.messageTs, factionId)
    deps.log(`unapprove ${decision.messageTs} by ${factionId}`)
    return { kind: "unapprove" }
  }

  deps.store.recordApproval({
    messageTs: decision.messageTs,
    factionId,
    reactedAt: decision.reactedAt,
  })
  deps.log(`approve ${decision.messageTs} by ${factionId}`)
  return { kind: "approve" }
}
