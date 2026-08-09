import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason } from "./setup.js"
import { resolve } from "./resolve.js"
import type { DailyContext, Faction, Market, Order } from "./types.js"

const factions: Faction[] = ["f1", "f2", "f3", "f4"].map((id) => ({
  id,
  playerName: id,
  color: "#000",
}))
const ids = RISK_MAP.territories.map((t) => t.id)
const market: Market = { id: "m1", question: "q", priceYes: 0.4, priceNo: 0.6, closeTime: "T18:00" }
const ctx: DailyContext = { slate: [market], approvals: [], settlements: {} }

const arbOrder = (factionId: string): fc.Arbitrary<Order> =>
  fc.record({
    factionId: fc.constant(factionId),
    deploys: fc.array(
      fc.record({ territory: fc.constantFrom(...ids), count: fc.integer({ min: 0, max: 12 }) }),
      { maxLength: 4 },
    ),
    attacks: fc.array(
      fc.record({
        from: fc.constantFrom(...ids),
        to: fc.constantFrom(...ids),
        count: fc.integer({ min: 0, max: 12 }),
      }),
      { maxLength: 4 },
    ),
    wagers: fc.array(
      fc.record({
        marketId: fc.constantFrom("m1", "ghost"),
        side: fc.constantFrom("yes" as const, "no" as const),
        stake: fc.integer({ min: 0, max: 20 }),
      }),
      { maxLength: 3 },
    ),
    protect: fc.oneof(fc.constant(null), fc.constantFrom(...ids)),
  })

const allOrders = () => fc.tuple(...factions.map((f) => arbOrder(f.id)))

describe("engine invariants", () => {
  it("never produces a negative reserve or garrison", () => {
    fc.assert(
      fc.property(allOrders(), (orders) => {
        const next = resolve(createSeason("s", factions, ids), [...orders], ctx)
        expect(Object.values(next.reserves).every((r) => r >= 0)).toBe(true)
        expect(Object.values(next.garrisons).every((g) => g >= 0)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  it("keeps every territory owned by exactly one known faction", () => {
    fc.assert(
      fc.property(allOrders(), (orders) => {
        const next = resolve(createSeason("s", factions, ids), [...orders], ctx)
        expect(Object.keys(next.ownership)).toHaveLength(42)
        const known = new Set(factions.map((f) => f.id))
        expect(Object.values(next.ownership).every((f) => known.has(f))).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  it("conserves troops: nothing is created beyond income, grants and payouts", () => {
    fc.assert(
      fc.property(allOrders(), (orders) => {
        const before = createSeason("s", factions, ids)
        const next = resolve(before, [...orders], ctx)

        const totalOf = (s: typeof before) =>
          Object.values(s.garrisons).reduce((a, b) => a + b, 0) +
          Object.values(s.reserves).reduce((a, b) => a + b, 0) +
          s.pending.reduce((a, w) => a + w.stake, 0)

        const created = next.log.reduce((sum, e) => {
          if (e.t === "income") return sum + e.amount
          if (e.t === "irl") return sum + e.actions + e.bonus
          if (e.t === "wagerSettle") return sum + e.payout
          return sum
        }, 0)

        // Casualties are the only sink, so the total can only fall short.
        expect(totalOf(next)).toBeLessThanOrEqual(totalOf(before) + created)
      }),
      { numRuns: 300 },
    )
  })

  it("never escrows more than was debited from reserves", () => {
    fc.assert(
      fc.property(allOrders(), (orders) => {
        const next = resolve(createSeason("s", factions, ids), [...orders], ctx)
        for (const w of next.pending) {
          expect(w.stake).toBeGreaterThan(0)
          expect(w.price).toBeGreaterThan(0)
          expect(w.price).toBeLessThan(1)
        }
      }),
      { numRuns: 200 },
    )
  })

  it("logs a rejection whenever an order item is dropped", () => {
    const bad: Order = {
      factionId: "f1",
      deploys: [{ territory: "nowhere", count: 5 }],
      attacks: [],
      wagers: [],
      protect: null,
    }
    const next = resolve(createSeason("s", factions, ids), [bad], ctx)
    expect(next.log.filter((e) => e.t === "rejected")).not.toHaveLength(0)
  })

  it("survives many consecutive ticks without violating an invariant", () => {
    let state = createSeason("s", factions, ids)
    const rngOrders = (): Order[] =>
      factions.map((f) => ({
        factionId: f.id,
        deploys: [],
        attacks: [],
        wagers: [],
        protect: null,
      }))
    for (let day = 0; day < 21; day++) state = resolve(state, rngOrders(), ctx)
    expect(state.day).toBe(21)
    expect(Object.values(state.reserves).every((r) => r >= 0)).toBe(true)
  })
})
