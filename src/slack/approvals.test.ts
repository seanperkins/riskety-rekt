import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { dailyApprovals } from "./approvals.js"

/** Slack ts for a wall-clock time in New York on 2026-08-09 (EDT, UTC-4). */
const ts = (hour: number, minute: number, seq = 1) =>
  `${Date.UTC(2026, 7, 9, hour + 4, minute) / 1000}.${String(seq).padStart(6, "0")}`

/** The ISO instant for the same wall-clock time, for asserting on. */
const iso = (hour: number, minute: number) =>
  new Date(Date.UTC(2026, 7, 9, hour + 4, minute)).toISOString()

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-08-06", lengthDays: 21 })
  for (const [u, f, n] of [
    ["U1", "f1", "Ada"],
    ["U2", "f2", "Bex"],
    ["U3", "f3", "Cy"],
    ["U4", "f4", "Dee"],
  ] as const) {
    store.addRosterMember({ slackUserId: u, factionId: f, displayName: n })
  }
  return store
}

// Day 3 of the season is 2026-08-09, since day 0 was dealt on 2026-08-06.
const DAY = 3

describe("dailyApprovals", () => {
  it("needs two distinct approvers before an action counts", () => {
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(8, 0) })

    // One approver: posted, but not approved.
    let out = dailyApprovals(store, "s1", DAY)
    expect(out.approvals).toEqual([])
    expect(out.postedToday).toEqual(["f1"])

    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(9, 0) })
    out = dailyApprovals(store, "s1", DAY)
    expect(out.approvals).toEqual([
      { eventId: post, playerId: "f1", postedAt: iso(7, 0), approvedAt: iso(9, 0) },
    ])
    store.close()
  })

  it("dates approvedAt from the SECOND approver, not the last", () => {
    // Under the Wire keys on this. Taking the last approver would hand the
    // bonus to whoever happened to pile on late.
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(8, 0) })
    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(9, 0) })
    store.recordApproval({ messageTs: post, factionId: "f4", reactedAt: ts(20, 0) })

    expect(dailyApprovals(store, "s1", DAY).approvals[0]!.approvedAt).toBe(iso(9, 0))
    store.close()
  })

  it("counts an approval at 21:01, which the old cutoff threw away", () => {
    // The boundary moved to midnight on 2026-08-15. Every evening approval
    // between 21:00 and midnight used to be collected here and discarded.
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(20, 59) })
    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(21, 1) })
    expect(dailyApprovals(store, "s1", DAY).approvals).toHaveLength(1)
    store.close()
  })

  it("excludes an approval that landed after midnight, on the next day", () => {
    // The cutoff is still a cutoff — it just sits at the end of the day now. A
    // 👍 on yesterday's workout arriving this morning must not count, or the
    // approver filter would stop bounding anything at all.
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(23, 59) })
    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(24, 30) })
    expect(dailyApprovals(store, "s1", DAY).approvals).toEqual([])
    store.close()
  })

  it("counts an approval at 20:59 no matter when it was delivered", () => {
    // The row's write time is irrelevant; only the Slack event_ts is read.
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(20, 59, 1) })
    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(20, 59, 2) })
    expect(dailyApprovals(store, "s1", DAY).approvals).toHaveLength(1)
    store.close()
  })

  it("never counts a self-approval even if one was written", () => {
    // Defence in depth: interpretReaction already drops these, but an alt
    // account added to the roster after the fact would leave one on disk.
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f1", reactedAt: ts(8, 0) })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(9, 0) })
    expect(dailyApprovals(store, "s1", DAY).approvals).toEqual([])
    store.close()
  })

  it("drops a deleted post from both approvals and postedToday", () => {
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(8, 0) })
    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(9, 0) })
    store.deletePost(post)
    expect(dailyApprovals(store, "s1", DAY)).toEqual({ approvals: [], postedToday: [] })
    store.close()
  })

  it("reports an unapproved post in postedToday", () => {
    // The elimination veto gates on posting alone. This is the case that makes
    // the two lists differ, and the reason postedToday exists.
    const store = seeded()
    store.recordPost({ messageTs: ts(7, 0), factionId: "f1" })
    expect(dailyApprovals(store, "s1", DAY)).toEqual({ approvals: [], postedToday: ["f1"] })
    store.close()
  })

  it("counts a 21:30 post — the workout that used to fall into no day at all", () => {
    // The reason the tick moved. postsOn selects the whole ET date; the cutoff
    // used to chop it at 21:00, so this post was stored and then belonged to
    // nothing: not to this day, which had already read its approvals, and not
    // to the next, whose date it does not share.
    const store = seeded()
    store.recordPost({ messageTs: ts(21, 30), factionId: "f1" })
    expect(dailyApprovals(store, "s1", DAY).postedToday).toEqual(["f1"])
    store.close()
  })

  it("counts a 23:59 post, and gives 00:01 to the next day", () => {
    // Every workout falls into exactly one day. The boundary is the only place
    // the answer changes.
    const store = seeded()
    store.recordPost({ messageTs: ts(23, 59), factionId: "f1" })
    store.recordPost({ messageTs: ts(24, 1), factionId: "f2" })
    expect(dailyApprovals(store, "s1", DAY).postedToday).toEqual(["f1"])
    expect(dailyApprovals(store, "s1", DAY + 1).postedToday).toEqual(["f2"])
    store.close()
  })

  it("returns each faction once in postedToday and sorts it", () => {
    const store = seeded()
    store.recordPost({ messageTs: ts(7, 0), factionId: "f2" })
    store.recordPost({ messageTs: ts(8, 0), factionId: "f2" })
    store.recordPost({ messageTs: ts(9, 0), factionId: "f1" })
    expect(dailyApprovals(store, "s1", DAY).postedToday).toEqual(["f1", "f2"])
    store.close()
  })

  it("returns approvals ordered by post time, ties on message ts", () => {
    const store = seeded()
    const approve = (post: string) => {
      store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(20, 0) })
      store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(20, 1) })
    }
    const later = ts(9, 0)
    const earlierB = ts(7, 0, 2)
    const earlierA = ts(7, 0, 1)
    for (const p of [later, earlierB, earlierA]) {
      store.recordPost({ messageTs: p, factionId: "f1" })
      approve(p)
    }
    expect(dailyApprovals(store, "s1", DAY).approvals.map((a) => a.eventId)).toEqual([
      earlierA,
      earlierB,
      later,
    ])
    store.close()
  })

  it("returns empty for a day with nothing on it", () => {
    const store = seeded()
    expect(dailyApprovals(store, "s1", 1)).toEqual({ approvals: [], postedToday: [] })
    store.close()
  })

  it("throws for an unknown season", () => {
    const store = seeded()
    expect(() => dailyApprovals(store, "nope", 1)).toThrow(/unknown season/)
    store.close()
  })
})
