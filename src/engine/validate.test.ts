import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { resolveCombat } from "./combat.js"
import { vetoModule } from "./modules/veto.js"
import { createSeason } from "./setup.js"
import { validateOrder } from "./validate.js"
import type { DailyContext, Faction, Order } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
]
const ids = RISK_MAP.territories.map((t) => t.id)

function fixture() {
  const s = createSeason("s1", factions, ids)
  for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
  s.ownership["alaska"] = "f1"
  s.ownership["alberta"] = "f1"
  s.garrisons["alaska"] = 10
  s.garrisons["alberta"] = 3
  s.reserves["f1"] = 10
  const ctx: DailyContext = {
    slate: [{ id: "m1", question: "q", priceYes: 0.5, priceNo: 0.5, closeTime: "2026-08-09T18:00:00Z" }],
    approvals: [],
    postedToday: [],
    settlements: {},
    tickInstant: "2026-08-09T21:00:00.000Z",
    modules: ["markets", "irl", "veto"],
    rules: [],
  }
  return { s, ctx }
}

const base: Order = { factionId: "f1", deploys: [], attacks: [], wagers: [], protect: null }

describe("validateOrder — aggregates", () => {
  it("caps total attacks from one origin at garrison - 1 (via combat)", () => {
    // The cap moved to combat's movement validation, against post-allocation
    // garrisons. validateOrder shape-passes both lines; combat rejects the
    // second merged movement.
    const { s } = fixture()
    const o: Order = {
      ...base,
      attacks: [
        { from: "alaska", to: "northwest_territory", count: 9 },
        { from: "alaska", to: "kamchatka", count: 9 },
      ],
    }
    const r = resolveCombat(s, [o], new Set(), { attackDepartureCost: 0 })
    const departed = r.events
      .filter((e) => e.t === "attack")
      .reduce((sum, e) => sum + e.committed, 0)
    expect(departed).toBeLessThanOrEqual(9)
    expect(r.events.some((e) => e.t === "rejected" && e.field === "attacks")).toBe(true)
  })

  it("counts the post-deploy garrison toward the attack cap", () => {
    const { s, ctx } = fixture()
    const o: Order = {
      ...base,
      deploys: [{ territory: "alberta", count: 5 }],
      attacks: [{ from: "alberta", to: "ontario", count: 7 }],
    }
    // alberta 3 + 5 deployed = 8, cap 7 -> the attack fits
    expect(validateOrder(s, o, ctx).clean.attacks).toHaveLength(1)
  })

  it("reserve budgeting lives in the allocation, not here — deploys pass shape", () => {
    // The old sequential cap ("deploys first, wagers get the remainder") was
    // the deploy-inflation exploit's home. validateOrder now shape-passes
    // both over-reserve deploys; the allocation drops the junior one with a
    // rejected event — pinned end-to-end in resolve.test.ts ("seniority").
    const { s, ctx } = fixture()
    const o: Order = {
      ...base,
      deploys: [
        { territory: "alaska", count: 7 },
        { territory: "alberta", count: 7 },
      ],
    }
    const { clean, rejections } = validateOrder(s, o, ctx)
    expect(clean.deploys).toHaveLength(2)
    expect(rejections).toEqual([])
  })

  it("allows at most one wager per market (closes the both-sides hedge)", () => {
    const { s, ctx } = fixture()
    const o: Order = {
      ...base,
      wagers: [
        { marketId: "m1", side: "yes", stake: 2 },
        { marketId: "m1", side: "no", stake: 2 },
      ],
    }
    const { clean, rejections } = validateOrder(s, o, ctx)
    expect(clean.wagers).toHaveLength(1)
    expect(rejections.some((r) => r.t === "rejected" && r.reason.includes("one wager per market"))).toBe(true)
  })
})

describe("validateOrder — field level", () => {
  it("drops only the bad item, keeping the rest", () => {
    const { s, ctx } = fixture()
    const o: Order = {
      ...base,
      attacks: [
        { from: "alaska", to: "northwest_territory", count: 3 },
        { from: "brazil", to: "peru", count: 1 },
      ],
    }
    const { clean } = validateOrder(s, o, ctx)
    expect(clean.attacks).toHaveLength(1)
    expect(clean.attacks[0]!.from).toBe("alaska")
  })

  it("rejects non-adjacent, friendly-target, and unowned-origin attacks", () => {
    const { s, ctx } = fixture()
    const o: Order = {
      ...base,
      attacks: [
        { from: "alaska", to: "brazil", count: 1 },
        { from: "alaska", to: "alberta", count: 1 },
        { from: "peru", to: "brazil", count: 1 },
      ],
    }
    expect(validateOrder(s, o, ctx).clean.attacks).toHaveLength(0)
  })

  it("rejects negative, fractional, NaN and string counts", () => {
    const { s, ctx } = fixture()
    const o: Order = {
      ...base,
      deploys: [
        { territory: "alaska", count: -3 },
        { territory: "alaska", count: 1.5 },
        { territory: "alaska", count: NaN },
        { territory: "alaska", count: "4" as unknown as number },
      ],
    }
    expect(validateOrder(s, o, ctx).clean.deploys).toHaveLength(0)
  })

  it("rejects deploys to territories the faction does not own", () => {
    const { s, ctx } = fixture()
    const o: Order = { ...base, deploys: [{ territory: "brazil", count: 1 }] }
    expect(validateOrder(s, o, ctx).clean.deploys).toHaveLength(0)
  })

  it("rejects wagers on markets not on today's slate", () => {
    const { s, ctx } = fixture()
    const o: Order = { ...base, wagers: [{ marketId: "not_on_slate", side: "yes", stake: 1 }] }
    expect(validateOrder(s, o, ctx).clean.wagers).toHaveLength(0)
  })

  it("ignores protect from a living faction (via the veto module)", () => {
    // Protect legality is the veto module's validate hook now; the pipeline
    // nulls the field when the hook rejects it.
    const { s, ctx } = fixture()
    const o: Order = { ...base, protect: "brazil" }
    const rej = vetoModule.validate!(s, o, ctx)
    expect(rej.some((r) => r.t === "rejected" && r.field === "protect")).toBe(true)
  })

  it("keeps protect from an eliminated faction (via the veto module)", () => {
    const { s, ctx } = fixture()
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    const o: Order = { ...base, protect: "brazil" }
    expect(vetoModule.validate!(s, o, ctx)).toEqual([])
  })

  it("rejects protect on an unknown territory (via the veto module)", () => {
    const { s, ctx } = fixture()
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    const o: Order = { ...base, protect: "atlantis" }
    const rej = vetoModule.validate!(s, o, ctx)
    expect(rej.some((r) => r.t === "rejected" && r.field === "protect")).toBe(true)
  })
})
