import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { dailyApprovals } from "./approvals.js"
import { handleMessageEvent, handleReactionEvent } from "./handlers.js"

const ts = (hour: number, minute: number, seq = 1) =>
  `${Date.UTC(2026, 7, 9, hour + 4, minute) / 1000}.${String(seq).padStart(6, "0")}`

function deps() {
  const store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-08-06", lengthDays: 21 })
  for (const [u, f, n] of [
    ["U1", "f1", "Ada"],
    ["U2", "f2", "Bex"],
    ["U3", "f3", "Cy"],
  ] as const) {
    store.addRosterMember({ slackUserId: u, factionId: f, displayName: n })
  }
  return { store, scope: { teamId: "T1", channelId: "C1" }, log: () => {} }
}

const photo = (user: string, at: string) => ({
  eventId: `Ev-${user}-${at}`,
  teamId: "T1",
  event: {
    type: "message" as const,
    subtype: "file_share",
    channel: "C1",
    user,
    ts: at,
    files: [{ mimetype: "image/png" }],
  },
})

const thumbsUp = (user: string, post: string, at: string) => ({
  eventId: `Ev-${user}-${at}`,
  teamId: "T1",
  event: {
    type: "reaction_added" as const,
    user,
    reaction: "+1",
    item_user: "U1",
    item: { type: "message", channel: "C1", ts: post },
    event_ts: at,
  },
})

describe("ingest handlers", () => {
  it("turns a photo and two reactions into one approved action", () => {
    const d = deps()
    const post = ts(7, 0)
    handleMessageEvent(photo("U1", post), d)
    handleReactionEvent(thumbsUp("U2", post, ts(8, 0)), d)
    handleReactionEvent(thumbsUp("U3", post, ts(9, 0)), d)

    const out = dailyApprovals(d.store, "s1", 3)
    expect(out.approvals).toHaveLength(1)
    expect(out.approvals[0]!.playerId).toBe("f1")
    expect(out.postedToday).toEqual(["f1"])
    d.store.close()
  })

  it("ignores a redelivered reaction", () => {
    // Slack retries with the same event_id when the ack is slow. Two deliveries
    // of one reaction must not become two approvers.
    const d = deps()
    const post = ts(7, 0)
    handleMessageEvent(photo("U1", post), d)
    const retry = thumbsUp("U2", post, ts(8, 0))
    expect(handleReactionEvent(retry, d)).toEqual({ kind: "approve" })
    expect(handleReactionEvent(retry, d)).toEqual({ kind: "duplicate" })
    expect(d.store.approversOf(post)).toHaveLength(1)
    d.store.close()
  })

  it("un-approves on reaction_removed", () => {
    const d = deps()
    const post = ts(7, 0)
    handleMessageEvent(photo("U1", post), d)
    handleReactionEvent(thumbsUp("U2", post, ts(8, 0)), d)
    handleReactionEvent(thumbsUp("U3", post, ts(9, 0)), d)
    expect(dailyApprovals(d.store, "s1", 3).approvals).toHaveLength(1)

    const removal = thumbsUp("U3", post, ts(10, 0))
    handleReactionEvent(
      { ...removal, eventId: "Ev-remove", event: { ...removal.event, type: "reaction_removed" } },
      d,
    )
    expect(dailyApprovals(d.store, "s1", 3).approvals).toEqual([])
    d.store.close()
  })

  it("retracts an action when the photo is deleted", () => {
    const d = deps()
    const post = ts(7, 0)
    handleMessageEvent(photo("U1", post), d)
    handleReactionEvent(thumbsUp("U2", post, ts(8, 0)), d)
    handleReactionEvent(thumbsUp("U3", post, ts(9, 0)), d)

    handleMessageEvent(
      {
        eventId: "Ev-del",
        teamId: "T1",
        event: {
          type: "message" as const,
          subtype: "message_deleted",
          channel: "C1",
          ts: ts(11, 0),
          deleted_ts: post,
        },
      },
      d,
    )
    expect(dailyApprovals(d.store, "s1", 3)).toEqual({ approvals: [], postedToday: [] })
    d.store.close()
  })

  it("writes nothing for a dropped event but still marks it seen", () => {
    // Marking a dropped event seen is what stops three retries of the same DM
    // from re-running the scope checks all day.
    const d = deps()
    const dm = photo("U1", ts(7, 0))
    const out = handleMessageEvent({ ...dm, event: { ...dm.event, channel: "D9" } }, d)
    expect(out).toEqual({ kind: "drop", reason: "wrong-channel" })
    expect(d.store.markEventSeen(dm.eventId, new Date())).toBe(false)
    d.store.close()
  })

  it("drops a reaction on a post it never recorded", () => {
    // A 👍 on ordinary channel chatter. Storing it would leave an orphan row
    // that no query reads and every debugging session trips over.
    const d = deps()
    expect(handleReactionEvent(thumbsUp("U2", ts(7, 0), ts(8, 0)), d)).toEqual({
      kind: "drop",
      reason: "unknown-post",
    })
    d.store.close()
  })
})

