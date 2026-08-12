import { describe, expect, it } from "vitest"
import { ENGINE_VERSION } from "../types.js"
import { fortressRule } from "./fortress.js"
import { mainCharacterRule } from "./main-character.js"
import { regionalManagerRule } from "./regional-manager.js"
import { soleSurvivorRule } from "./sole-survivor.js"
import type { DailyContext, GameMap, GameState, Order } from "../types.js"

const ctx = (over: Partial<DailyContext> = {}): DailyContext => ({
  slate: [],
  approvals: [],
  postedToday: [],
  settlements: {},
  tickInstant: "2026-09-01T21:00:00.000Z",
  modules: [],
  rules: [],
  ...over,
})

/** Four territories, two regions — small enough to reason about exactly. */
const MAP: GameMap = {
  regions: [
    { id: "r1", name: "One", bonus: 1 },
    { id: "r2", name: "Two", bonus: 1 },
  ],
  territories: [
    { id: "t1", name: "T1", region: "r1", neighbors: ["t2"] },
    { id: "t2", name: "T2", region: "r1", neighbors: ["t1", "t3"] },
    { id: "t3", name: "T3", region: "r2", neighbors: ["t2", "t4"] },
    { id: "t4", name: "T4", region: "r2", neighbors: ["t3"] },
  ],
}

function state(
  ownership: Record<string, string>,
  garrisons: Record<string, number>,
): GameState {
  return {
    seasonId: "s",
    day: 1,
    map: MAP,
    factions: ["f1", "f2"].map((id) => ({ id, playerName: id, color: "#000" })),
    ownership,
    garrisons,
    reserves: { f1: 0, f2: 0 },
    moduleState: {},
    log: [],
    engineVersion: ENGINE_VERSION,
  }
}

const order = (o: Partial<Order> & { factionId: string }): Order => ({
  deploys: [],
  attacks: [],
  wagers: [],
  protect: null,
  ...o,
})

const locked = (rs: { territory: string }[]) => rs.map((r) => r.territory)

describe("sole-survivor — Sole Survivor", () => {
  const s = state(
    { t1: "f1", t2: "f1", t3: "f2", t4: "f2" },
    { t1: 1, t2: 5, t3: 1, t4: 2 },
  )

  it("locks exactly the one-troop territories", () => {
    expect(locked(soleSurvivorRule.lock!(s, [], ctx()))).toEqual(["t1", "t3"])
  })

  it("supplies no events — a busy map would bury the log", () => {
    expect(soleSurvivorRule.lock!(s, [], ctx()).every((r) => r.event === undefined)).toBe(true)
  })

  it("does not lock an empty or over-strength territory", () => {
    const none = state({ t1: "f1" }, { t1: 0, t2: 2 })
    expect(soleSurvivorRule.lock!(none, [], ctx())).toEqual([])
  })
})

describe("regional-manager — Regional Manager", () => {
  it("locks the region with the most distinct owners", () => {
    // r1 has two owners, r2 has one.
    const s = state({ t1: "f1", t2: "f2", t3: "f1", t4: "f1" }, { t1: 1, t2: 1, t3: 1, t4: 1 })
    expect(locked(regionalManagerRule.lock!(s, [], ctx()))).toEqual(["t1", "t2"])
  })

  it("breaks a tie on region id", () => {
    // Both regions hold two owners; r1 sorts first.
    const s = state({ t1: "f1", t2: "f2", t3: "f1", t4: "f2" }, { t1: 1, t2: 1, t3: 1, t4: 1 })
    expect(locked(regionalManagerRule.lock!(s, [], ctx()))).toEqual(["t1", "t2"])
  })

  it("supplies no events", () => {
    const s = state({ t1: "f1", t2: "f2", t3: "f1", t4: "f1" }, { t1: 1, t2: 1, t3: 1, t4: 1 })
    expect(regionalManagerRule.lock!(s, [], ctx()).every((r) => r.event === undefined)).toBe(true)
  })
})

