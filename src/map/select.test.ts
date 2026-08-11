import { describe, expect, it } from "vitest"
import { MIN_REGIONS } from "../config.js"
import { makeRng } from "../rng.js"
import { COORDS } from "./coords.js"
import { checkDeal } from "../season.js"
import { bonusFor, selectSubMap } from "./select.js"
import { validateMap } from "./validate.js"
import { WORLD } from "./world.js"

/** Greatest great-circle distance between any two territories on a board. */
function widestSpanKm(map: { territories: { id: string }[] }): number {
  const R = 6371
  const rad = Math.PI / 180
  const pts = map.territories.map((t) => COORDS[t.id]!)
  let max = 0
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i]!
      const b = pts[j]!
      const h =
        Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
        Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2
      const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
      if (d > max) max = d
    }
  }
  return max
}

describe("bonusFor", () => {
  it("reproduces classic Risk on four of its six continents", () => {
    expect(bonusFor(4, 1)).toBe(2) // Australia
    expect(bonusFor(4, 2)).toBe(2) // South America
    expect(bonusFor(9, 3)).toBe(5) // North America
    expect(bonusFor(12, 5)).toBe(7) // Asia
  })

  it("misses Africa and Europe by one, in opposite directions", () => {
    // Pinned so a future tweak has to acknowledge the trade rather than
    // discover it. Opposite directions means the formula is not systematically
    // generous or stingy.
    expect(bonusFor(6, 3)).toBe(4) // Risk: 3
    expect(bonusFor(7, 4)).toBe(4) // Risk: 5
  })

  it("never returns zero", () => {
    // A region worth nothing is a region nobody contests, which removes the
    // race rather than pricing it.
    expect(bonusFor(4, 0)).toBeGreaterThanOrEqual(1)
    expect(bonusFor(1, 0)).toBeGreaterThanOrEqual(1)
  })
})

