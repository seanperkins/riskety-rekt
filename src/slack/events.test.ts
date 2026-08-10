import { describe, expect, it } from "vitest"
import { interpretMessage, interpretReaction, normalizeEmoji } from "./events.js"

const SCOPE = { teamId: "T1", channelId: "C1", roster: new Set(["U1", "U2", "U3"]) }

const photo = {
  teamId: "T1",
  event: {
    type: "message" as const,
    subtype: "file_share",
    channel: "C1",
    user: "U1",
    ts: "1723237200.000200",
    files: [{ mimetype: "image/jpeg" }],
  },
}

describe("normalizeEmoji", () => {
  it("collapses aliases and skin tones onto one name", () => {
    // These are four distinct strings in the API and one reaction to a player.
    for (const raw of ["+1", "thumbsup", "+1::skin-tone-3", "THUMBSUP"]) {
      expect(normalizeEmoji(raw)).toBe("+1")
    }
  })

  it("leaves an unrelated reaction alone", () => {
    expect(normalizeEmoji("tada")).toBe("tada")
    expect(normalizeEmoji("tada::skin-tone-2")).toBe("tada")
  })
})

describe("interpretMessage", () => {
  it("accepts a photo posted in the channel by a roster member", () => {
    expect(interpretMessage(photo, SCOPE)).toEqual({
      kind: "post",
      slackUserId: "U1",
      messageTs: "1723237200.000200",
    })
  })

  it("drops a message from another workspace", () => {
    // A shared channel can deliver events whose team_id is not ours.
    expect(interpretMessage({ ...photo, teamId: "T-EVIL" }, SCOPE)).toEqual({
      kind: "drop",
      reason: "wrong-team",
    })
  })

  it("drops a message from another channel", () => {
    const dm = { ...photo, event: { ...photo.event, channel: "D999" } }
    expect(interpretMessage(dm, SCOPE)).toEqual({ kind: "drop", reason: "wrong-channel" })
  })

  it("drops a message from a non-roster user", () => {
    const guest = { ...photo, event: { ...photo.event, user: "U404" } }
    expect(interpretMessage(guest, SCOPE)).toEqual({ kind: "drop", reason: "not-on-roster" })
  })

  it("drops a text-only message", () => {
    const chat = {
      teamId: "T1",
      event: { type: "message" as const, channel: "C1", user: "U1", ts: "1723237200.000200" },
    }
    expect(interpretMessage(chat, SCOPE)).toEqual({ kind: "drop", reason: "not-a-photo" })
  })

  it("drops a file share carrying no image", () => {
    const pdf = { ...photo, event: { ...photo.event, files: [{ mimetype: "application/pdf" }] } }
    expect(interpretMessage(pdf, SCOPE)).toEqual({ kind: "drop", reason: "not-a-photo" })
  })

  it("drops a photo posted inside a thread", () => {
    // Otherwise re-sharing yesterday's photo into a thread posts it again.
    const reply = { ...photo, event: { ...photo.event, thread_ts: "1723200000.000100" } }
    expect(interpretMessage(reply, SCOPE)).toEqual({ kind: "drop", reason: "thread-reply" })
  })

  it("accepts a photo that is its own thread parent", () => {
    const parent = { ...photo, event: { ...photo.event, thread_ts: photo.event.ts } }
    expect(interpretMessage(parent, SCOPE)).toMatchObject({ kind: "post" })
  })

  it("reads a deletion as a deletion, keyed on the deleted message", () => {
    const del = {
      teamId: "T1",
      event: {
        type: "message" as const,
        subtype: "message_deleted",
        channel: "C1",
        ts: "1723240000.000000",
        deleted_ts: "1723237200.000200",
      },
    }
    expect(interpretMessage(del, SCOPE)).toEqual({
      kind: "delete",
      messageTs: "1723237200.000200",
    })
  })

  it("drops a bot message", () => {
    // The bot must never post its way into the economy.
    const bot = { ...photo, event: { ...photo.event, subtype: "bot_message", bot_id: "B1" } }
    expect(interpretMessage(bot, SCOPE)).toEqual({ kind: "drop", reason: "not-a-photo" })
  })
})

describe("interpretReaction", () => {
  const reaction = {
    teamId: "T1",
    event: {
      type: "reaction_added" as const,
      user: "U2",
      reaction: "+1",
      item_user: "U1",
      item: { type: "message", channel: "C1", ts: "1723237200.000200" },
      event_ts: "1723237800.000100",
    },
  }

  it("accepts a thumbs-up from another roster member", () => {
    expect(interpretReaction(reaction, SCOPE)).toEqual({
      kind: "approve",
      slackUserId: "U2",
      messageTs: "1723237200.000200",
      reactedAt: "1723237800.000100",
    })
  })

  it("accepts a skin-toned thumbs-up", () => {
    const toned = { ...reaction, event: { ...reaction.event, reaction: "+1::skin-tone-5" } }
    expect(interpretReaction(toned, SCOPE)).toMatchObject({ kind: "approve" })
  })

  it("drops a self-approval", () => {
    const self = { ...reaction, event: { ...reaction.event, user: "U1" } }
    expect(interpretReaction(self, SCOPE)).toEqual({ kind: "drop", reason: "self-approval" })
  })

  it("drops a reaction that is not an approval", () => {
    const party = { ...reaction, event: { ...reaction.event, reaction: "tada" } }
    expect(interpretReaction(party, SCOPE)).toEqual({ kind: "drop", reason: "not-an-approval" })
  })

  it("drops a reaction in a DM", () => {
    // A 👍 in a DM counts for nothing.
    const dm = {
      ...reaction,
      event: { ...reaction.event, item: { type: "message", channel: "D9", ts: "1.0" } },
    }
    expect(interpretReaction(dm, SCOPE)).toEqual({ kind: "drop", reason: "wrong-channel" })
  })

  it("drops a reaction from a non-roster user", () => {
    const guest = { ...reaction, event: { ...reaction.event, user: "U404" } }
    expect(interpretReaction(guest, SCOPE)).toEqual({ kind: "drop", reason: "not-on-roster" })
  })

  it("drops a reaction on a non-message item", () => {
    const file = { ...reaction, event: { ...reaction.event, item: { type: "file" } } }
    expect(interpretReaction(file, SCOPE)).toEqual({ kind: "drop", reason: "not-a-message" })
  })

  it("reads a removal as an un-approval", () => {
    const removed = { ...reaction, event: { ...reaction.event, type: "reaction_removed" as const } }
    expect(interpretReaction(removed, SCOPE)).toEqual({
      kind: "unapprove",
      slackUserId: "U2",
      messageTs: "1723237200.000200",
    })
  })
})