describe("too-big-to-fail — Too Big to Fail", () => {
  it("locks each faction's single largest garrison", () => {
    const s = state({ t1: "f1", t2: "f1", t3: "f2", t4: "f2" }, { t1: 3, t2: 9, t3: 7, t4: 2 })
    expect(locked(fortressRule.lock!(s, [], ctx())).sort()).toEqual(["t2", "t3"])
  })

  it("breaks a within-faction tie on territory id", () => {
    const s = state({ t1: "f1", t2: "f1", t3: "f2", t4: "f2" }, { t1: 4, t2: 4, t3: 1, t4: 1 })
    expect(locked(fortressRule.lock!(s, [], ctx()))).toContain("t1")
    expect(locked(fortressRule.lock!(s, [], ctx()))).not.toContain("t2")
  })

  it("skips a faction holding nothing", () => {
    const s = state({ t1: "f1", t2: "f1", t3: "f1", t4: "f1" }, { t1: 1, t2: 2, t3: 3, t4: 4 })
    expect(locked(fortressRule.lock!(s, [], ctx()))).toEqual(["t4"])
  })
})

describe("main-character — Main Character Energy", () => {
  const s = state({ t1: "f1", t2: "f1", t3: "f2", t4: "f2" }, { t1: 5, t2: 5, t3: 5, t4: 5 })

  it("locks the most-attacked territory and logs it with its count", () => {
    const orders = [
      order({ factionId: "f1", attacks: [{ from: "t2", to: "t3", count: 1 }] }),
      order({ factionId: "f2", attacks: [{ from: "t3", to: "t2", count: 1 }] }),
      order({ factionId: "f1", attacks: [{ from: "t1", to: "t3", count: 1 }] }),
    ]
    const out = mainCharacterRule.lock!(s, orders, ctx())
    expect(out).toEqual([
      { territory: "t3", event: { t: "protected", territory: "t3", byCount: 2 } },
    ])
  })

  it("breaks a tie on territory id", () => {
    const orders = [
      order({ factionId: "f1", attacks: [{ from: "t2", to: "t3", count: 1 }] }),
      order({ factionId: "f2", attacks: [{ from: "t3", to: "t2", count: 1 }] }),
    ]
    expect(locked(mainCharacterRule.lock!(s, orders, ctx()))).toEqual(["t2"])
  })

  it("locks nothing and logs nothing on a day with no attacks", () => {
    expect(mainCharacterRule.lock!(s, [order({ factionId: "f1" })], ctx())).toEqual([])
  })
})

describe("every lock rule", () => {
  const rules = [soleSurvivorRule, regionalManagerRule, fortressRule, mainCharacterRule]

  it("mutates nothing it is given", () => {
    const s = state({ t1: "f1", t2: "f2", t3: "f1", t4: "f2" }, { t1: 1, t2: 3, t3: 1, t4: 9 })
    const orders = [order({ factionId: "f1", attacks: [{ from: "t1", to: "t2", count: 1 }] })]
    const beforeState = JSON.stringify(s)
    const beforeOrders = JSON.stringify(orders)
    for (const r of rules) r.lock!(s, orders, ctx())
    expect(JSON.stringify(s)).toBe(beforeState)
    expect(JSON.stringify(orders)).toBe(beforeOrders)
  })

  it("returns territories that exist on the map", () => {
    const s = state({ t1: "f1", t2: "f2", t3: "f1", t4: "f2" }, { t1: 1, t2: 3, t3: 1, t4: 9 })
    const orders = [order({ factionId: "f1", attacks: [{ from: "t1", to: "t2", count: 1 }] })]
    const ids = new Set(MAP.territories.map((t) => t.id))
    for (const r of rules) {
      for (const res of r.lock!(s, orders, ctx())) expect(ids.has(res.territory)).toBe(true)
    }
  })
})
