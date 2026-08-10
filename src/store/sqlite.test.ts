import { describe, expect, it } from "vitest"
import { openStore } from "./sqlite.js"
import type { Market } from "../engine/index.js"
import { etDate, slackTsToIso } from "../time.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 21 }

function market(id: string, closeTime = "2026-09-05T18:00:00Z"): Market {
  return { id, question: `q ${id}`, priceYes: 0.4, priceNo: 0.6, closeTime }
}

function fresh() {
  // ":memory:" gives each test its own database and needs no cleanup.
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  return store
}

describe("seasons", () => {
  it("round-trips a season", () => {
    const s = fresh()
    expect(s.season("s1")).toEqual(SEASON)
    s.close()
  })

  it("returns undefined for an unknown season", () => {
    const s = fresh()
    expect(s.season("nope")).toBeUndefined()
    s.close()
  })
})

describe("publishSlate", () => {
  it("persists and reloads a slate with prices intact", () => {
    const s = fresh()
    const slate = [market("A"), market("B")]
    expect(s.publishSlate("s1", 3, slate, new Date("2026-09-03T12:00:00Z"))).toBe(true)
    expect(s.loadSlate("s1", 3)).toEqual(slate)
    s.close()
  })

  it("refuses a second publish and leaves the first slate untouched", () => {
    // A rerun must never re-snapshot prices at a later, better-informed hour.
    const s = fresh()
    s.publishSlate("s1", 3, [market("A")], new Date("2026-09-03T12:00:00Z"))
    const second = s.publishSlate("s1", 3, [market("B")], new Date("2026-09-03T20:00:00Z"))
    expect(second).toBe(false)
    expect(s.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A"])
    s.close()
  })

  it("records an empty slate as published", () => {
    // "Nothing survived the filters" is a decision; "the job never ran" is not.
    const s = fresh()
    expect(s.publishSlate("s1", 4, [], new Date("2026-09-04T12:00:00Z"))).toBe(true)
    expect(s.slatePublished("s1", 4)).toBe(true)
    expect(s.loadSlate("s1", 4)).toEqual([])
    s.close()
  })

  it("reports an unpublished day as not published", () => {
    const s = fresh()
    expect(s.slatePublished("s1", 9)).toBe(false)
    s.close()
  })

  it("returns the slate sorted by market id", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("Z"), market("A"), market("M")], new Date())
    expect(s.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A", "M", "Z"])
    s.close()
  })

  it("keeps days and seasons separate", () => {
    const s = fresh()
    s.upsertSeason({ seasonId: "s2", startDate: "2026-10-01", lengthDays: 21 })
    s.publishSlate("s1", 3, [market("A")], new Date())
    s.publishSlate("s1", 4, [market("B")], new Date())
    s.publishSlate("s2", 3, [market("C")], new Date())
    expect(s.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A"])
    expect(s.loadSlate("s1", 4).map((m) => m.id)).toEqual(["B"])
    expect(s.loadSlate("s2", 3).map((m) => m.id)).toEqual(["C"])
    s.close()
  })

  it("preserves a price exactly through a round trip", () => {
    const s = fresh()
    const m: Market = {
      id: "A",
      question: "q",
      priceYes: 0.455,
      priceNo: 0.545,
      closeTime: "2026-09-05T18:00:00Z",
    }
    s.publishSlate("s1", 3, [m], new Date())
    expect(s.loadSlate("s1", 3)[0]!.priceYes).toBe(0.455)
    s.close()
  })

  it("stores hostile question text verbatim", () => {
    const s = fresh()
    const nasty = "</text><script>alert(1)</script> <!channel>"
    s.publishSlate("s1", 3, [{ ...market("A"), question: nasty }], new Date())
    expect(s.loadSlate("s1", 3)[0]!.question).toBe(nasty)
    s.close()
  })
})

