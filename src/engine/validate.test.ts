import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
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
  }
  return { s, ctx }
}

const base: Order = { factionId: "f1", deploys: [], attacks: [], wagers: [], protect: null }

describe("validateOrder — aggregates", () => {
  it("caps total attacks from one origin at garrison - 1", () => {
    const { s, ctx } = fixture()
    const o: Order = {
      ...base,
      attacks: [
        { from: "alaska", to: "northwest_territory", count: 9 },
        { from: "alaska", to: "kamchatka", count: 9 },
      ],
    }
    const { clean, rejections } = validateOrder(s, o, ctx)
    expect(clean.attacks.reduce((sum, a) => sum + a.count, 0)).toBeLessThanOrEqual(9)
    expect(rejections.some((r) => r.t === "rejected" && r.field === "attacks")).toBe(true)
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

  it("caps total deploys at reserve", () => {
    const { s, ctx } = fixture()
    const o: Order = {
      ...base,
      deploys: [
        { territory: "alaska", count: 7 },
        { territory: "alberta", count: 7 },
      ],
    }
    expect(validateOrder(s, o, ctx).clean.deploys.reduce((sum, d) => sum + d.count, 0)).toBeLessThanOrEqual(10)
  })

  it("caps wagers at reserve remaining after deploys", () => {
    const { s, ctx } = fixture()
    const o: Order = {
      ...base,
      deploys: [{ territory: "alaska", count: 8 }],
      wagers: [{ marketId: "m1", side: "yes", stake: 5 }],
    }
    expect(validateOrder(s, o, ctx).clean.wagers.reduce((sum, w) => sum + w.stake, 0)).toBeLessThanOrEqual(2)
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

  it("ignores protect from a living faction", () => {
    const { s, ctx } = fixture()
    const o: Order = { ...base, protect: "brazil" }
    const { clean, rejections } = validateOrder(s, o, ctx)
    expect(clean.protect).toBeNull()
    expect(rejections.some((r) => r.t === "rejected" && r.field === "protect")).toBe(true)
  })

  it("keeps protect from an eliminated faction", () => {
    const { s, ctx } = fixture()
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    const o: Order = { ...base, protect: "brazil" }
    expect(validateOrder(s, o, ctx).clean.protect).toBe("brazil")
  })

  it("rejects protect on an unknown territory", () => {
    const { s, ctx } = fixture()
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    const o: Order = { ...base, protect: "atlantis" }
    expect(validateOrder(s, o, ctx).clean.protect).toBeNull()
  })
})
