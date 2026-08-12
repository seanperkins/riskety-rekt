import { APPROVAL_EMOJI, EMOJI_ALIASES, NUMERAL_EMOJI } from "./config.js"

export interface Scope {
  teamId: string
  channelId: string
  /** Slack user ids on the roster. */
  roster: ReadonlySet<string>
}

export type DropReason =
  | "wrong-team"
  | "wrong-channel"
  | "not-on-roster"
  | "not-a-photo"
  | "thread-reply"
  | "not-a-message"
  | "not-an-approval"
  | "self-approval"
  | "not-an-offer"
  | "unmapped-numeral"

export type MessageDecision =
  | { kind: "post"; slackUserId: string; messageTs: string }
  | { kind: "delete"; messageTs: string }
  | { kind: "drop"; reason: DropReason }

export type ReactionDecision =
  | { kind: "approve"; slackUserId: string; messageTs: string; reactedAt: string }
  | { kind: "unapprove"; slackUserId: string; messageTs: string }
  | { kind: "vote"; slackUserId: string; messageTs: string; ordinal: number; reactedAt: string }
  | { kind: "unvote"; slackUserId: string; messageTs: string; ordinal: number }
  | { kind: "drop"; reason: DropReason }

/**
 * The fields the game reads off a `message` event.
 *
 * Structural and narrow rather than imported from @slack/types on purpose:
 * Slack's own MessageEvent is a seventeen-member union, and a handler written
 * against it spends its length narrowing. Everything is optional because
 * nothing here is trusted.
 */
export interface MessageInput {
  teamId: string
  event: {
    type: "message"
    subtype?: string
    channel?: string
    user?: string
    ts?: string
    thread_ts?: string
    deleted_ts?: string
    bot_id?: string
    files?: { mimetype?: string }[]
  }
}

export interface ReactionInput {
  teamId: string
  event: {
    type: "reaction_added" | "reaction_removed"
    user?: string
    reaction?: string
    item_user?: string
    item?: { type?: string; channel?: string; ts?: string }
    event_ts?: string
  }
}

/**
 * Collapse a Slack reaction name to its canonical form.
 *
 * `+1`, `thumbsup` and `+1::skin-tone-3` are three distinct strings in the API
 * and one reaction to a player. Comparing raw names means a player with a skin
 * tone set in their profile silently never approves anything.
 */
export function normalizeEmoji(name: string): string {
  const base = name.toLowerCase().split("::")[0] ?? ""
  return EMOJI_ALIASES[base] ?? base
}

export function interpretMessage(input: MessageInput, scope: Scope): MessageDecision {
  const { event } = input
  if (input.teamId !== scope.teamId) return { kind: "drop", reason: "wrong-team" }
  if (event.channel !== scope.channelId) return { kind: "drop", reason: "wrong-channel" }

  // A deletion is handled before the roster check: the post it names was
  // already proven to be ours when it was written, and the deletion event
  // carries no user field to check.
  if (event.subtype === "message_deleted") {
    if (event.deleted_ts === undefined) return { kind: "drop", reason: "not-a-photo" }
    return { kind: "delete", messageTs: event.deleted_ts }
  }

  if (event.subtype !== "file_share") return { kind: "drop", reason: "not-a-photo" }
  if (event.bot_id !== undefined) return { kind: "drop", reason: "not-a-photo" }

  const hasImage = (event.files ?? []).some((f) => f.mimetype?.startsWith("image/") === true)
  if (!hasImage) return { kind: "drop", reason: "not-a-photo" }

  // A photo re-shared into a thread would otherwise post yesterday's workout
  // again. A message that is its own thread parent is a normal top-level post.
  if (event.thread_ts !== undefined && event.thread_ts !== event.ts) {
    return { kind: "drop", reason: "thread-reply" }
  }

  if (event.user === undefined || !scope.roster.has(event.user)) {
    return { kind: "drop", reason: "not-on-roster" }
  }
  if (event.ts === undefined) return { kind: "drop", reason: "not-a-photo" }

  return { kind: "post", slackUserId: event.user, messageTs: event.ts }
}

export function interpretReaction(input: ReactionInput, scope: Scope): ReactionDecision {
  const { event } = input
  if (input.teamId !== scope.teamId) return { kind: "drop", reason: "wrong-team" }
  if (event.item?.type !== "message") return { kind: "drop", reason: "not-a-message" }
  if (event.item.channel !== scope.channelId) return { kind: "drop", reason: "wrong-channel" }

  // The vote branch. Sits BEFORE the approval-emoji filter, which would drop
  // every numeral. It does its own roster check (the shipped gate order puts
  // roster after the emoji filter) and skips the self-approval check on
  // purpose: the offer message is bot-authored, so item_user is never a
  // player — stated so nobody re-adds it.
  const numeral =
    event.reaction === undefined ? undefined : NUMERAL_EMOJI[normalizeEmoji(event.reaction)]
  if (numeral !== undefined) {
    if (event.user === undefined || !scope.roster.has(event.user)) {
      return { kind: "drop", reason: "not-on-roster" }
    }
    if (event.item.ts === undefined) return { kind: "drop", reason: "not-a-message" }
    if (event.type === "reaction_removed") {
      return { kind: "unvote", slackUserId: event.user, messageTs: event.item.ts, ordinal: numeral }
    }
    if (event.event_ts === undefined) return { kind: "drop", reason: "not-a-message" }
    return {
      kind: "vote",
      slackUserId: event.user,
      messageTs: event.item.ts,
      ordinal: numeral,
      reactedAt: event.event_ts,
    }
  }

  if (event.reaction === undefined || !APPROVAL_EMOJI.has(normalizeEmoji(event.reaction))) {
    return { kind: "drop", reason: "not-an-approval" }
  }
  if (event.user === undefined || !scope.roster.has(event.user)) {
    return { kind: "drop", reason: "not-on-roster" }
  }
  // "Two distinct OTHER players." Checked again in SQL when approvals are
  // derived, because an alt account added to the roster later would otherwise
  // leave a self-approval already written to disk.
  if (event.user === event.item_user) return { kind: "drop", reason: "self-approval" }
  if (event.item.ts === undefined) return { kind: "drop", reason: "not-a-message" }

  if (event.type === "reaction_removed") {
    return { kind: "unapprove", slackUserId: event.user, messageTs: event.item.ts }
  }
  if (event.event_ts === undefined) return { kind: "drop", reason: "not-a-message" }
  return {
    kind: "approve",
    slackUserId: event.user,
    messageTs: event.item.ts,
    reactedAt: event.event_ts,
  }
}
