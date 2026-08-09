import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason } from "./setup.js"
import { resolveCombat } from "./combat.js"
import type { Faction, GameState, Order } from "./types.js"

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

function board(fs: Faction[], setup: (s: GameState) => void): GameState {
  const s = createSeason("s1", fs, ids)
  for (const t of RISK_MAP.territories) {
    s.ownership[t.id] = "f3"
    s.garrisons[t.id] = 1
  }
  setup(s)
  return s
}

describe("attack resolution", () => {
  it("captures when attack exceeds defense, survivors = attack - defense", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 3
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
    ])
    expect(r.ownership["alberta"]).toBe("f1")
    expect(r.garrisons["alberta"]).toBe(6)
    expect(r.garrisons["alaska"]).toBe(1)
  })

  it("destroys the attacker when attack equals defense, leaving a 0-troop territory", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 4
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 3
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 3 }] }),
    ])
    expect(r.ownership["alberta"]).toBe("f2")
    expect(r.garrisons["alberta"]).toBe(0)
  })

  it("defends with the post-departure garrison", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 5
      s.ownership["northwest_territory"] = "f3"
      s.garrisons["northwest_territory"] = 1
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "northwest_territory", count: 9 }] }),
      order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 2 }] }),
    ])
    // alaska sent 9 of 10 out, so it defends with 1 and falls to a 2-troop attack
    expect(r.ownership["alaska"]).toBe("f2")
    expect(r.ownership["northwest_territory"]).toBe("f1")
  })
})

describe("field battles", () => {
  it("destroys the smaller force and continues at a - 2b", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 11
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 5
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 10 }] }),
      order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 1 }] }),
    ])
    // 10 - 2*1 = 8 continues; alberta defends post-departure with 4 -> captured with 4
    expect(r.ownership["alberta"]).toBe("f1")
    expect(r.garrisons["alberta"]).toBe(4)
  })

  it("destroys both forces when equal, and neither advances", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 6
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 6
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 5 }] }),
      order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 5 }] }),
    ])
    expect(r.ownership["alaska"]).toBe("f1")
    expect(r.ownership["alberta"]).toBe("f2")
    expect(r.garrisons["alaska"]).toBe(1)
    expect(r.garrisons["alberta"]).toBe(1)
  })

  it("a 1-troop feint no longer voids a large assault (regression)", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 101
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 3
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 100 }] }),
      order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 1 }] }),
    ])
    expect(r.ownership["alberta"]).toBe("f1")
  })

  it("charges the attacker only twice the feint, not the whole assault", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 101
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 3
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 100 }] }),
      order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 1 }] }),
    ])
    // 100 committed, 2 lost in the field, 98 arrive vs a post-departure defense of 2
    expect(r.garrisons["alberta"]).toBe(96)
  })
})

describe("multi-attacker", () => {
  it("gives the territory to the largest surviving force", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 9
      s.ownership["northwest_territory"] = "f2"
      s.garrisons["northwest_territory"] = 9
      s.ownership["alberta"] = "f3"
      s.garrisons["alberta"] = 5
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 3 }] }),
      order({ factionId: "f2", attacks: [{ from: "northwest_territory", to: "alberta", count: 4 }] }),
    ])
    // A=7 > D=5; casualties 2/3; survivors 1/1; tie -> larger original force (f2)
    expect(r.ownership["alberta"]).toBe("f2")
    expect(r.garrisons["alberta"]).toBe(1)
  })

  it("returns losing attackers' survivors to their origin", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 9
      s.ownership["northwest_territory"] = "f2"
      s.garrisons["northwest_territory"] = 9
      s.ownership["alberta"] = "f3"
      s.garrisons["alberta"] = 5
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 3 }] }),
      order({ factionId: "f2", attacks: [{ from: "northwest_territory", to: "alberta", count: 4 }] }),
    ])
    // f1 kept 6 at home and gets its single survivor back
    expect(r.garrisons["alaska"]).toBe(7)
  })

  it("destroys all attackers when the coalition does not exceed defense", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 5
      s.ownership["northwest_territory"] = "f2"
      s.garrisons["northwest_territory"] = 5
      s.ownership["alberta"] = "f3"
      s.garrisons["alberta"] = 10
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 4 }] }),
      order({ factionId: "f2", attacks: [{ from: "northwest_territory", to: "alberta", count: 4 }] }),
    ])
    expect(r.ownership["alberta"]).toBe("f3")
    expect(r.garrisons["alberta"]).toBe(2)
    expect(r.garrisons["alaska"]).toBe(1)
  })
})

describe("protections", () => {
  it("voids attacks on a protected territory and leaves troops home", () => {
    const s = board(factions, (s) => {
      for (const t of RISK_MAP.territories) s.ownership[t.id] = "f1"
      s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 1
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f3", protect: "alberta" }),
    ])
    expect(r.ownership["alberta"]).toBe("f2")
    expect(r.garrisons["alaska"]).toBe(10)
  })

  it("cancels protection when two eliminated factions pick the same territory", () => {
    const four = [...factions, { id: "f4", playerName: "Dee", color: "#ee1" }]
    const s = board(four, (s) => {
      for (const t of RISK_MAP.territories) s.ownership[t.id] = "f1"
      s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 1
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f3", protect: "alberta" }),
      order({ factionId: "f4", protect: "alberta" }),
    ])
    expect(r.ownership["alberta"]).toBe("f1")
  })

  it("re-protects on a third pick", () => {
    const five = [
      ...factions,
      { id: "f4", playerName: "Dee", color: "#ee1" },
      { id: "f5", playerName: "Eli", color: "#1ee" },
    ]
    const s = board(five, (s) => {
      for (const t of RISK_MAP.territories) s.ownership[t.id] = "f1"
      s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 1
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f3", protect: "alberta" }),
      order({ factionId: "f4", protect: "alberta" }),
      order({ factionId: "f5", protect: "alberta" }),
    ])
    expect(r.ownership["alberta"]).toBe("f2")
    expect(r.garrisons["alaska"]).toBe(10)
  })

  it("ignores a protect pick from a living faction", () => {
    const s = board(factions, (s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 1
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f2", protect: "alberta" }), // f2 still holds alberta
    ])
    expect(r.ownership["alberta"]).toBe("f1")
  })
})

describe("determinism", () => {
  it("is independent of order array sequence", () => {
    const build = () =>
      board(factions, (s) => {
        s.ownership["alaska"] = "f1"
        s.garrisons["alaska"] = 9
        s.ownership["northwest_territory"] = "f2"
        s.garrisons["northwest_territory"] = 9
        s.ownership["alberta"] = "f3"
        s.garrisons["alberta"] = 5
      })
    const a = order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 3 }] })
    const b = order({ factionId: "f2", attacks: [{ from: "northwest_territory", to: "alberta", count: 4 }] })
    const r1 = resolveCombat(build(), [a, b])
    const r2 = resolveCombat(build(), [b, a])
    expect(r1.ownership).toEqual(r2.ownership)
    expect(r1.garrisons).toEqual(r2.garrisons)
  })
})
