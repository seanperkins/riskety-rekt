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

describe("rule dispatch", () => {
  it("boom doubles each faction's income", () => {
    const s = createSeason("s1", factions, ids)
    const base = resolve(s, [], emptyCtx)
    const boomed = resolve(s, [], { ...emptyCtx, rules: ["boom"] })
    for (const f of factions) {
      expect(boomed.reserves[f.id]! - base.reserves[f.id]!).toBe(territoryIncome(s, f.id))
      expect(boomed.log).toContainEqual({
        t: "grant",
        source: "boom",
        faction: f.id,
        amount: territoryIncome(s, f.id),
      })
    }
  })

  it("truce voids every attack but moves still run", () => {
    const s = createSeason("s1", factions, ids)
    const mine = new Set(territoriesOf(s, "f1"))
    const neighborsOf = (id: string) => RISK_MAP.territories.find((t) => t.id === id)!.neighbors
    const attackFrom = [...mine].find((t) => neighborsOf(t).some((n) => !mine.has(n)))!
    const attackTo = neighborsOf(attackFrom).find((n) => !mine.has(n))!
    const moveFrom = [...mine].find((t) => neighborsOf(t).some((n) => mine.has(n)))!
    const moveTo = neighborsOf(moveFrom).find((n) => mine.has(n))!
    const next = resolve(
      s,
      [order({
        factionId: "f1",
        attacks: [{ from: attackFrom, to: attackTo, count: 1 }],
        moves: [{ from: moveFrom, to: moveTo, count: 1 }],
      })],
      { ...emptyCtx, rules: ["truce"] },
    )
    expect(next.log).toContainEqual({
      t: "rejected",
      faction: "f1",
      field: "attacks",
      reason: "protected",
      ref: `attack:${attackFrom}|${attackTo}`,
    })
    expect(next.ownership[attackTo]).toBe(s.ownership[attackTo])
    expect(next.log.some((e) => e.t === "move")).toBe(true)
    // Truce supplies no per-territory events — the recap names the rule.
    expect(next.log.some((e) => e.t === "protected")).toBe(false)
  })

  it("attrition charges the departure fee through the rules path", () => {
    // The review panel's worked case: garrison 3, cost 1, cap g−1 = 2.
    // X→Y 1 consumes 1+1 = 2 (fits); X→Z 1 would need 4 > 2 — rejected.
    const s = createSeason("s1", factions, ids)
    const mine = new Set(territoriesOf(s, "f1"))
    const neighborsOf = (id: string) => RISK_MAP.territories.find((t) => t.id === id)!.neighbors
    const from = [...mine].find((t) => neighborsOf(t).filter((n) => !mine.has(n)).length >= 2)!
    const [y, z] = neighborsOf(from).filter((n) => !mine.has(n))
    const next = resolve(
      s,
      [order({
        factionId: "f1",
        deploys: [{ territory: from, count: 1 }], // garrison 2 → 3
        attacks: [
          { from, to: y!, count: 1 },
          { from, to: z!, count: 1 },
        ],
      })],
      { ...emptyCtx, rules: ["attrition"] },
    )
    const attackEvents = next.log.filter((e) => e.t === "attack")
    expect(attackEvents).toHaveLength(1)
    expect(attackEvents[0]).toMatchObject({ from, committed: 1, fee: 1 })
    expect(next.log.some((e) => e.t === "rejected" && e.field === "attacks")).toBe(true)
    expect(next.garrisons[from]).toBe(1) // 3 − (1 committed + 1 fee)
  })

  it("rule order in ctx.rules does not change output", () => {
    const s = createSeason("s1", factions, ids)
    const a = resolve(s, [], { ...emptyCtx, rules: ["truce", "boom"] })
    const b = resolve(s, [], { ...emptyCtx, rules: ["boom", "truce"] })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it("refuses an unknown rule id, and a module id in ctx.rules", () => {
    const s = createSeason("s1", factions, ids)
    expect(() => resolve(s, [], { ...emptyCtx, rules: ["ghost"] })).toThrow(/unknown rule/)
    expect(() => resolve(s, [], { ...emptyCtx, rules: ["markets"] })).toThrow(/unknown rule/)
  })

  it("a frozen rule replays identically — day-5 semantics come from ctx alone", () => {
    const s = createSeason("s1", factions, ids)
    const ctx = { ...emptyCtx, rules: ["boom"] }
    expect(resolve(s, [], ctx)).toEqual(resolve(s, [], ctx))
  })

  it("a Truce day still logs the veto's protected event", () => {
    // Mechanics run id-sorted, so `truce` locks the whole map — supplying no
    // events by design — BEFORE `veto` runs. Suppressing events on lock-set
    // membership rather than on already-logged territories would swallow the
    // veto here, and an eliminated player's one pick would vanish from the
    // log and the recap with no trace.
    const s = createSeason("s1", factions, ids)
    const target = territoriesOf(s, "f2")[0]!
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2" // f1 eliminated
    const next = resolve(
      s,
      [order({ factionId: "f1", protect: target })],
      { ...emptyCtx, postedToday: ["f1"], rules: ["truce"] },
    )
    expect(next.log).toContainEqual({ t: "protected", territory: target, byCount: 1 })
  })

  it("sole-survivor reads POST-allocation garrisons: a deploy forfeits sanctuary", () => {
    // The rule's central decision, and only the full pipeline can prove it —
    // lock runs at step 4, after deploys land at step 3. Two identical
    // one-troop targets; f1 reinforces exactly one of them.
    const s = createSeason("s1", factions, ids)
    const mine = new Set(territoriesOf(s, "f2"))
    const neighborsOf = (id: string) => RISK_MAP.territories.find((t) => t.id === id)!.neighbors
    const from = [...mine].find((t) => neighborsOf(t).filter((n) => !mine.has(n)).length >= 2)!
    const [a, b] = neighborsOf(from).filter((n) => !mine.has(n))
    // Both targets sit at one troop; f1 owns them and deploys into `a` only.
    s.garrisons[a!] = 1
    s.garrisons[b!] = 1
    s.ownership[a!] = "f1"
    s.ownership[b!] = "f1"
    s.garrisons[from] = 9

    const next = resolve(
      s,
      [
        order({ factionId: "f1", deploys: [{ territory: a!, count: 1 }] }),
        order({
          factionId: "f2",
          attacks: [
            { from, to: a!, count: 2 },
            { from, to: b!, count: 2 },
          ],
        }),
      ],
      { ...emptyCtx, rules: ["sole-survivor"] },
    )

    const voided = next.log.filter(
      (e) => e.t === "rejected" && e.reason === "protected",
    ) as { ref?: string }[]
    // `b` stayed at one troop and is protected; `a` was reinforced and is not.
    expect(voided.map((e) => e.ref)).toEqual([`attack:${from}|${b!}`])
  })

  it("logs one protected event per territory when two mechanics both supply one", () => {
    // What the guard is actually for. The veto is the only shipped mechanic
    // that supplies lock events, and it returns each territory once, so this
    // pins the dedupe against a future second event-supplying mechanic.
    const s = createSeason("s1", factions, ids)
    const target = territoriesOf(s, "f2")[0]!
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    const next = resolve(
      s,
      [order({ factionId: "f1", protect: target })],
      { ...emptyCtx, postedToday: ["f1"] },
    )
    expect(next.log.filter((e) => e.t === "protected")).toHaveLength(1)
  })
})
