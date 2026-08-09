import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { allocateCasualties } from "./casualties.js"

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

describe("allocateCasualties", () => {
  it("matches the spec's worked example (a1=3, a2=4, D=5)", () => {
    const c = allocateCasualties([
      { factionId: "f1", size: 3 },
      { factionId: "f2", size: 4 },
    ], 5)
    expect(c.get("f1")).toBe(2)
    expect(c.get("f2")).toBe(3)
  })

  it("destroys everyone when the attack does not exceed defense", () => {
    const c = allocateCasualties([
      { factionId: "f1", size: 3 },
      { factionId: "f2", size: 2 },
    ], 5)
    expect(c.get("f1")).toBe(3)
    expect(c.get("f2")).toBe(2)
  })

  it("allocates exactly D on a successful attack (regression: per-attacker D)", () => {
    // Applying D in full against each attacker would destroy 8 troops with a
    // 4-troop garrison and silently break troop conservation.
    const c = allocateCasualties([
      { factionId: "f1", size: 5 },
      { factionId: "f2", size: 5 },
    ], 4)
    expect(sum(c)).toBe(4)
  })

  it("handles a single attacker", () => {
    const c = allocateCasualties([{ factionId: "f1", size: 10 }], 4)
    expect(c.get("f1")).toBe(4)
  })

  it("handles zero defense", () => {
    const c = allocateCasualties([{ factionId: "f1", size: 3 }], 0)
    expect(c.get("f1")).toBe(0)
  })

  it("is order-independent", () => {
    const a = allocateCasualties([
      { factionId: "f1", size: 3 },
      { factionId: "f2", size: 4 },
    ], 5)
    const b = allocateCasualties([
      { factionId: "f2", size: 4 },
      { factionId: "f1", size: 3 },
    ], 5)
    expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b))
  })

  it("never allocates more casualties than a force has, and always totals correctly", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 200 }),
        (sizes, defense) => {
          const forces = sizes.map((size, i) => ({ factionId: `f${i}`, size }))
          const c = allocateCasualties(forces, defense)
          const total = sizes.reduce((a, b) => a + b, 0)
          for (const f of forces) {
            expect(c.get(f.factionId)!).toBeLessThanOrEqual(f.size)
            expect(c.get(f.factionId)!).toBeGreaterThanOrEqual(0)
          }
          expect(sum(c)).toBe(total <= defense ? total : defense)
        },
      ),
      { numRuns: 500 },
    )
  })
})
