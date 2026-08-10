import { describe, expect, it } from "vitest"
import { ENGINE_VERSION, RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction, GameState, Market } from "../engine/index.js"
import { openStore } from "../store/sqlite.js"
import { runRerun } from "./rerun.js"
import { runTick } from "./tick.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }

const at = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 1 + day, hour + 4, minute))

const factions: Faction[] = ["f1", "f2", "f3", "f4"].map((id) => ({
  id,
  playerName: id,
  color: "#000",
}))

const dealt = (): GameState =>
  createSeason(
    SEASON.seasonId,
    factions,
    RISK_MAP.territories.map((t) => t.id),
  )

const market = (id: string, day: number): Market => ({
  id,
  question: `will ${id}?`,
  priceYes: 0.4,
  priceNo: 0.6,
  closeTime: at(day, 20).toISOString(),
})

/** A season dealt at day 0, with days 1..through ticked for real. */
function ticked(through: number) {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  store.transaction(() => store.saveState(dealt(), ENGINE_VERSION))
  for (let day = 1; day <= through; day++) {
    store.publishSlate("s1", day, [market(`KX-${day}`, day)], at(day, 8))
    store.recordPost({ messageTs: `${1_780_000_000 + day}.0001`, factionId: "f1" })
    store.recordApproval({
      messageTs: `${1_780_000_000 + day}.0001`,
      factionId: "f2",
      reactedAt: `${1_780_000_100 + day}.0001`,
    })
    store.recordApproval({
      messageTs: `${1_780_000_000 + day}.0001`,
      factionId: "f3",
      reactedAt: `${1_780_000_200 + day}.0001`,
    })
    store.saveWager("s1", day, "f1", { marketId: `KX-${day}`, side: "yes", stake: 2 }, at(day, 9))
    const out = runTick({ store, seasonId: "s1", now: at(day, 21, 30) })
    if (out.status !== "resolved") throw new Error(`seed tick ${day}: ${out.status}`)
  }
  return { store, seasonId: "s1" as const }
}

