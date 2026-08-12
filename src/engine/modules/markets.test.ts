import { describe, expect, it } from "vitest"
import { marketIdsOf, marketsModule, marketsStateOf, pendingWagersOf } from "./markets.js"
import { RISK_MAP } from "../map.js"
import { createSeason } from "../setup.js"
import type { DailyContext, Faction, Order, PendingWager } from "../types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
]
const ids = RISK_MAP.territories.map((t) => t.id)

const wager = (o: Partial<PendingWager>): PendingWager => ({
  wagerId: "w1",
  factionId: "f1",
  marketId: "m1",
  side: "yes",
  stake: 5,
  price: 0.5,
  placedOnDay: 1,
  ...o,
})

const ctx = (o: Partial<DailyContext> = {}): DailyContext => ({
  slate: [
    { id: "m1", question: "q", priceYes: 0.5, priceNo: 0.5, closeTime: "2026-01-02T18:00:00.000Z" },
  ],
  approvals: [],
  postedToday: [],
  settlements: {},
  tickInstant: "2026-01-02T21:00:00.000Z",
  modules: ["markets"],
  rules: [],
  ...o,
})

const stateWith = (pending: PendingWager[]) => {
  const s = createSeason("s1", factions, ids)
  return { ...s, day: 1, moduleState: { markets: { pending } } }
}

const order = (o: Partial<Order> & { factionId: string }): Order => ({
  deploys: [],
  attacks: [],
  wagers: [],
  protect: null,
  ...o,
})

describe("markets module", () => {
  it("grant credits a winning settlement and logs the loss at amount 0", () => {
    const s = stateWith([
      wager({ wagerId: "win", factionId: "f1", side: "yes" }),
      wager({ wagerId: "lose", factionId: "f2", side: "no", marketId: "m1" }),
    ])
    const grants = marketsModule.grant!(s, ctx({ settlements: { m1: "yes" } }))
    const win = grants.find((g) => g.event.t === "wagerSettle" && g.event.wagerId === "win")!
    const lose = grants.find((g) => g.event.t === "wagerSettle" && g.event.wagerId === "lose")!
    expect(win.faction).toBe("f1")
    expect(win.amount).toBeGreaterThan(5) // payout(5, 0.5) = round(10 * 1.1) = 11
    expect(lose.faction).toBe("f2")
    expect(lose.amount).toBe(0) // the loss event still logs; nothing is credited
  })

  it("spend produces one claim per wager, locked at the market's slate close", () => {
    const s = stateWith([])
    const claims = marketsModule.spend!(
      s,
      [order({ factionId: "f1", wagers: [{ marketId: "m1", side: "yes", stake: 3 }] })],
      ctx(),
    )
    expect(claims).toEqual([
      {
        faction: "f1",
        amount: 3,
        lockedAt: "2026-01-02T18:00:00.000Z",
        ref: "wager:m1",
      },
    ])
  })

  it("advance escrows ONLY honored claims — a dropped wager never reaches the book", () => {
    // The round-1 blocker: an unhonored claim escrowed anyway would settle
    // later as a payout the reserve never funded.
    const s = stateWith([])
    const orders = [order({ factionId: "f1", wagers: [{ marketId: "m1", side: "yes", stake: 3 }] })]
    const withHonor = marketsModule.advance!(s, orders, ctx(), [
      { faction: "f1", amount: 3, lockedAt: "2026-01-02T18:00:00.000Z", ref: "wager:m1" },
    ]) as { pending: PendingWager[] }
    const withoutHonor = marketsModule.advance!(s, orders, ctx(), []) as {
      pending: PendingWager[]
    }
    expect(withHonor.pending).toHaveLength(1)
    expect(withHonor.pending[0]!.stake).toBe(3)
    expect(withoutHonor.pending).toHaveLength(0)
  })

  it("advance drops settled wagers and keeps unsettled young ones", () => {
    const s = stateWith([
      wager({ wagerId: "settles", marketId: "m1" }),
      wager({ wagerId: "stays", marketId: "m2", placedOnDay: 1 }),
    ])
    const next = marketsModule.advance!(s, [], ctx({ settlements: { m1: "yes" } }), []) as {
      pending: PendingWager[]
    }
    expect(next.pending.map((w) => w.wagerId)).toEqual(["stays"])
  })

  it("escrowed sums stakes; helpers read without interpreting elsewhere", () => {
    const s = stateWith([wager({ stake: 5 }), wager({ wagerId: "w2", marketId: "m2", stake: 7 })])
    expect(marketsModule.escrowed!(s.moduleState["markets"])).toBe(12)
    expect(marketsModule.escrowed!(undefined)).toBe(0)
    expect(marketIdsOf(s)).toEqual(new Set(["m1", "m2"]))
    expect(pendingWagersOf(s)).toHaveLength(2)
    expect(marketsStateOf({ ...s, moduleState: {} }).pending).toEqual([])
    expect(() => marketsStateOf({ ...s, moduleState: { markets: { pending: "junk" } } })).toThrow(
      /corrupt/,
    )
  })
})