describe("settlements", () => {
  it("records and reads back an outcome", () => {
    const s = fresh()
    expect(s.recordSettlement("A", "yes", new Date("2026-09-03T18:00:00Z"))).toBe(true)
    expect(s.loadSettlements(["A"])).toEqual({ A: "yes" })
    s.close()
  })

  it("reports unknown markets as unsettled", () => {
    const s = fresh()
    expect(s.loadSettlements(["A", "B"])).toEqual({ A: "unsettled", B: "unsettled" })
    s.close()
  })

  it("keeps the first observation when a second disagrees", () => {
    const s = fresh()
    s.recordSettlement("A", "yes", new Date("2026-09-03T18:00:00Z"))
    expect(s.recordSettlement("A", "no", new Date("2026-09-03T19:00:00Z"))).toBe(false)
    expect(s.loadSettlements(["A"])).toEqual({ A: "yes" })
    s.close()
  })

  it("returns an empty map for an empty request", () => {
    const s = fresh()
    expect(s.loadSettlements([])).toEqual({})
    s.close()
  })

  it("handles a request larger than SQLite's parameter limit", () => {
    const s = fresh()
    s.recordSettlement("T500", "no", new Date())
    const ids = Array.from({ length: 1200 }, (_, i) => `T${i}`)
    const out = s.loadSettlements(ids)
    expect(Object.keys(out)).toHaveLength(1200)
    expect(out.T500).toBe("no")
    expect(out.T499).toBe("unsettled")
    s.close()
  })
})

