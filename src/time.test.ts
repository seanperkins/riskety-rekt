import { describe, expect, it } from "vitest"
import { etDate, etDaysBetween, etInstant } from "./time.js"

describe("etDate", () => {
  it("returns the ET calendar date, not the UTC one", () => {
    // 02:30 UTC on Aug 10 is 22:30 ET on Aug 9 -- the classic off-by-one-day bug.
    expect(etDate(new Date("2026-08-10T02:30:00Z"))).toBe("2026-08-09")
  })

  it("handles midday", () => {
    expect(etDate(new Date("2026-08-10T16:00:00Z"))).toBe("2026-08-10")
  })
})

describe("etInstant", () => {
  it("resolves 09:00 during EDT to 13:00 UTC", () => {
    expect(etInstant("2026-08-10", 9).toISOString()).toBe("2026-08-10T13:00:00.000Z")
  })

  it("resolves 09:00 during EST to 14:00 UTC", () => {
    expect(etInstant("2026-01-15", 9).toISOString()).toBe("2026-01-15T14:00:00.000Z")
  })

  it("resolves 21:00 on the day DST begins", () => {
    // 2026-03-08 is the spring-forward date. 21:00 is well after the 02:00
    // transition, so the day is EDT by then.
    expect(etInstant("2026-03-08", 21).toISOString()).toBe("2026-03-09T01:00:00.000Z")
  })

  it("resolves 21:00 on the day DST ends", () => {
    // 2026-11-01 falls back at 02:00; 21:00 is EST.
    expect(etInstant("2026-11-01", 21).toISOString()).toBe("2026-11-02T02:00:00.000Z")
  })

  it("accepts minutes", () => {
    expect(etInstant("2026-08-10", 8, 30).toISOString()).toBe("2026-08-10T12:30:00.000Z")
  })
})

describe("etDaysBetween", () => {
  it("counts whole calendar days", () => {
    expect(etDaysBetween("2026-08-01", "2026-08-10")).toBe(9)
  })

  it("is zero for the same day", () => {
    expect(etDaysBetween("2026-08-10", "2026-08-10")).toBe(0)
  })

  it("is unaffected by a DST transition in the interval", () => {
    // March 1 -> March 15 spans spring-forward. A naive
    // (msB - msA) / 86_400_000 on local timestamps gives 13.958 and floors to 13.
    expect(etDaysBetween("2026-03-01", "2026-03-15")).toBe(14)
  })

  it("goes negative before the start", () => {
    expect(etDaysBetween("2026-08-10", "2026-08-08")).toBe(-2)
  })
})
