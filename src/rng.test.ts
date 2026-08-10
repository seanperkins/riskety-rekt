import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./engine/index.js"
import { makeRng, shuffle } from "./rng.js"

describe("makeRng", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const a = makeRng(7)
    const b = makeRng(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
    expect(makeRng(7)()).not.toEqual(makeRng(8)())
  })

  it("spreads the FIRST draw across the range for sequential seeds", () => {
    // The defect this guards: before the warm-up, xorshift32's first output was
    // nearly linear in a small seed and 2000 of 2000 sequential seeds landed in
    // the bottom quarter. The simulator seeds seasons sequentially, so every
    // season's first decision came from the same sliver, and a seeded
    // Fisher-Yates picked j = 0 for its first swap regardless of seed.
    const buckets = [0, 0, 0, 0]
    for (let seed = 1; seed <= 2000; seed++) buckets[Math.floor(makeRng(seed)() * 4)]!++
    for (const n of buckets) expect(n).toBeGreaterThan(400)
  })

  it("stays in [0, 1)", () => {
    const rng = makeRng(4711)
    for (let i = 0; i < 10_000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe("shuffle", () => {
  it("is a permutation, and the same seed gives the same one", () => {
    const items = RISK_MAP.territories.map((t) => t.id)
    const a = shuffle(items, makeRng(99))
    const b = shuffle(items, makeRng(99))
    expect(a).toEqual(b)
    expect([...a].sort()).toEqual([...items].sort())
    expect(a).not.toEqual(items) // 42! makes an identity shuffle vanishingly unlikely
  })

  it("does not mutate its input", () => {
    const items = ["a", "b", "c", "d"]
    shuffle(items, makeRng(1))
    expect(items).toEqual(["a", "b", "c", "d"])
  })

  it("reaches the last element", () => {
    // The classic off-by-one: `for (i = n - 1; i > 0; i--)` with `j` drawn from
    // [0, i] is correct, but drawing from [0, n) or stopping at i >= 0 is not.
    // Over many seeds every position must see more than one value.
    const seen = new Map<number, Set<string>>()
    for (let seed = 1; seed <= 200; seed++) {
      shuffle(["a", "b", "c", "d"], makeRng(seed)).forEach((v, i) => {
        const set = seen.get(i) ?? new Set()
        set.add(v)
        seen.set(i, set)
      })
    }
    for (const [, values] of seen) expect(values.size).toBe(4)
  })
})
