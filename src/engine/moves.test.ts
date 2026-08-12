import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason } from "./setup.js"
import { resolveCombat } from "./combat.js"
import { validateOrder } from "./validate.js"
import type { DailyContext, Faction, GameState, Order } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
  { id: "f3", playerName: "Cy", color: "#11e" },
]
const ids = RISK_MAP.territories.map((t) => t.id)

const order = (o: Partial<Order> & { factionId: string }): Order => ({
  deploys: [],
  attacks: [],
  wagers: [],
  protect: null,
  ...o,
})

function board(setup: (s: GameState) => void): GameState {
  const s = createSeason("s1", factions, ids)
  for (const t of RISK_MAP.territories) {
    s.ownership[t.id] = "f3"
    s.garrisons[t.id] = 1
  }
  setup(s)
  return s
}

describe("moves in combat", () => {
  it("transfers troops and emits the event", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 8
      s.ownership["alberta"] = "f1"
      s.garrisons["alberta"] = 2
    })
    const r = resolveCombat(
      s,
      [order({ factionId: "f1", moves: [{ from: "alaska", to: "alberta", count: 5 }] })],
      new Set(), { attackDepartureCost: 0 },
    )
    expect(r.garrisons["alaska"]).toBe(3)
    expect(r.garrisons["alberta"]).toBe(7)
    expect(r.events).toContainEqual({
      t: "move",
      faction: "f1",
      from: "alaska",
      to: "alberta",
      count: 5,
    })
  })

  it("arrivals DEFEND the destination the same night", () => {
    // The design decision, pinned: reinforcement, not logistics. 2 base + 5
    // arriving = 7 defending, so an attack of 7 holds and one of 8 takes.
    const setup = (s: GameState): void => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 8
      s.ownership["alberta"] = "f1"
      s.garrisons["alberta"] = 2
      s.ownership["ontario"] = "f2"
      s.garrisons["ontario"] = 20
    }
    const held = resolveCombat(
      board(setup),
      [
        order({ factionId: "f1", moves: [{ from: "alaska", to: "alberta", count: 5 }] }),
        order({ factionId: "f2", attacks: [{ from: "ontario", to: "alberta", count: 7 }] }),
      ],
      new Set(), { attackDepartureCost: 0 },
    )
    expect(held.ownership["alberta"]).toBe("f1")
    expect(held.garrisons["alberta"]).toBe(0)

    const taken = resolveCombat(
      board(setup),
      [
        order({ factionId: "f1", moves: [{ from: "alaska", to: "alberta", count: 5 }] }),
        order({ factionId: "f2", attacks: [{ from: "ontario", to: "alberta", count: 8 }] }),
      ],
      new Set(), { attackDepartureCost: 0 },
    )
    expect(taken.ownership["alberta"]).toBe("f2")
    expect(taken.garrisons["alberta"]).toBe(1)
  })

  it("lets two territories swap in one night", () => {
    // All departures are summed before any arrival lands, so a swap cannot
    // depend on application order.
    const s = board((s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 6
      s.ownership["alberta"] = "f1"
      s.garrisons["alberta"] = 4
    })
    const r = resolveCombat(
      s,
      [
        order({
          factionId: "f1",
          moves: [
            { from: "alaska", to: "alberta", count: 5 },
            { from: "alberta", to: "alaska", count: 3 },
          ],
        }),
      ],
      new Set(), { attackDepartureCost: 0 },
    )
    expect(r.garrisons["alaska"]).toBe(4)
    expect(r.garrisons["alberta"]).toBe(6)
  })

  it("conserves troops", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 8
      s.ownership["alberta"] = "f1"
      s.garrisons["alberta"] = 2
    })
    const before = Object.values(s.garrisons).reduce((a, b) => a + b, 0)
    const r = resolveCombat(
      s,
      [order({ factionId: "f1", moves: [{ from: "alaska", to: "alberta", count: 7 }] })],
      new Set(), { attackDepartureCost: 0 },
    )
    const after = Object.values(r.garrisons).reduce((a, b) => a + b, 0)
    expect(after).toBe(before)
  })
})

