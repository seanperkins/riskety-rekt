import { describe, expect, it } from "vitest"
import { validateModules, validateRules } from "./registry.js"
import type { Mechanic, Rule } from "./mechanics.js"

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

const rule = (id: string, extra: Partial<Rule> = {}): Rule => ({
  id,
  name: id,
  description: `the ${id} rule`,
  ...extra,
})
const ruleReg = (...rs: Rule[]) => new Map(rs.map((r) => [r.id, r]))

describe("validateRules", () => {
  it("returns enabled rules sorted by id", () => {
    const registry = ruleReg(rule("truce"), rule("boom"), rule("attrition"))
    expect(validateRules(["truce", "boom"], registry).map((r) => r.id)).toEqual(["boom", "truce"])
  })

  it("an empty rules list is the ordinary no-vote day", () => {
    expect(validateRules([], ruleReg(rule("boom")))).toEqual([])
  })

  it("refuses an unknown id — a module id in ctx.rules is unknown to the rule registry", () => {
    expect(() => validateRules(["markets"], ruleReg(rule("boom")))).toThrow(/unknown rule/)
  })

  it("refuses a duplicate id", () => {
    expect(() => validateRules(["boom", "boom"], ruleReg(rule("boom")))).toThrow(/duplicate/)
  })

  it("refuses advance without escrowed", () => {
    const bad = ruleReg(rule("stateful", { advance: () => ({}) }))
    expect(() => validateRules(["stateful"], bad)).toThrow(/escrowed/)
  })
})
