import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { territoryIncome } from "./income.js"
import { pendingWagersOf } from "./modules/index.js"
import { createSeason, territoriesOf } from "./setup.js"
import { resolve } from "./resolve.js"
import type { DailyContext, Faction, Market, Order } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
]
const ids = RISK_MAP.territories.map((t) => t.id)
const ISO_CLOSE = "2026-01-02T18:00:00.000Z"
const TICK = "2026-01-02T21:00:00.000Z"
const ALL = ["markets", "irl", "veto"]
const market: Market = { id: "m1", question: "q", priceYes: 0.5, priceNo: 0.5, closeTime: ISO_CLOSE }
const emptyCtx: DailyContext = {
  slate: [], approvals: [], postedToday: [], settlements: {},
  tickInstant: TICK, modules: ALL, rules: [],
}
const withSlate: DailyContext = { ...emptyCtx, slate: [market] }

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
    // Income lands at grant, deploys at allocation — so today's income is
    // deployable today. Validating against yesterday's reserve would reject this.
    const s = createSeason("s1", factions, ids)
    const own = territoriesOf(s, "f1")[0]!
    const avail = (s.reserves["f1"] ?? 0) + territoryIncome(s, "f1")
    const next = resolve(s, [order({ factionId: "f1", deploys: [{ territory: own, count: avail }] })], emptyCtx)
    expect(next.garrisons[own]).toBe(2 + avail)
    expect(next.reserves["f1"]).toBe(0)
  })

  it("gives an over-committed reserve to the wager, not the deploy — seniority", () => {
    // The deploy-inflation fix: the wager locked at its market's close (18:00)
    // is senior to a deploy locked at the tick (21:00). When both cannot fit,
    // the DEPLOY drops, with a rejected event naming it.
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
    expect(pendingWagersOf(next)).toHaveLength(1)
    expect(next.garrisons[own]).toBe(2) // the deploy dropped
    expect(next.log).toContainEqual({
      t: "rejected",
      faction: "f1",
      field: "deploys",
      reason: "reserve short",
      ref: `deploy:${own}`,
    })
  })

  it("the phantom-troop case: a dropped deploy shrinks the attack cap", () => {
    // Garrison 2 at the launch point; a senior wager eats the whole reserve,
    // dropping a deploy of `avail` there. The attack sized for the deploy
    // must be rejected at movement validation — 11 troops must not depart a
    // garrison of 2 — and garrisons stay non-negative.
    const s = createSeason("s1", factions, ids)
    const own = territoriesOf(s, "f1")[0]!
    const target = RISK_MAP.territories.find(
      (t) => t.id === own,
    )!.neighbors.find((n) => s.ownership[n] !== "f1")!
    const avail = (s.reserves["f1"] ?? 0) + territoryIncome(s, "f1")
    const next = resolve(
      s,
      [order({
        factionId: "f1",
        deploys: [{ territory: own, count: avail }],
        attacks: [{ from: own, to: target, count: avail + 1 }],
        wagers: [{ marketId: "m1", side: "yes", stake: avail }],
      })],
      withSlate,
    )
    expect(next.log).toContainEqual({
      t: "rejected", faction: "f1", field: "deploys", reason: "reserve short", ref: `deploy:${own}`,
    })
    expect(next.log.some((e) => e.t === "rejected" && e.field === "attacks")).toBe(true)
    expect(Object.values(next.garrisons).every((g) => g >= 0)).toBe(true)
  })

  it("escrows a wager that fits, debiting the reserve", () => {
    const s = createSeason("s1", factions, ids)
    const avail = (s.reserves["f1"] ?? 0) + territoryIncome(s, "f1")
    const next = resolve(
      s,
      [order({ factionId: "f1", wagers: [{ marketId: "m1", side: "yes", stake: 2 }] })],
      withSlate,
    )
    expect(pendingWagersOf(next)).toHaveLength(1)
    expect(pendingWagersOf(next)[0]!.price).toBe(0.5)
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
      ...emptyCtx,
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

  it("is module-order independent — byte-identical regardless of configured order", () => {
    const s = createSeason("s1", factions, ids)
    const orders = [order({ factionId: "f1", wagers: [{ marketId: "m1", side: "yes", stake: 1 }] })]
    const forward = resolve(s, orders, { ...withSlate, modules: ["markets", "irl", "veto"] })
    const reversed = resolve(s, orders, { ...withSlate, modules: ["veto", "irl", "markets"] })
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed))
  })

  it("a season with no modules resolves plain Risk with an empty moduleState", () => {
    const s = createSeason("s1", factions, ids)
    const own = territoriesOf(s, "f1")[0]!
    const next = resolve(
      s,
      [order({ factionId: "f1", deploys: [{ territory: own, count: 1 }] })],
      { ...emptyCtx, modules: [] },
    )
    expect(next.moduleState).toEqual({})
    expect(next.log.some((e) => e.t === "income")).toBe(true)
    expect(next.log.some((e) => e.t === "deploy")).toBe(true)
    expect(next.log.some((e) => e.t === "irl" || e.t === "wagerSettle" || e.t === "protected")).toBe(false)
  })

  it("refuses the tick on an unparseable lockedAt", () => {
    const s = createSeason("s1", factions, ids)
    const bad: Market = { ...market, closeTime: "T18:00" }
    expect(() =>
      resolve(
        s,
        [order({ factionId: "f1", wagers: [{ marketId: "m1", side: "yes", stake: 1 }] })],
        { ...emptyCtx, slate: [bad] },
      ),
    ).toThrow(/lockedAt/)
  })

  it("pays an eliminated faction no income", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    const next = resolve(s, [], emptyCtx)
    expect(next.reserves["f1"]).toBe(0)
  })
})