describe("move validation", () => {
  const ctx: DailyContext = {
    slate: [],
    approvals: [],
    postedToday: [],
    settlements: {},
    tickInstant: "2026-01-02T21:00:00.000Z",
    modules: [],
    rules: [],
  }

  const state = (): GameState => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) {
      s.ownership[t.id] = "f2"
      s.garrisons[t.id] = 1
    }
    s.ownership["alaska"] = "f1"
    s.garrisons["alaska"] = 6
    s.ownership["alberta"] = "f1"
    s.garrisons["alberta"] = 2
    s.reserves["f1"] = 4
    return s
  }

  it("accepts an owned, adjacent move within the cap", () => {
    const { clean, rejections } = validateOrder(state(), {
      factionId: "f1",
      deploys: [],
      attacks: [],
      moves: [{ from: "alaska", to: "alberta", count: 5 }],
      wagers: [],
      protect: null,
    }, ctx)
    expect(rejections).toEqual([])
    expect(clean.moves).toHaveLength(1)
  })

  it("rejects a move into a territory that is not yours", () => {
    const { clean, rejections } = validateOrder(state(), {
      factionId: "f1",
      deploys: [],
      attacks: [],
      moves: [{ from: "alaska", to: "northwest_territories", count: 2 }],
      wagers: [],
      protect: null,
    }, ctx)
    expect(clean.moves).toHaveLength(0)
    expect(rejections.some((r) => r.t === "rejected" && r.field === "moves")).toBe(true)
  })

  it("shares the per-origin cap with attacks, and the move wins the collision", () => {
    // Caps now live in combat's movement validation, against post-allocation
    // garrisons. Moves still validate first on purpose: when an origin is
    // over-committed the reinforcement survives and the attack dies, because
    // a rejected defence loses ground already held while a rejected attack
    // merely fails to gain.
    const s = state()
    const r = resolveCombat(
      s,
      [
        order({
          factionId: "f1",
          attacks: [{ from: "alaska", to: "northwest_territory", count: 3 }],
          moves: [{ from: "alaska", to: "alberta", count: 4 }],
        }),
      ],
      new Set(), { attackDepartureCost: 0 },
    )
    // cap = 6 - 1 = 5: the 4-troop move fits, the 3-troop attack no longer does.
    expect(r.events).toContainEqual({
      t: "move", faction: "f1", from: "alaska", to: "alberta", count: 4,
    })
    expect(r.events.filter((e) => e.t === "attack")).toHaveLength(0)
    expect(
      r.events.some((e) => e.t === "rejected" && e.field === "attacks"),
    ).toBe(true)
    expect(r.garrisons["alaska"]).toBe(2)
  })

  it("counts tonight's landed deploys toward the origin's cap", () => {
    // Deploys land at allocation, BEFORE combat computes caps — so combat's
    // entry garrisons already carry them. 6 base + 4 landed - 1 to hold = 9
    // may leave. (The integration through resolve() is pinned by the
    // phantom-troop test in resolve.test.ts.)
    const s = state()
    s.garrisons["alaska"] = 10 // post-allocation: 6 base + 4 landed deploys
    const r = resolveCombat(
      s,
      [order({ factionId: "f1", moves: [{ from: "alaska", to: "alberta", count: 9 }] })],
      new Set(), { attackDepartureCost: 0 },
    )
    expect(r.events.filter((e) => e.t === "rejected")).toEqual([])
    expect(r.garrisons["alberta"]).toBe(11)
  })

  it("treats an order without a moves field as having none", () => {
    const { clean, rejections } = validateOrder(state(), {
      factionId: "f1",
      deploys: [],
      attacks: [],
      wagers: [],
      protect: null,
    }, ctx)
    expect(rejections).toEqual([])
    expect(clean.moves).toEqual([])
  })
})
