import { describe, expect, it } from "vitest"
import { selectSubMap } from "./select.js"
import { clusteredOrder } from "./deal.js"
import { WORLD } from "./world.js"
import { makeRng } from "../rng.js"
import type { GameMap, TerritoryId } from "../engine/index.js"

/** Ownership exactly as createSeason derives it: ids[i] -> faction i % n. */
function ownershipOf(order: TerritoryId[], factions: number): Map<TerritoryId, number> {
  const out = new Map<TerritoryId, number>()
  order.forEach((id, i) => out.set(id, i % factions))
  return out
}

/** Connected holdings for one faction, largest first. */
function clumps(map: GameMap, owner: Map<TerritoryId, number>, faction: number): number[] {
  const mine = new Set([...owner].filter(([, f]) => f === faction).map(([id]) => id))
  const neighbors = new Map(map.territories.map((t) => [t.id, t.neighbors]))
  const seen = new Set<TerritoryId>()
  const sizes: number[] = []
  for (const start of mine) {
    if (seen.has(start)) continue
    let size = 0
    const stack = [start]
    seen.add(start)
    while (stack.length > 0) {
      const cur = stack.pop()!
      size++
      for (const n of neighbors.get(cur) ?? []) {
        if (mine.has(n) && !seen.has(n)) {
          seen.add(n)
          stack.push(n)
        }
      }
    }
    sizes.push(size)
  }
  return sizes.sort((a, b) => b - a)
}

describe("clusteredOrder", () => {
  it("deals exactly the map's territories, once each", () => {
    // createSeason THROWS on any mismatch, and a territory left out of the deal
    // would be an unowned free capture rather than a crash.
    for (const seed of [1, 4711, 99]) {
      const map = selectSubMap(WORLD, 10, makeRng(seed))
      const order = clusteredOrder(map, 10, makeRng(seed))
      expect(new Set(order).size, `seed ${seed}`).toBe(map.territories.length)
      expect([...order].sort()).toEqual(map.territories.map((t) => t.id).sort())
    }
  })

  it("gives every faction the same count round-robin would", () => {
    // The order is interleaved so `i % n` reproduces the intended assignment.
    // If the interleave slips, factions silently swap territories.
    for (const factions of [4, 7, 10, 13]) {
      const map = selectSubMap(WORLD, factions, makeRng(5))
      const owner = ownershipOf(clusteredOrder(map, factions, makeRng(5)), factions)
      const counts = Array.from({ length: factions }, (_, f) =>
        [...owner].filter(([, o]) => o === f).length,
      )
      expect(Math.max(...counts) - Math.min(...counts), `${factions} factions`).toBeLessThanOrEqual(1)
      expect(counts.reduce((a, b) => a + b, 0)).toBe(map.territories.length)
    }
  })

  it("gives each faction a holding it can actually defend", () => {
    // The point of the whole module. A plain shuffle averaged 1.9 territories
    // in the largest connected holding out of seven -- almost every territory
    // an island, with no line to hold and no region ever assembled.
    let largest = 0
    let seasons = 0
    for (const seed of [1, 2, 3, 4711, 42]) {
      const map = selectSubMap(WORLD, 10, makeRng(seed))
      const owner = ownershipOf(clusteredOrder(map, 10, makeRng(seed)), 10)
      for (let f = 0; f < 10; f++) {
        largest += clumps(map, owner, f)[0] ?? 0
        seasons++
      }
    }
    expect(largest / seasons).toBeGreaterThan(4)
  })

  it("is deterministic for a seed", () => {
    const map = selectSubMap(WORLD, 8, makeRng(3))
    expect(clusteredOrder(map, 8, makeRng(3))).toEqual(clusteredOrder(map, 8, makeRng(3)))
  })

  it("still varies the deal between seeds", () => {
    // Compact but not fixed: the same board dealt twice should not be the same
    // game, or the seed only chooses the map.
    const map = selectSubMap(WORLD, 10, makeRng(11))
    const deals = new Set<string>()
    for (let seed = 1; seed <= 10; seed++) deals.add(clusteredOrder(map, 10, makeRng(seed)).join(","))
    expect(deals.size).toBeGreaterThan(1)
  })

  /** Regions held whole by one faction, the way regionBonusesFor counts them. */
  function wholeRegions(map: GameMap, owner: Map<TerritoryId, number>): string[] {
    return map.regions
      .filter((r) => {
        const members = map.territories.filter((t) => t.region === r.id)
        const first = owner.get(members[0]!.id)
        return first !== undefined && members.every((t) => owner.get(t.id) === first)
      })
      .map((r) => r.id)
  }

  /**
   * Nobody opens a season already collecting a region bonus.
   *
   * The shipped deal handed one out on 80-90% of boards, usually to two
   * factions at once. On the live season-1 board that was guinea_coast (+4) to
   * one player and horn and iberia (+2) to two others -- against a base income
   * of 5 for all seven, an 80% lead on day 1 that nobody played for.
   *
   * A sampled bound rather than a per-seed assertion, because the residual is
   * structural: some selected boards contain a region small and cornered enough
   * that whichever faction seeds beside it swallows it, and no number of
   * redeals finds a way out. The bound is what stops a regression from quietly
   * restoring the old 80-90%.
   */
  it("almost never opens a season with a region already held whole", () => {
    let dealt = 0
    let withRegion = 0
    for (const factions of [4, 6, 8, 10]) {
      for (let seed = 1; seed <= 25; seed++) {
        const map = selectSubMap(WORLD, factions, makeRng(seed))
        const owner = ownershipOf(clusteredOrder(map, factions, makeRng(seed)), factions)
        dealt++
        if (wholeRegions(map, owner).length > 0) withRegion++
      }
    }
    // Measured at ~9% over 400 sub-maps per roster size; 25% is the regression
    // bound, far below the 80-90% the unconstrained deal produced.
    expect(withRegion / dealt).toBeLessThan(0.25)
  })

  it("leaves nobody with an empty holding", () => {
    for (const factions of [4, 10, 15]) {
      const map = selectSubMap(WORLD, factions, makeRng(8))
      const owner = ownershipOf(clusteredOrder(map, factions, makeRng(8)), factions)
      for (let f = 0; f < factions; f++) {
        expect([...owner].filter(([, o]) => o === f).length, `faction ${f}`).toBeGreaterThan(0)
      }
    }
  })
})
