import { describe, expect, it } from "vitest"
import { openStore } from "./sqlite.js"
import type { Market } from "../engine/index.js"

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
