import { describe, expect, it } from "vitest"
import { checkContribution, parseInstant, sortClaims } from "./mechanics.js"
import type { OwnedClaim } from "./mechanics.js"

const claim = (o: Partial<OwnedClaim>): OwnedClaim => ({
  faction: "f1",
  amount: 1,
  lockedAt: "2026-09-01T18:00:00.000Z",
  ref: "x",
  mechanicId: "markets",
  index: 0,
  ...o,
})

describe("parseInstant", () => {
  it("parses a full ISO instant to epoch ms", () => {
    expect(parseInstant("2026-09-01T18:00:00.000Z")).toBe(Date.parse("2026-09-01T18:00:00.000Z"))
  })

  it("throws loudly on a non-instant — the T18:00 fixture class", () => {
    expect(() => parseInstant("T18:00")).toThrow(/lockedAt/)
  })
})

describe("sortClaims", () => {
  it("orders by parsed instant ascending, never string order", () => {
    // A string comparison of ISO instants happens to agree; the property that
    // matters is temporal order between differently-formatted valid instants.
    const early = claim({ ref: "wager", lockedAt: "2026-09-01T16:00:00.000Z" })
    const late = claim({ ref: "deploy", mechanicId: "", lockedAt: "2026-09-01T21:00:00.000Z" })
    expect(sortClaims([late, early]).map((c) => c.ref)).toEqual(["wager", "deploy"])
  })

  it("offset form and Z form compare temporally, not lexically", () => {
    // "2026-09-01T17:00:00.000-04:00" is 21:00Z; lexically "2026-09-01T17…"
    // sorts BEFORE "2026-09-01T18…Z", but temporally it is after.
    const zForm = claim({ ref: "z", lockedAt: "2026-09-01T18:00:00.000Z" })
    const offset = claim({ ref: "offset", lockedAt: "2026-09-01T17:00:00.000-04:00" })
    expect(sortClaims([offset, zForm]).map((c) => c.ref)).toEqual(["z", "offset"])
  })

  it("breaks equal instants on mechanicId then index — core ('') first", () => {
    const t = "2026-09-01T21:00:00.000Z"
    const a = claim({ ref: "core", mechanicId: "", index: 1, lockedAt: t })
    const b = claim({ ref: "mkt0", mechanicId: "markets", index: 0, lockedAt: t })
    const c = claim({ ref: "mkt1", mechanicId: "markets", index: 1, lockedAt: t })
    expect(sortClaims([c, b, a]).map((x) => x.ref)).toEqual(["core", "mkt0", "mkt1"])
  })

  it("does not mutate its input", () => {
    const input = [
      claim({ ref: "b", lockedAt: "2026-09-01T21:00:00.000Z" }),
      claim({ ref: "a", lockedAt: "2026-09-01T16:00:00.000Z" }),
    ]
    sortClaims(input)
    expect(input.map((c) => c.ref)).toEqual(["b", "a"])
  })
})

describe("checkContribution", () => {
  const factions = new Set(["f1"])

  it("accepts a non-negative integer amount for a known faction", () => {
    expect(() => checkContribution({ faction: "f1", amount: 0 }, factions)).not.toThrow()
    expect(() => checkContribution({ faction: "f1", amount: 7 }, factions)).not.toThrow()
  })

  it("throws on negative, fractional, and unknown-faction returns", () => {
    expect(() => checkContribution({ faction: "f1", amount: -1 }, factions)).toThrow(/amount/)
    expect(() => checkContribution({ faction: "f1", amount: 1.5 }, factions)).toThrow(/amount/)
    expect(() => checkContribution({ faction: "ghost", amount: 1 }, factions)).toThrow(/unknown faction/)
  })
})
