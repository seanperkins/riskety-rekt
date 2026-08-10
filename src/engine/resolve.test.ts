import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { territoryIncome } from "./income.js"
import { createSeason, territoriesOf } from "./setup.js"
import { resolve } from "./resolve.js"
import type { DailyContext, Faction, Market, Order } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
]
const ids = RISK_MAP.territories.map((t) => t.id)
const market: Market = { id: "m1", question: "q", priceYes: 0.5, priceNo: 0.5, closeTime: "T18:00" }
const emptyCtx: DailyContext = { slate: [], approvals: [], postedToday: [], settlements: {} }
const withSlate: DailyContext = { slate: [market], approvals: [], postedToday: [], settlements: {} }

const order = (o: Partial<Order> & { factionId: string }): Order => ({
  deploys: [],
  attacks: [],
  wagers: [],
  protect: null,
  ...o,
})

describe("resolve", () => {
  it("advances the day and stamps the engine version", () => {
    const next = resolve(createSeason("s1", factions, ids), [], emptyCtx)
    expect(next.day).toBe(1)
    expect(next.engineVersion).toBe("1.0.0")
  })

  it("does not mutate the input state", () => {
    const s = createSeason("s1", factions, ids)
    const snapshot = JSON.stringify(s)
    resolve(s, [order({ factionId: "f1" })], emptyCtx)
    expect(JSON.stringify(s)).toBe(snapshot)
  })

  it("grants income into reserves", () => {
    const next = resolve(createSeason("s1", factions, ids), [], emptyCtx)
    expect(next.reserves["f1"]).toBeGreaterThanOrEqual(5)
  })

  it("lets a faction deploy the income it earned this same tick", () => {
    // Income lands at step 3, deploys at step 4 — so today's income is deployable
    // today. Validating against yesterday's reserve would reject this.
    const s = createSeason("s1", factions, ids)
    const own = territoriesOf(s, "f1")[0]!
    const avail = (s.reserves["f1"] ?? 0) + territoryIncome(s, "f1")
    const next = resolve(s, [order({ factionId: "f1", deploys: [{ territory: own, count: avail }] })], emptyCtx)
    expect(next.garrisons[own]).toBe(2 + avail)
    expect(next.reserves["f1"]).toBe(0)
  })

  it("escrows wagers after deploys, so committed troops cannot be staked", () => {
    const s = createSeason("s1", factions, ids)
    const own = territoriesOf(s, "f1")[0]!
    const avail = (s.reserves["f1"] ?? 0) + territoryIncome(s, "f1")
    const next = resolve(
      s,
      [order({
        factionId: "f1",
        deploys: [{ territory: own, count: avail }],
        wagers: [{ marketId: "m1", side: "yes", stake: 1 }],
      })],
      withSlate,
    )
    expect(next.pending).toHaveLength(0)
  })

  it("escrows a wager that fits, debiting the reserve", () => {
    const s = createSeason("s1", factions, ids)
    const avail = (s.reserves["f1"] ?? 0) + territoryIncome(s, "f1")
    const next = resolve(
      s,
      [order({ factionId: "f1", wagers: [{ marketId: "m1", side: "yes", stake: 2 }] })],
      withSlate,
    )
    expect(next.pending).toHaveLength(1)
    expect(next.pending[0]!.price).toBe(0.5)
    expect(next.reserves["f1"]).toBe(avail - 2)
  })

  it("keeps reserves non-negative under an all-in order", () => {
    const s = createSeason("s1", factions, ids)
    const avail = (s.reserves["f1"] ?? 0) + territoryIncome(s, "f1")
    const next = resolve(
      s,
      [order({ factionId: "f1", wagers: [{ marketId: "m1", side: "yes", stake: avail }] })],
      withSlate,
    )
    expect(next.reserves["f1"]).toBe(0)
  })

  it("credits IRL grants", () => {
    const s = createSeason("s1", factions, ids)
    const ctx: DailyContext = {
      slate: [],
      settlements: {},
      approvals: [{ eventId: "e1", playerId: "f1", postedAt: "T06:00", approvedAt: "T06:30" }],
      postedToday: ["f1"],
    }
    const base = resolve(s, [], emptyCtx).reserves["f1"]!
    const withIrl = resolve(s, [], ctx).reserves["f1"]!
    expect(withIrl - base).toBe(2) // 1 action + Early Bird
  })

  it("records rejections in the log", () => {
    const next = resolve(
      createSeason("s1", factions, ids),
      [order({ factionId: "f1", deploys: [{ territory: "not_a_place", count: 1 }] })],
      emptyCtx,
    )
    expect(next.log.some((e) => e.t === "rejected")).toBe(true)
  })

  it("is deterministic — same inputs, identical output", () => {
    const s = createSeason("s1", factions, ids)
    const orders = [order({ factionId: "f1" }), order({ factionId: "f2" })]
    expect(resolve(s, orders, emptyCtx)).toEqual(resolve(s, orders, emptyCtx))
  })

  it("is order-independent in the orders array", () => {
    const s = createSeason("s1", factions, ids)
    const a = order({ factionId: "f1" })
    const b = order({ factionId: "f2" })
    expect(resolve(s, [a, b], emptyCtx)).toEqual(resolve(s, [b, a], emptyCtx))
  })

  it("pays an eliminated faction no income", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    const next = resolve(s, [], emptyCtx)
    expect(next.reserves["f1"]).toBe(0)
  })
})
