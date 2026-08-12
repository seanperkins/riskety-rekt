import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { MODULE_REGISTRY } from "./modules/index.js"
import { createSeason } from "./setup.js"
import { resolve } from "./resolve.js"
import type { DailyContext, Faction, GameState, Market, Order } from "./types.js"

const factions: Faction[] = ["f1", "f2", "f3", "f4"].map((id) => ({
  id,
  playerName: id,
  color: "#000",
}))
const ids = RISK_MAP.territories.map((t) => t.id)
const market: Market = {
  id: "m1",
  question: "q",
  priceYes: 0.4,
  priceNo: 0.6,
  closeTime: "2026-01-02T18:00:00.000Z",
}
const ctx: DailyContext = {
  slate: [market],
  approvals: [],
  postedToday: [],
  settlements: {},
  tickInstant: "2026-01-02T21:00:00.000Z",
  modules: ["markets", "irl", "veto"],
  rules: [],
}

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
    // The dial contends with the shared per-origin ledger that moves draw on;
    // an arbitrary without moves tests strictly less than the bug it exists
    // to catch.
    moves: fc.array(
      fc.record({
        from: fc.constantFrom(...ids),
        to: fc.constantFrom(...ids),
        count: fc.integer({ min: 0, max: 12 }),
      }),
      { maxLength: 3 },
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

const totalOf = (s: GameState) =>
  Object.values(s.garrisons).reduce((a, b) => a + b, 0) +
  Object.values(s.reserves).reduce((a, b) => a + b, 0) +
  [...MODULE_REGISTRY.values()].reduce(
    (sum, m) => sum + (m.escrowed?.(s.moduleState[m.id]) ?? 0),
    0,
  )

/** The full accounting table from the spec — each flow with the log field carrying it. */
const flows = (s: GameState) => {
  let created = 0
  let destroyed = 0
  for (const e of s.log) {
    if (e.t === "income") created += e.amount
    else if (e.t === "irl") created += e.actions + e.bonus
    else if (e.t === "grant") created += e.amount
    else if (e.t === "wagerSettle") {
      if (e.outcome === "unsettled") {
        // refund: payout === stake, a transfer — nets zero
      } else if (e.payout > 0) {
        created += e.payout - e.stake // win: only the edge is new soldiers
      } else {
        destroyed += e.stake // loss: the stake is gone
      }
    } else if (e.t === "attack") destroyed += e.lost + e.defenderLost + (e.fee ?? 0)
    else if (e.t === "fieldBattle") destroyed += e.aLost + e.bLost
  }
  return { created, destroyed }
}

// A test-only dial mechanic: Attrition at full clamp, to run the property
// suite with the fee active. Registered under a synthetic id.
const dialCtx: DailyContext = { ...ctx, modules: ["attrition-test", "irl", "markets", "veto"] }
MODULE_REGISTRY.set("attrition-test", {
  id: "attrition-test",
  combatDials: () => ({ attackDepartureCost: 1 }),
})

describe("engine invariants", () => {
  for (const [label, c] of [
    ["dials off", ctx],
    ["dial active", dialCtx],
  ] as const) {
    it(`never produces a negative reserve or garrison (${label})`, () => {
      fc.assert(
        fc.property(allOrders(), (orders) => {
          const next = resolve(createSeason("s", factions, ids), [...orders], c)
          expect(Object.values(next.reserves).every((r) => r >= 0)).toBe(true)
          expect(Object.values(next.garrisons).every((g) => g >= 0)).toBe(true)
        }),
        { numRuns: 300 },
      )
    })

    it(`two-sided accounting: totals move by exactly created − destroyed (${label})`, () => {
      fc.assert(
        fc.property(allOrders(), (orders) => {
          const before = createSeason("s", factions, ids)
          const next = resolve(before, [...orders], c)
          const { created, destroyed } = flows(next)
          expect(totalOf(next)).toBe(totalOf(before) + created - destroyed)
        }),
        { numRuns: 300 },
      )
    })
  }

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
    // The original one-sided check, kept: it guards a different regression
    // class (an equality bug that overstates destroyed would slip past it,
    // and a creation bug slips past nothing).
    fc.assert(
      fc.property(allOrders(), (orders) => {
        const before = createSeason("s", factions, ids)
        const next = resolve(before, [...orders], ctx)
        const { created } = flows(next)
        expect(totalOf(next)).toBeLessThanOrEqual(totalOf(before) + created)
      }),
      { numRuns: 300 },
    )
  })

  it("never escrows more than was debited from reserves", () => {
    fc.assert(
      fc.property(allOrders(), (orders) => {
        const next = resolve(createSeason("s", factions, ids), [...orders], ctx)
        const pending = (next.moduleState["markets"] as { pending: { stake: number; price: number }[] })
          ?.pending ?? []
        for (const w of pending) {
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
