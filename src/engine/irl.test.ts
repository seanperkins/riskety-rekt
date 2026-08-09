import { describe, expect, it } from "vitest"
import { irlGrants } from "./irl.js"
import type { ApprovedAction } from "./types.js"

const a = (
  playerId: string,
  postedAt: string,
  approvedAt: string,
  eventId = `${playerId}-${postedAt}`,
): ApprovedAction => ({ eventId, playerId, postedAt, approvedAt })

describe("irlGrants", () => {
  it("returns nothing for an empty day", () => {
    expect(irlGrants([]).size).toBe(0)
  })

  it("caps actions at 2 per player", () => {
    const g = irlGrants([
      a("f1", "T08:00", "T08:05"),
      a("f1", "T09:00", "T09:05"),
      a("f1", "T10:00", "T10:05"),
      a("f1", "T11:00", "T11:05"),
    ])
    expect(g.get("f1")!.actions).toBe(2)
  })

  it("awards both bonuses to different players", () => {
    const g = irlGrants([a("f1", "T06:00", "T06:30"), a("f2", "T19:00", "T20:30")])
    expect(g.get("f1")!.bonus).toBe(1)
    expect(g.get("f2")!.bonus).toBe(1)
  })

  it("gives a lone poster exactly one bonus, not two", () => {
    const g = irlGrants([a("f1", "T06:00", "T06:30")])
    expect(g.get("f1")!.bonus).toBe(1)
    expect(g.get("f1")!.actions).toBe(1)
  })

  it("passes Under the Wire to the latest different player", () => {
    const g = irlGrants([
      a("f1", "T06:00", "T06:30"),
      a("f1", "T20:00", "T20:55"), // f1 holds both ends
      a("f2", "T12:00", "T12:30"),
    ])
    expect(g.get("f1")!.bonus).toBe(1)
    expect(g.get("f2")!.bonus).toBe(1)
  })

  it("keys Early Bird on post time, not approval time", () => {
    // f1 was APPROVED first (T09:01) but f2 POSTED first (T07:00).
    // f3 has the latest approval and takes Under the Wire, so f1 gets nothing
    // only if Early Bird correctly went to f2.
    const g = irlGrants([
      a("f1", "T09:00", "T09:01"),
      a("f2", "T07:00", "T09:30"),
      a("f3", "T10:00", "T20:00"),
    ])
    expect(g.get("f2")!.bonus).toBe(1) // Early Bird — posted first
    expect(g.get("f3")!.bonus).toBe(1) // Under the Wire — approved last
    expect(g.get("f1")!.bonus).toBe(0) // approved first, but that earns nothing
  })

  it("breaks timestamp ties deterministically on eventId", () => {
    const g1 = irlGrants([a("f2", "T08:00", "T08:00", "e1"), a("f1", "T08:00", "T08:00", "e2")])
    const g2 = irlGrants([a("f1", "T08:00", "T08:00", "e2"), a("f2", "T08:00", "T08:00", "e1")])
    expect(Object.fromEntries(g1)).toEqual(Object.fromEntries(g2))
  })

  it("counts actions for a player who wins no bonus", () => {
    const g = irlGrants([
      a("f1", "T06:00", "T06:30"),
      a("f2", "T12:00", "T12:30"),
      a("f3", "T20:00", "T20:30"),
    ])
    expect(g.get("f2")!.actions).toBe(1)
    expect(g.get("f2")!.bonus).toBe(0)
  })
})