describe("marketsAwaitingSettlement", () => {
  const NOW = new Date("2026-09-05T20:00:00Z")

  it("returns closed, unsettled markets", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("A", "2026-09-05T18:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual(["A"])
    s.close()
  })

  it("skips markets that have not closed yet", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("A", "2026-09-05T23:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual([])
    s.close()
  })

  it("skips markets already settled", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("A", "2026-09-05T18:00:00Z")], new Date())
    s.recordSettlement("A", "yes", NOW)
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual([])
    s.close()
  })

  it("skips markets older than the horizon", () => {
    // Past the two-tick refund the answer can no longer change anything.
    const s = fresh()
    s.publishSlate("s1", 1, [market("OLD", "2026-08-20T18:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual([])
    s.close()
  })

  it("does not return another season's markets", () => {
    const s = fresh()
    s.upsertSeason({ seasonId: "s2", startDate: "2026-10-01", lengthDays: 21 })
    s.publishSlate("s2", 3, [market("A", "2026-09-05T18:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual([])
    s.close()
  })

  it("returns each market once even when it appears on several days", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("A", "2026-09-05T18:00:00Z")], new Date())
    s.publishSlate("s1", 4, [market("A", "2026-09-05T18:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual(["A"])
    s.close()
  })

  it("returns ids sorted", () => {
    const s = fresh()
    s.publishSlate(
      "s1",
      3,
      [market("Z", "2026-09-05T18:00:00Z"), market("A", "2026-09-05T18:00:00Z")],
      new Date(),
    )
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual(["A", "Z"])
    s.close()
  })
})

describe("migrations", () => {
  it("is safe to open the same database twice", () => {
    const s1 = openStore(":memory:")
    s1.close()
    const s2 = openStore(":memory:")
    s2.close()
    expect(true).toBe(true)
  })
})

describe("roster", () => {
  it("maps in both directions and returns members sorted by faction", () => {
    const store = openStore(":memory:")
    store.addRosterMember({ slackUserId: "U2", factionId: "f2", displayName: "Bex" })
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada" })

    expect(store.factionForSlackUser("U1")).toBe("f1")
    expect(store.factionForSlackUser("U404")).toBeUndefined()
    expect(store.slackUserForFaction("f2")).toBe("U2")
    expect(store.roster().map((m) => m.factionId)).toEqual(["f1", "f2"])
    store.close()
  })

  it("updates the display name on a repeat add rather than failing", () => {
    const store = openStore(":memory:")
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada" })
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada L." })
    expect(store.roster()).toEqual([{ slackUserId: "U1", factionId: "f1", displayName: "Ada L." }])
    store.close()
  })

  it("refuses to give one faction to two Slack users", () => {
    // Two accounts on one faction would let a player approve their own post,
    // which the self-approval check keys on faction id to prevent.
    const store = openStore(":memory:")
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada" })
    expect(() =>
      store.addRosterMember({ slackUserId: "U2", factionId: "f1", displayName: "Alt" }),
    ).toThrow()
    store.close()
  })
})

describe("slack ingest", () => {
  const seed = () => {
    const store = openStore(":memory:")
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada" })
    store.addRosterMember({ slackUserId: "U2", factionId: "f2", displayName: "Bex" })
    store.addRosterMember({ slackUserId: "U3", factionId: "f3", displayName: "Cy" })
    return store
  }

  it("marks an event seen exactly once", () => {
    // Slack redelivers up to three times when the ack is slow, with the same
    // event_id. Without this, one retried reaction becomes two approvals.
    const store = seed()
    expect(store.markEventSeen("Ev1", new Date("2026-08-09T12:00:00Z"))).toBe(true)
    expect(store.markEventSeen("Ev1", new Date("2026-08-09T12:00:01Z"))).toBe(false)
    store.close()
  })

  it("records a post under the ET date of its Slack ts", () => {
    const store = seed()
    // 2026-08-10T01:30:00Z is 21:30 on 2026-08-09 in New York.
    const ts = `${Date.UTC(2026, 7, 10, 1, 30) / 1000}.000100`
    store.recordPost({ messageTs: ts, factionId: "f1" })
    expect(store.postsOn("2026-08-09").map((p) => p.factionId)).toEqual(["f1"])
    expect(store.postsOn("2026-08-10")).toEqual([])
    store.close()
  })

  it("is idempotent on a repeated post", () => {
    const store = seed()
    const ts = "1723237200.000200"
    store.recordPost({ messageTs: ts, factionId: "f1" })
    store.recordPost({ messageTs: ts, factionId: "f1" })
    expect(store.postsOn(etDate(new Date(slackTsToIso(ts)))).length).toBe(1)
    store.close()
  })

  it("hides a deleted post without losing its reactions", () => {
    const store = seed()
    const ts = "1723237200.000200"
    const day = etDate(new Date(slackTsToIso(ts)))
    store.recordPost({ messageTs: ts, factionId: "f1" })
    store.recordApproval({ messageTs: ts, factionId: "f2", reactedAt: "1723237800.000100" })
    store.deletePost(ts)
    expect(store.postsOn(day)).toEqual([])
    // postFor still finds it, so a later reaction on a deleted post is a
    // recognised no-op rather than an unknown post.
    expect(store.postFor(ts)?.factionId).toBe("f1")
    store.close()
  })

  it("tolerates a deletion for a post it never saw", () => {
    // Slack sends message_deleted for every message in the channel, including
    // text chatter the ingest ignored.
    const store = seed()
    expect(() => store.deletePost("1723237200.000200")).not.toThrow()
    store.close()
  })

  it("counts one approval per distinct approver and keeps the first timestamp", () => {
    const store = seed()
    const ts = "1723237200.000200"
    store.recordPost({ messageTs: ts, factionId: "f1" })
    store.recordApproval({ messageTs: ts, factionId: "f2", reactedAt: "1723237800.000100" })
    // 👍 after 👍🏽 from the same player is one reaction, and must not advance
    // the timestamp -- approvedAt is the SECOND distinct approver's reaction.
    store.recordApproval({ messageTs: ts, factionId: "f2", reactedAt: "1723239999.000100" })
    // Stored as an ISO instant, not a raw Slack ts: the cutoff comparison in
    // dailyApprovals is a string comparison, and comparing "1723237800.000100"
    // against "2026-08-09T21:00:00.000Z" is wrong in the same direction always.
    expect(store.approversOf(ts)).toEqual([
      { factionId: "f2", reactedAt: slackTsToIso("1723237800.000100") },
    ])
    store.close()
  })

  it("removes an approval", () => {
    const store = seed()
    const ts = "1723237200.000200"
    store.recordPost({ messageTs: ts, factionId: "f1" })
    store.recordApproval({ messageTs: ts, factionId: "f2", reactedAt: "1723237800.000100" })
    store.removeApproval(ts, "f2")
    expect(store.approversOf(ts)).toEqual([])
    store.close()
  })
})
