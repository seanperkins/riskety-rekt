import { describe, expect, it } from "vitest"
import { validateModules } from "./registry.js"
import type { Mechanic } from "./mechanics.js"

const m = (id: string, extra: Partial<Mechanic> = {}): Mechanic => ({ id, ...extra })
const reg = (...ms: Mechanic[]) => new Map(ms.map((x) => [x.id, x]))
const base = () =>
  reg(m("markets", { advance: () => ({}), escrowed: () => 0 }), m("irl"), m("veto"))

describe("validateModules", () => {
  it("returns enabled mechanics sorted by id", () => {
    expect(validateModules(["veto", "irl", "markets"], base()).map((x) => x.id)).toEqual([
      "irl",
      "markets",
      "veto",
    ])
  })

  it("an empty enabled list is a valid plain-Risk season", () => {
    expect(validateModules([], base())).toEqual([])
  })

  it("refuses an unknown id and a duplicate id", () => {
    expect(() => validateModules(["ghost"], base())).toThrow(/unknown/)
    expect(() => validateModules(["irl", "irl"], base())).toThrow(/duplicate/)
  })

  it("refuses veto without irl — the hardcoded dependency", () => {
    expect(() => validateModules(["markets", "veto"], base())).toThrow(/veto.*irl/)
  })

  it("refuses advance without escrowed", () => {
    const bad = reg(m("stateful", { advance: () => ({}) }))
    expect(() => validateModules(["stateful"], bad)).toThrow(/escrowed/)
  })
})