describe("runRerun", () => {
  it("replays to identical states even after the world has changed underneath", () => {
    // The test the pre-tick_context design could not have passed. settleAll
    // reads live settlements and dailyApprovals reads live posts and reactions,
    // so a replay days later would resolve differently -- and posts.deleted is
    // an untimestamped flag while removeApproval hard-deletes, so filtering by
    // a timestamp does not save it.
    const d = ticked(3)
    const before = [1, 2, 3].map((day) => d.store.loadState("s1", day)!)

    d.store.recordSettlement("KX-2", "yes", at(2, 20, 30))
    d.store.deletePost("1780000002.0001")
    d.store.removeApproval("1780000003.0001", "f2")

    const out = runRerun({ ...d, day: 1, now: at(4, 10), confirm: true })
    expect(out.status).toBe("replayed")
    for (const day of [1, 2, 3]) {
      expect(d.store.loadState("s1", day)).toEqual(before[day - 1])
    }
    d.store.close()
  })

  it("replays the range day..min(calendarDay - 1, lengthDays)", () => {
    // A range, not one day: a day-5 tick that dies leaves latestSaved = 4, so
    // day 6 refuses too and the count grows nightly.
    const d = ticked(3)
    expect(runRerun({ ...d, day: 2, now: at(4, 10) })).toEqual({ status: "dry-run", days: [2, 3] })
    d.store.close()
  })

  it("clamps the range at lengthDays", () => {
    const d = ticked(14)
    expect(runRerun({ ...d, day: 13, now: at(20, 10) })).toEqual({
      status: "dry-run",
      days: [13, 14],
    })
    d.store.close()
  })

  it("deletes nothing without --confirm", () => {
    const d = ticked(3)
    const before = d.store.loadState("s1", 3)
    expect(runRerun({ ...d, day: 1, now: at(4, 10) }).status).toBe("dry-run")
    expect(d.store.loadState("s1", 3)).toEqual(before)
    expect(d.store.latestSavedDay("s1")).toBe(3)
    d.store.close()
  })

  it("refuses day 0, a negative day, a non-integer and a day past the season", () => {
    // Day 0 is the deal, not a tick. The negative case matters most: DELETE FROM
    // states WHERE day >= -1 would take the deal with it.
    const d = ticked(2)
    for (const day of [0, -1, 1.5, 15, Number.NaN]) {
      expect(runRerun({ ...d, day, now: at(3, 10), confirm: true })).toMatchObject({
        status: "refused",
        refusal: { reason: "bad-day" },
      })
    }
    expect(d.store.latestSavedDay("s1")).toBe(2)
    d.store.close()
  })

  it("refuses a season with no deal", () => {
    const store = openStore(":memory:")
    store.upsertSeason(SEASON)
    expect(runRerun({ store, seasonId: "s1", day: 1, now: at(3, 10), confirm: true })).toEqual({
      status: "refused",
      refusal: { reason: "no-deal" },
    })
    store.close()
  })

  it("refuses a day whose 21:00 has not passed", () => {
    const d = ticked(3)
    expect(runRerun({ ...d, day: 4, now: at(4, 10), confirm: true })).toMatchObject({
      status: "refused",
      refusal: { reason: "day-not-over" },
    })
    d.store.close()
  })

  it("refuses a missing context, before deleting anything", () => {
    // Otherwise a partial rerun deletes states it cannot rebuild.
    const d = ticked(3)
    d.store.transaction(() => d.store.deleteStatesFrom("s1", 2))
    // Day 2's context is gone with its state; put the states back but not it.
    const base = d.store.loadState("s1", 1)!
    for (const day of [2, 3]) {
      d.store.transaction(() => d.store.saveState({ ...base, day }, ENGINE_VERSION))
    }
    expect(runRerun({ ...d, day: 2, now: at(4, 10), confirm: true })).toEqual({
      status: "refused",
      refusal: { reason: "missing-context", day: 2 },
    })
    expect(d.store.latestSavedDay("s1")).toBe(3)
    d.store.close()
  })

  it("--assemble-missing builds a context for a day that never ticked", () => {
    const d = ticked(2)
    // Day 3 has orders and a slate but no tick ever ran.
    d.store.publishSlate("s1", 3, [market("KX-3", 3)], at(3, 8))
    d.store.saveOrder("s1", 3, "f1", { deploys: [], attacks: [], protect: null }, at(3, 9))
    const out = runRerun({ ...d, day: 3, now: at(4, 10), confirm: true, assembleMissing: true })
    expect(out.status).toBe("replayed")
    expect(d.store.loadState("s1", 3)).toBeDefined()
    expect(d.store.loadTickContext("s1", 3)?.context.slate.map((m) => m.id)).toEqual(["KX-3"])
    d.store.close()
  })

  it("logs an engine-version change and proceeds", () => {
    // 'Fix the code, then rerun' is this command's documented purpose, so
    // refusing on a version change would block the case it exists for.
    const d = ticked(2)
    const recorded = d.store.loadTickContext("s1", 2)!
    d.store.transaction(() => {
      d.store.deleteStatesFrom("s1", 2)
      d.store.saveTickContext("s1", 2, recorded.orders, recorded.context, "0.9.0")
      const one = d.store.loadState("s1", 1)!
      d.store.saveState({ ...one, day: 2 }, "0.9.0")
    })
    const lines: string[] = []
    const out = runRerun({
      ...d,
      day: 2,
      now: at(3, 10),
      confirm: true,
      log: (m) => lines.push(m),
    })
    expect(out.status).toBe("replayed")
    expect(lines.join("\n")).toMatch(/0\.9\.0/)
    d.store.close()
  })

  it("rolls the whole rerun back if one day throws", () => {
    // The delete, every replayed write and any assembled context are one
    // transaction. Separately-committed ones let the nightly tick interleave.
    const d = ticked(3)
    const before = [1, 2, 3].map((day) => d.store.loadState("s1", day)!)
    let calls = 0
    expect(() =>
      runRerun({
        ...d,
        day: 1,
        now: at(4, 10),
        confirm: true,
        resolve: (state, orders, context) => {
          if (++calls === 3) throw new Error("boom")
          return { ...state, day: state.day + 1, log: [], pending: [] }
        },
      }),
    ).toThrow("boom")
    for (const day of [1, 2, 3]) expect(d.store.loadState("s1", day)).toEqual(before[day - 1])
    d.store.close()
  })

  it("throws on an unknown season", () => {
    const d = ticked(1)
    expect(() => runRerun({ ...d, seasonId: "nope", day: 1, now: at(2, 10) })).toThrow(
      /unknown season/,
    )
    d.store.close()
  })
})