describe("selectSubMap", () => {
  it("produces a legal, valid board for every roster size and many seeds", () => {
    // The property that matters. checkDeal is what refuses a board at
    // season-init, so a selector that can produce one it rejects is broken.
    for (let factions = 4; factions <= 15; factions++) {
      for (let seed = 1; seed <= 25; seed++) {
        const map = selectSubMap(WORLD, factions, makeRng(seed))
        const label = `${factions} factions, seed ${seed}`
        expect(validateMap(map), label).toEqual([])
        expect(checkDeal(factions, map.territories.length), label).toBeNull()
        expect(map.regions.length, label).toBeGreaterThanOrEqual(MIN_REGIONS)
      }
    }
  })

  it("aims for 7 territories per faction, not the floor of 5", () => {
    // The bug this pins: stopping the moment `size >= lo` parked every board at
    // the FLOOR of the legal window -- a 15-faction season came out at 79
    // territories, 5.3 each. Legal, but the lower bound exists because a thin
    // holding dies to one focused attack, so sitting on it by construction is
    // the wrong default.
    for (const factions of [4, 8, 11, 15]) {
      for (let seed = 1; seed <= 20; seed++) {
        const per = selectSubMap(WORLD, factions, makeRng(seed)).territories.length / factions
        expect(per, `${factions} factions, seed ${seed}`).toBeGreaterThanOrEqual(6.5)
        expect(per, `${factions} factions, seed ${seed}`).toBeLessThanOrEqual(9)
      }
    }
  })

  it("recovers by restarting when a walk strands itself", () => {
    // The restart path, driven rather than hoped for. Four factions cap the
    // board at 44 territories, so a walk into a dense part of the world can
    // reach a size where no adjacent region fits under the ceiling. Without the
    // restart this throws; with it, every seed finds a board.
    for (let seed = 1; seed <= 60; seed++) {
      const map = selectSubMap(WORLD, 4, makeRng(seed))
      expect(checkDeal(4, map.territories.length), `seed ${seed}`).toBeNull()
    }
  })

  it("is deterministic for a seed, and varies across seeds", () => {
    const ids = (seed: number) =>
      selectSubMap(WORLD, 11, makeRng(seed)).territories.map((t) => t.id)
    expect(ids(4711)).toEqual(ids(4711))
    expect(ids(4711)).not.toEqual(ids(4712))
  })

  it("selects whole regions, never part of one", () => {
    // A half-region makes its bonus meaningless -- an objective you complete by
    // holding three of six real territories is not the mechanic.
    for (const seed of [3, 31, 313]) {
      const map = selectSubMap(WORLD, 9, makeRng(seed))
      for (const r of map.regions) {
        const inWorld = WORLD.territories.filter((t) => t.region === r.id).length
        const inMap = map.territories.filter((t) => t.region === r.id).length
        expect(inMap, `${r.id} seed ${seed}`).toBe(inWorld)
      }
    }
  })

  it("drops neighbours that were not selected", () => {
    // Otherwise the induced map fails its own symmetry invariant.
    const map = selectSubMap(WORLD, 6, makeRng(77))
    const ids = new Set(map.territories.map((t) => t.id))
    for (const t of map.territories) {
      for (const n of t.neighbors) expect(ids.has(n), `${t.id} -> ${n}`).toBe(true)
    }
  })

  it("does not mutate the world", () => {
    // The induced map must copy its territory records. Filtering neighbours in
    // place would corrupt WORLD for every later season in the same process --
    // which is exactly what the simulator does, 2000 times.
    const before = JSON.stringify(WORLD)
    for (let seed = 1; seed <= 10; seed++) selectSubMap(WORLD, 12, makeRng(seed))
    expect(JSON.stringify(WORLD)).toBe(before)
  })

  it("computes a bonus for every region, and none is zero", () => {
    const map = selectSubMap(WORLD, 10, makeRng(9))
    for (const r of map.regions) expect(r.bonus, r.id).toBeGreaterThanOrEqual(1)
  })

  it("prices a region by the board it is on, not by the world", () => {
    // The reason bonuses cannot live in world.ts: a region cut off from most of
    // its neighbours is more defensible, so it must be worth less. Across many
    // boards the same region should not always carry the same bonus.
    const seen = new Set<number>()
    for (let seed = 1; seed <= 60; seed++) {
      const map = selectSubMap(WORLD, 8, makeRng(seed))
      const r = map.regions.find((x) => x.id === "balkans")
      if (r !== undefined) seen.add(r.bonus)
    }
    expect(seen.size, "balkans always priced the same").toBeGreaterThan(1)
  })

  it("keeps boards geographically tight", () => {
    // Without the distance term, a 15-faction board averaged a 15,400 km widest
    // span -- Canada to Kamchatka to the Congo. Contiguous through Greenland
    // and the Bering Strait, but not anywhere you could name.
    const spans: number[] = []
    for (let seed = 1; seed <= 40; seed++) {
      spans.push(widestSpanKm(selectSubMap(WORLD, 15, makeRng(seed))))
    }
    const mean = spans.reduce((a, b) => a + b, 0) / spans.length
    expect(mean, "mean widest span").toBeLessThan(13_000)
  })

  it("keeps boards varied", () => {
    // The other half, and the reason the obvious softening was rejected:
    // breaking size-fit ties by distance tightened the board barely at all and
    // cut distinct boards from 59 to 13, because a deterministic tiebreak
    // removes the rng from most choices. Tightness alone is not the goal.
    const keys = new Set<string>()
    for (let seed = 1; seed <= 40; seed++) {
      const map = selectSubMap(WORLD, 15, makeRng(seed))
      keys.add(
        map.regions
          .map((r) => r.id)
          .sort()
          .join("|"),
      )
    }
    expect(keys.size, "distinct boards out of 40").toBeGreaterThan(30)
  })

  it("throws rather than returning an illegal board when it cannot succeed", () => {
    // A world of one region can never satisfy MIN_REGIONS.
    const oneRegion = WORLD.regions[0]!.id
    const tiny = {
      regions: WORLD.regions.filter((r) => r.id === oneRegion),
      territories: WORLD.territories.filter((t) => t.region === oneRegion),
    }
    expect(() => selectSubMap(tiny, 4, makeRng(1))).toThrow(/selectSubMap/)
  })
})
