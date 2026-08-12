import { describe, expect, it } from "vitest"
import { RISK_MAP } from "../map.js"
import { resolveCombat } from "../combat.js"
import { createSeason } from "../setup.js"
import type { Faction, GameState, Order, TerritoryId } from "../types.js"

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

const dial = (attackDepartureCost: number) => ({ attackDepartureCost })
const noLocks = new Set<TerritoryId>()

describe("the departure-cost dial", () => {
  it("charges the fee inside the cap — garrison 3, cost 1 (the review's worked case)", () => {
    // alaska 3 (cap 2). X→Y 1 consumes 1+1=2 and fits; X→Z 1 would total 4 > 2
    // and rejects. The survivor departs 1+1: alaska ends at 1 — the floor
    // survives the dial by construction, and never goes negative.
    const s = board((s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 3
    })
    const r = resolveCombat(
      s,
      [
        order({
          factionId: "f1",
          attacks: [
            { from: "alaska", to: "alberta", count: 1 },
            { from: "alaska", to: "northwest_territory", count: 1 },
          ],
        }),
      ],
      noLocks,
      dial(1),
    )
    expect(r.garrisons["alaska"]).toBe(1)
    expect(
      r.events.filter((e) => e.t === "rejected" && e.field === "attacks"),
    ).toHaveLength(1)
    const attack = r.events.find((e) => e.t === "attack")!
    expect(attack).toMatchObject({ from: "alaska", to: "alberta", committed: 1, fee: 1 })
  })

  it("duplicate lines merge before the fee — one fee, same as the merged form", () => {
    // Two X→Y 1 lines and one X→Y 2 line must cost identically: merged first,
    // charged once. Garrison 4 (cap 3): merged 2 + fee 1 = 3, fits exactly.
    const run = (attacks: { from: string; to: string; count: number }[]) => {
      const s = board((s) => {
        s.ownership["alaska"] = "f1"
        s.garrisons["alaska"] = 4
        s.garrisons["alberta"] = 1
      })
      return resolveCombat(s, [order({ factionId: "f1", attacks })], noLocks, dial(1))
    }
    const split = run([
      { from: "alaska", to: "alberta", count: 1 },
      { from: "alaska", to: "alberta", count: 1 },
    ])
    const merged = run([{ from: "alaska", to: "alberta", count: 2 }])
    expect(split.garrisons).toEqual(merged.garrisons)
    expect(split.ownership).toEqual(merged.ownership)
  })

  it("rejects an over-cap merged movement WHOLE, replacing per-line acceptance", () => {
    // The pinned core behavior change (dial 0): garrison 8, cap 7, two X→Y 5
    // lines merge to 10 > 7 — rejected whole. Under the old per-line greedy
    // check the first line attacked with 5.
    const s = board((s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 8
      s.garrisons["alberta"] = 1
    })
    const r = resolveCombat(
      s,
      [
        order({
          factionId: "f1",
          attacks: [
            { from: "alaska", to: "alberta", count: 5 },
            { from: "alaska", to: "alberta", count: 5 },
          ],
        }),
      ],
      noLocks,
      dial(0),
    )
    expect(r.events.filter((e) => e.t === "attack")).toHaveLength(0)
    expect(r.garrisons["alaska"]).toBe(8)
    expect(r.events).toContainEqual({
      t: "rejected",
      faction: "f1",
      field: "attacks",
      reason: "exceeds garrison cap at alaska",
      ref: "attack:alaska|alberta",
    })
  })

  it("a voided attack consumes no cap and no fee, freeing room for a valid one", () => {
    // The Auditor's round-2 case: cost 1, one attack at a locked target and
    // one valid. The voided attack logs a `protected` rejection and consumes
    // nothing; the valid one (2 + fee 1 = 3 ≤ cap 3) departs and captures.
    // Were the voided attack still charged (1 + 1 = 2), the valid one would
    // need 5 of a 3-cap and be wrongly rejected.
    const s = board((s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 4
      s.garrisons["alberta"] = 1
      s.garrisons["northwest_territory"] = 1
    })
    const r = resolveCombat(
      s,
      [
        order({
          factionId: "f1",
          attacks: [
            { from: "alaska", to: "alberta", count: 1 },
            { from: "alaska", to: "northwest_territory", count: 2 },
          ],
        }),
      ],
      new Set<TerritoryId>(["alberta"]),
      dial(1),
    )
    expect(r.events).toContainEqual({
      t: "rejected",
      faction: "f1",
      field: "attacks",
      reason: "protected",
      ref: "attack:alaska|alberta",
    })
    expect(r.events.filter((e) => e.t === "attack")).toHaveLength(1)
    expect(r.ownership["northwest_territory"]).toBe("f1")
    expect(r.garrisons["alaska"]).toBe(1) // 4 − (2 committed + 1 fee)
  })

  it("an annihilated movement still logs its attack event with its fee", () => {
    // Mutual equal-size attacks on a dial day: both die in the field battle,
    // both events survive with the fee — or the accounting equality breaks on
    // every mutual attack under Attrition.
    const s = board((s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 6
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 6
    })
    const r = resolveCombat(
      s,
      [
        order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 4 }] }),
        order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 4 }] }),
      ],
      noLocks,
      dial(1),
    )
    const attacks = r.events.filter((e) => e.t === "attack")
    expect(attacks).toHaveLength(2)
    for (const a of attacks) {
      expect(a).toMatchObject({ committed: 4, survivors: 0, lost: 0, fee: 1 })
    }
    const fb = r.events.find((e) => e.t === "fieldBattle")!
    expect(fb).toMatchObject({ aLost: 4, bLost: 4 })
    // committed + fee departed each side: 6 - 4 - 1 = 1
    expect(r.garrisons["alaska"]).toBe(1)
    expect(r.garrisons["alberta"]).toBe(1)
  })

  it("defenderLost logs once per contested territory and sums exactly", () => {
    // Two factions capture alberta (defense 5) from different origins. The
    // territory's defender losses appear on exactly one attack event — the
    // lexicographically-first surviving origin — and sum to the defense.
    const s = board((s) => {
      s.ownership["alaska"] = "f1"
      s.garrisons["alaska"] = 9
      s.ownership["northwest_territory"] = "f2"
      s.garrisons["northwest_territory"] = 9
      s.ownership["alberta"] = "f3"
      s.garrisons["alberta"] = 5
    })
    const r = resolveCombat(
      s,
      [
        order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 3 }] }),
        order({ factionId: "f2", attacks: [{ from: "northwest_territory", to: "alberta", count: 4 }] }),
      ],
      noLocks,
      dial(0),
    )
    const attacks = r.events
      .filter((e): e is Extract<typeof e, { t: "attack" }> => e.t === "attack")
      .filter((e) => e.to === "alberta")
    expect(attacks.reduce((sum, a) => sum + a.defenderLost, 0)).toBe(5)
    expect(attacks.filter((a) => a.defenderLost > 0)).toHaveLength(1)
    expect(attacks.find((a) => a.defenderLost > 0)!.from).toBe("alaska")
    // Per-faction target-combat casualties sum across legs: 2 + 3 = defense.
    expect(attacks.reduce((sum, a) => sum + a.lost, 0)).toBe(5)
  })
})