const numeral = (user: string, name: string, offerTs: string, at: string) => ({
  eventId: `Ev-${user}-${name}-${at}`,
  teamId: "T1",
  event: {
    type: "reaction_added" as const,
    user,
    reaction: name,
    item_user: "UBOT",
    item: { type: "message", channel: "C1", ts: offerTs },
    event_ts: at,
  },
})

describe("the vote branch through both gates", () => {
  const OFFER_TS = ts(8, 5)

  const withOffer = () => {
    const d = deps()
    d.store.claimRuleOffers("s1", 3, ["boom", "truce", "attrition"], "7")
    d.store.recordOfferMessage("s1", 3, OFFER_TS)
    return d
  }

  it("a numeral reaction on the offer message survives both ingest gates", () => {
    // THE reachability test: the emoji filter (events.ts) and the postFor gate
    // (handlers.ts) would each drop this — the vote branch bypasses both.
    const d = withOffer()
    expect(handleReactionEvent(numeral("U2", "two", OFFER_TS, ts(10, 0)), d)).toEqual({
      kind: "vote",
    })
    expect(d.store.ruleReactionsFor("s1", 3)).toMatchObject([{ factionId: "f2", ordinal: 2 }])
    d.store.close()
  })

  it("drops a numeral on a message that is not the offer, storing nothing", () => {
    const d = withOffer()
    expect(handleReactionEvent(numeral("U2", "two", ts(7, 0), ts(10, 0)), d)).toEqual({
      kind: "drop",
      reason: "not-an-offer",
    })
    expect(d.store.ruleReactionsFor("s1", 3)).toEqual([])
    d.store.close()
  })

  it("drops an unmapped numeral at ingest — it must not void a valid earlier vote", () => {
    const d = withOffer()
    handleReactionEvent(numeral("U2", "one", OFFER_TS, ts(10, 0)), d)
    expect(handleReactionEvent(numeral("U2", "nine", OFFER_TS, ts(11, 0)), d)).toEqual({
      kind: "drop",
      reason: "unmapped-numeral",
    })
    // The earlier vote stands; the nine was never stored.
    expect(d.store.ruleReactionsFor("s1", 3)).toMatchObject([{ factionId: "f2", ordinal: 1 }])
    d.store.close()
  })

  it("removes the row on reaction_removed", () => {
    const d = withOffer()
    handleReactionEvent(numeral("U2", "two", OFFER_TS, ts(10, 0)), d)
    const removal = numeral("U2", "two", OFFER_TS, ts(11, 0))
    expect(
      handleReactionEvent(
        { ...removal, event: { ...removal.event, type: "reaction_removed" as const } },
        d,
      ),
    ).toEqual({ kind: "unvote" })
    expect(d.store.ruleReactionsFor("s1", 3)).toEqual([])
    d.store.close()
  })

  it("dedupes a redelivered vote event", () => {
    const d = withOffer()
    const vote = numeral("U2", "two", OFFER_TS, ts(10, 0))
    expect(handleReactionEvent(vote, d)).toEqual({ kind: "vote" })
    expect(handleReactionEvent(vote, d)).toEqual({ kind: "duplicate" })
    d.store.close()
  })
})
