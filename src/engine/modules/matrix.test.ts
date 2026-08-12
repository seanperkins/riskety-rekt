import { afterEach, describe, expect, it } from "vitest"
import { MODULE_REGISTRY } from "./index.js"
import { RISK_MAP } from "../map.js"
import { resolve } from "../resolve.js"
import { createSeason, territoriesOf } from "../setup.js"
import type { DailyContext, Faction, Order } from "../types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
]
const ids = RISK_MAP.territories.map((t) => t.id)

const ctx = (modules: string[], o: Partial<DailyContext> = {}): DailyContext => ({
  slate: [
    { id: "m1", question: "q", priceYes: 0.5, priceNo: 0.5, closeTime: "2026-01-02T18:00:00.000Z" },
  ],
  approvals: [{ eventId: "e1", playerId: "f1", postedAt: "T06:00", approvedAt: "T06:30" }],
  postedToday: ["f1"],
  settlements: {},
  tickInstant: "2026-01-02T21:00:00.000Z",
  modules,
  rules: [],
  ...o,
})

const order = (o: Partial<Order> & { factionId: string }): Order => ({
  deploys: [],
  attacks: [],
  wagers: [],
  protect: null,
  ...o,
})

const eventTypes = (log: { t: string }[]) => new Set(log.map((e) => e.t))

describe("module isolation matrix", () => {
  const busyOrders = () => [
    order({ factionId: "f1", wagers: [{ marketId: "m1", side: "yes", stake: 1 }] }),
    order({ factionId: "f2" }),
  ]

  it("markets only: wagers escrow, no irl or protected events", () => {
    const next = resolve(createSeason("s", factions, ids), busyOrders(), ctx(["markets"]))
    expect(Object.keys(next.moduleState)).toEqual(["markets"])
    expect(eventTypes(next.log).has("irl")).toBe(false)
    expect(eventTypes(next.log).has("protected")).toBe(false)
    const pending = (next.moduleState["markets"] as { pending: unknown[] }).pending
    expect(pending).toHaveLength(1)
  })

  it("irl only: grants credit, wagers reject against the empty machinery", () => {
    const next = resolve(createSeason("s", factions, ids), busyOrders(), ctx(["irl"]))
    expect(next.moduleState).toEqual({})
    expect(eventTypes(next.log).has("irl")).toBe(true)
    expect(eventTypes(next.log).has("wagerSettle")).toBe(false)
    // The wager order field is inert without the module: no claim spends it.
    expect(next.log.some((e) => e.t === "deploy" && e.faction === "f1")).toBe(false)
  })

  it("irl + veto: an eliminated poster's protect works, markets stays silent", () => {
    const s = createSeason("s", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    expect(territoriesOf(s, "f1")).toHaveLength(0)
    const next = resolve(
      s,
      [order({ factionId: "f1", protect: ids[0]! })],
      ctx(["irl", "veto"]),
    )
    expect(eventTypes(next.log).has("protected")).toBe(true)
    expect(eventTypes(next.log).has("wagerSettle")).toBe(false)
  })

  it("veto alone refuses at the registry — discovered at init, not at tick time", () => {
    expect(() =>
      resolve(createSeason("s", factions, ids), [], ctx(["veto"])),
    ).toThrow(/veto requires irl/)
  })
})

describe("malformed hook returns refuse the tick", () => {
  afterEach(() => {
    MODULE_REGISTRY.delete("bad-test")
  })

  const withBad = (grant: () => { faction: string; amount: number; event: never }[]) => {
    MODULE_REGISTRY.set("bad-test", {
      id: "bad-test",
      grant: grant as never,
    })
    return () => resolve(createSeason("s", factions, ids), [], ctx(["bad-test"]))
  }

  it("a negative amount", () => {
    const run = withBad(() => [
      { faction: "f1", amount: -1, event: { t: "grant", source: "bad-test", faction: "f1", amount: -1 } as never },
    ])
    expect(run).toThrow(/bad amount/)
  })

  it("a fractional amount", () => {
    const run = withBad(() => [
      { faction: "f1", amount: 1.5, event: { t: "grant", source: "bad-test", faction: "f1", amount: 1.5 } as never },
    ])
    expect(run).toThrow(/bad amount/)
  })

  it("an unknown faction", () => {
    const run = withBad(() => [
      { faction: "ghost", amount: 1, event: { t: "grant", source: "bad-test", faction: "ghost", amount: 1 } as never },
    ])
    expect(run).toThrow(/unknown faction/)
  })

  it("a spend claim with an unparseable lockedAt", () => {
    MODULE_REGISTRY.set("bad-test", {
      id: "bad-test",
      spend: () => [{ faction: "f1", amount: 1, lockedAt: "T18:00", ref: "x" }],
    })
    expect(() => resolve(createSeason("s", factions, ids), [], ctx(["bad-test"]))).toThrow(
      /lockedAt/,
    )
  })
})
