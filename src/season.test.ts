import { describe, expect, it } from "vitest"
import { checkDeal, currentDay, tickInstant } from "./season.js"
import { etDate, etDaysBetween } from "./time.js"
import type { SeasonRow } from "./store/types.js"

const SEASON: SeasonRow = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }

describe("currentDay", () => {
  it("is 0 on the start date and 1 the next day", () => {
    expect(currentDay(SEASON, new Date("2026-09-01T18:00:00Z"))).toBe(0)
    expect(currentDay(SEASON, new Date("2026-09-02T18:00:00Z"))).toBe(1)
  })

  it("reads the ET calendar date, not the UTC one", () => {
    // 01:30Z on Sep 3 is 21:30 ET on Sep 2 — day 1, not day 2. This is the
    // classic off-by-one-day bug, and the tick runs at 21:00 ET, right on it.
    expect(currentDay(SEASON, new Date("2026-09-03T01:30:00Z"))).toBe(1)
  })

  it("is negative for a season dealt in advance", () => {
    // season-init takes a start date, so dealing early is supported. A tick that
    // derived its day from saved state would start burning days immediately.
    expect(currentDay(SEASON, new Date("2026-08-20T18:00:00Z"))).toBe(-12)
  })

  it("agrees with runPublishSlate's derivation", () => {
    // publish-slate computes etDaysBetween(startDate, etDate(now)). If these ever
    // disagree the two clocks have diverged, which is the exact defect the
    // calendar-derived design exists to prevent.
    const now = new Date("2026-09-05T12:00:00Z")
    expect(currentDay(SEASON, now)).toBe(etDaysBetween(SEASON.startDate, etDate(now)))
  })
})

describe("tickInstant", () => {
  it("is 21:00 ET on that season day", () => {
    // Day 3 of a Sep 1 season is Sep 4; 21:00 EDT is 01:00Z on Sep 5.
    expect(tickInstant(SEASON, 3).toISOString()).toBe("2026-09-05T01:00:00.000Z")
  })

  it("tracks the DST offset rather than a fixed one", () => {
    // DST ends Nov 1 in 2026. Day 60 is Oct 31 (EDT, -04:00) and day 61 is
    // Nov 1 (EST, -05:00), so 21:00 wall-clock lands an hour apart in UTC.
    // Adding hours to a start instant instead would drift the deadline.
    const winter: SeasonRow = { ...SEASON, lengthDays: 90 }
    expect(tickInstant(winter, 60).toISOString()).toBe("2026-11-01T01:00:00.000Z")
    expect(tickInstant(winter, 61).toISOString()).toBe("2026-11-02T02:00:00.000Z")
  })
})

describe("checkDeal", () => {
  it("accepts the original 42/6 board", () => {
    expect(checkDeal(6, 42)).toBeNull()
  })

  it("rejects 15 factions on the 42-territory default", () => {
    // floor(42/15) = 2, below the lower bound. An earlier one-sided `> 11` guard
    // did NOT catch this — 2.8 > 11 is false — despite naming it as the case it
    // was for.
    expect(checkDeal(15, 42)).toEqual({ kind: "too-few-territories", perFaction: 2 })
  })

  it("rejects an empty territory list", () => {
    // Passes every ratio test on its own: nobody earns, and every faction is
    // simultaneously eliminated so every faction may protect.
    expect(checkDeal(4, 0)).toEqual({ kind: "too-few-territories", perFaction: 0 })
  })

  it("accepts exactly at the upper bound and rejects one past it", () => {
    // ceil(44/4) = 11 sits at the income floor; ceil(45/4) = 12 is where
    // floor(t/2) first exceeds 5.
    expect(checkDeal(4, 44)).toBeNull()
    expect(checkDeal(4, 45)).toEqual({ kind: "too-many-territories", perFaction: 12 })
  })

  it("rejects a roster outside the faction bounds", () => {
    expect(checkDeal(3, 42)).toEqual({ kind: "roster-size", factions: 3 })
    expect(checkDeal(16, 112)).toEqual({ kind: "roster-size", factions: 16 })
  })

  it("accepts a full-headcount board", () => {
    expect(checkDeal(15, 105)).toBeNull()
  })

  it("checks the roster size before the ratio", () => {
    // A 20-faction roster on a tiny board fails both; the roster message is the
    // actionable one.
    expect(checkDeal(20, 10)).toEqual({ kind: "roster-size", factions: 20 })
  })
})
