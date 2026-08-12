import { describe, expect, it } from "vitest"
import { RISK_MAP, createSeason } from "../index.js"
import { conscriptionRule } from "./conscription.js"
import { touchGrassRule } from "./touch-grass.js"
import { tributeRule } from "./tribute.js"
import { underdogRule } from "./underdog.js"
import type { DailyContext, GameState, TickEvent } from "../types.js"

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

const ids = RISK_MAP.territories.map((t) => t.id)
const dealt = (): GameState =>
  createSeason(
    "s",
    ["f1", "f2", "f3"].map((id) => ({ id, playerName: id, color: "#000" })),
    ids,
    RISK_MAP,
  )

/** Ownership assigned by hand, so territory counts are exact. */
function owned(counts: Record<string, number>, log: TickEvent[] = []): GameState {
  const s = dealt()
  const ownership: Record<string, string> = {}
  let i = 0
  for (const [faction, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++) ownership[ids[i++]!] = faction
  }
  // Everything left over goes to a non-player owner so the counts stay exact.
  for (; i < ids.length; i++) ownership[ids[i]!] = "neutral"
  return { ...s, ownership, log }
}

const paid = (cs: { faction: string; amount: number }[]) =>
  Object.fromEntries(cs.map((c) => [c.faction, c.amount]))

describe("underdog — Participation Trophy", () => {
  it("pays only the smallest surviving faction", () => {
    const s = owned({ f1: 1, f2: 5, f3: 9 })
    expect(paid(underdogRule.grant!(s, ctx()))).toEqual({ f1: 3 })
  })

  it("pays EVERY faction tied at the minimum", () => {
    // An arbitrary tiebreak would pay troops for sorting lower.
    const s = owned({ f1: 2, f2: 2, f3: 9 })
    expect(paid(underdogRule.grant!(s, ctx()))).toEqual({ f1: 3, f2: 3 })
  })

  it("skips eliminated factions rather than treating 0 as the minimum", () => {
    const s = owned({ f1: 0, f2: 3, f3: 9 })
    expect(paid(underdogRule.grant!(s, ctx()))).toEqual({ f2: 3 })
  })

  it("logs a grant event naming its source", () => {
    const s = owned({ f1: 1, f2: 5, f3: 9 })
    expect(underdogRule.grant!(s, ctx())[0]!.event).toEqual({
      t: "grant",
      source: "underdog",
      faction: "f1",
      amount: 3,
    })
  })
})

describe("eat-the-rich — Eat the Rich", () => {
  it("pays everyone except the leader", () => {
    const s = owned({ f1: 1, f2: 5, f3: 9 })
    expect(paid(tributeRule.grant!(s, ctx()))).toEqual({ f1: 2, f2: 2 })
  })

  it("excludes ALL tied leaders", () => {
    const s = owned({ f1: 1, f2: 9, f3: 9 })
    expect(paid(tributeRule.grant!(s, ctx()))).toEqual({ f1: 2 })
  })

  it("pays nobody when every survivor is tied — there is no leader to tax", () => {
    const s = owned({ f1: 4, f2: 4, f3: 4 })
    expect(tributeRule.grant!(s, ctx())).toEqual([])
  })
})

describe("touch-grass — Touch Grass", () => {
  const attack = (attacker: string): TickEvent => ({
    t: "attack",
    from: ids[0]!,
    to: ids[1]!,
    attacker,
    committed: 1,
    survivors: 1,
    captured: true,
    lost: 0,
    defenderLost: 0,
  })

  it("pays only the factions that did not attack yesterday", () => {
    const s = owned({ f1: 3, f2: 3, f3: 3 }, [attack("f1")])
    expect(paid(touchGrassRule.grant!(s, ctx()))).toEqual({ f2: 3, f3: 3 })
  })

  it("pays everyone on day 1, when yesterday's log is empty", () => {
    const s = owned({ f1: 3, f2: 3, f3: 3 }, [])
    expect(paid(touchGrassRule.grant!(s, ctx()))).toEqual({ f1: 3, f2: 3, f3: 3 })
  })

  it("still skips eliminated factions", () => {
    const s = owned({ f1: 0, f2: 3, f3: 3 }, [attack("f3")])
    expect(paid(touchGrassRule.grant!(s, ctx()))).toEqual({ f2: 3 })
  })
})

describe("bring-a-friend — Bring a Friend", () => {
  it("pays every surviving faction the same flat amount", () => {
    const s = owned({ f1: 1, f2: 5, f3: 9 })
    expect(paid(conscriptionRule.grant!(s, ctx()))).toEqual({ f1: 3, f2: 3, f3: 3 })
  })

  it("skips a faction with no territories", () => {
    const s = owned({ f1: 0, f2: 5, f3: 9 })
    expect(paid(conscriptionRule.grant!(s, ctx()))).toEqual({ f2: 3, f3: 3 })
  })
})

describe("every grant rule", () => {
  const rules = [underdogRule, tributeRule, touchGrassRule, conscriptionRule]

  it("never pays a faction holding no territories", () => {
    const s = owned({ f1: 0, f2: 4, f3: 6 })
    for (const r of rules) {
      expect(r.grant!(s, ctx()).some((c) => c.faction === "f1")).toBe(false)
    }
  })

  it("returns non-negative integer amounts, id-sorted, and mutates nothing", () => {
    const s = owned({ f1: 1, f2: 4, f3: 6 })
    const before = JSON.stringify(s)
    for (const r of rules) {
      const out = r.grant!(s, ctx())
      expect(out.map((c) => c.faction)).toEqual([...out.map((c) => c.faction)].sort())
      for (const c of out) expect(Number.isSafeInteger(c.amount) && c.amount >= 0).toBe(true)
    }
    expect(JSON.stringify(s)).toBe(before)
  })
})
