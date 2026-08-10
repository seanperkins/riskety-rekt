import { describe, expect, it } from "vitest"
import { runPublishSlate } from "./publish-slate.js"
import { openStore } from "../store/sqlite.js"
import type { Candidate, CandidateWindow, MarketAdapter } from "../adapters/types.js"
import type { SlateStore } from "../store/types.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 21 }

function cand(id: string, volume: number): Candidate {
  return {
    id,
    question: `q ${id}`,
    priceYes: 0.4,
    priceNo: 0.6,
    closeTime: "2026-09-04T18:00:00Z",
    volume,
    series: id.split("-")[0]!,
  }
}

function stubAdapter(
  candidates: Candidate[] | Error,
): MarketAdapter & { windows: CandidateWindow[] } {
  const windows: CandidateWindow[] = []
  return {
    windows,
    async getCandidates(w) {
      windows.push(w)
      if (candidates instanceof Error) throw candidates
      return candidates
    },
    async getSettlements() {
      return {}
    },
  }
}

function fresh(): SlateStore {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  return store
}

// 2026-09-04T12:00:00Z is 08:00 ET on Sept 4 -- day 3 of a season dealt Sept 1.
const AT_0800_DAY3 = new Date("2026-09-04T12:00:00Z")

describe("runPublishSlate", () => {
  it("publishes the day's slate", async () => {
    const store = fresh()
    const adapter = stubAdapter([cand("A-1", 900), cand("B-1", 800)])
    const out = await runPublishSlate({ store, adapter, seasonId: "s1", now: AT_0800_DAY3 })
    expect(out).toEqual({ status: "published", day: 3, count: 2 })
    expect(store.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A-1", "B-1"])
    store.close()
  })

  it("asks for a window of 09:00 to 21:00 ET on the slate's own day", async () => {
    const store = fresh()
    const adapter = stubAdapter([])
    await runPublishSlate({ store, adapter, seasonId: "s1", now: AT_0800_DAY3 })
    expect(adapter.windows).toHaveLength(1)
    expect(adapter.windows[0]!.opensAfter.toISOString()).toBe("2026-09-04T13:00:00.000Z")
    expect(adapter.windows[0]!.closesBefore.toISOString()).toBe("2026-09-05T01:00:00.000Z")
    store.close()
  })

  it("publishes an empty slate when nothing survives filtering", async () => {
    // "No market slate -> the day runs as plain Risk."
    const store = fresh()
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([]),
      seasonId: "s1",
      now: AT_0800_DAY3,
    })
    expect(out).toEqual({ status: "published", day: 3, count: 0 })
    expect(store.slatePublished("s1", 3)).toBe(true)
    store.close()
  })

  it("caps the slate at SLATE_MAX", async () => {
    const store = fresh()
    const many = Array.from({ length: 9 }, (_, i) => cand(`S${i}-1`, 1000 - i))
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter(many),
      seasonId: "s1",
      now: AT_0800_DAY3,
    })
    expect(out).toEqual({ status: "published", day: 3, count: 5 })
    store.close()
  })

  it("is idempotent -- a second run publishes nothing", async () => {
    const store = fresh()
    await runPublishSlate({
      store,
      adapter: stubAdapter([cand("A-1", 900)]),
      seasonId: "s1",
      now: AT_0800_DAY3,
    })
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([cand("B-1", 900)]),
      seasonId: "s1",
      now: AT_0800_DAY3,
    })
    expect(out).toEqual({ status: "skipped", day: 3, reason: "already-published" })
    expect(store.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A-1"])
    store.close()
  })

  it("does not call the adapter when the day is already published", async () => {
    // A double-fired timer must not spend a network round trip, and must not
    // be able to observe fresher prices at all.
    const store = fresh()
    await runPublishSlate({ store, adapter: stubAdapter([]), seasonId: "s1", now: AT_0800_DAY3 })
    const second = stubAdapter([cand("B-1", 900)])
    await runPublishSlate({ store, adapter: second, seasonId: "s1", now: AT_0800_DAY3 })
    expect(second.windows).toHaveLength(0)
    store.close()
  })

  it("publishes nothing on the final day", async () => {
    // Day-21 wagers would settle at a tick 22 that never runs.
    const store = fresh()
    const day21 = new Date("2026-09-22T12:00:00Z")
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([cand("A-1", 900)]),
      seasonId: "s1",
      now: day21,
    })
    expect(out).toEqual({ status: "skipped", day: 21, reason: "final-day" })
    expect(store.slatePublished("s1", 21)).toBe(false)
    store.close()
  })

  it("publishes on day 20, the last day a wager can settle", async () => {
    const store = fresh()
    const day20 = new Date("2026-09-21T12:00:00Z")
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([cand("A-1", 900)]),
      seasonId: "s1",
      now: day20,
    })
    expect(out).toEqual({ status: "published", day: 20, count: 1 })
    store.close()
  })

  it("skips a day before the season starts", async () => {
    const store = fresh()
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([]),
      seasonId: "s1",
      now: new Date("2026-09-01T12:00:00Z"), // day 0, the deal
    })
    expect(out).toEqual({ status: "skipped", day: 0, reason: "before-season" })
    store.close()
  })

  it("skips a day after the season ends", async () => {
    const store = fresh()
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([]),
      seasonId: "s1",
      now: new Date("2026-10-15T12:00:00Z"),
    })
    expect(out.status).toBe("skipped")
    if (out.status !== "skipped") return
    expect(out.reason).toBe("after-season")
    store.close()
  })

  it("propagates an adapter failure and publishes nothing", async () => {
    // Critical: a network failure must NOT record an empty slate. Recording one
    // would permanently deny the day a slate, when a systemd retry five minutes
    // later would have succeeded. Only a successful fetch that yields nothing
    // is a real empty slate.
    const store = fresh()
    const boom = new Error("kalshi unreachable")
    await expect(
      runPublishSlate({ store, adapter: stubAdapter(boom), seasonId: "s1", now: AT_0800_DAY3 }),
    ).rejects.toThrow("kalshi unreachable")
    expect(store.slatePublished("s1", 3)).toBe(false)
    store.close()
  })

  it("throws for an unknown season", async () => {
    const store = openStore(":memory:")
    await expect(
      runPublishSlate({ store, adapter: stubAdapter([]), seasonId: "nope", now: AT_0800_DAY3 }),
    ).rejects.toThrow(/nope/)
    store.close()
  })

  it("logs a warning when the slate is short of SLATE_MIN", async () => {
    const lines: string[] = []
    const store = fresh()
    await runPublishSlate({
      store,
      adapter: stubAdapter([cand("A-1", 900)]),
      seasonId: "s1",
      now: AT_0800_DAY3,
      log: (m) => lines.push(m),
    })
    expect(lines.some((l) => /only 1/.test(l))).toBe(true)
    store.close()
  })
})
