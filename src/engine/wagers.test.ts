import { describe, expect, it } from "vitest"
import { escrow, payout, settleAll } from "./wagers.js"
import type { Market, Order, PendingWager } from "./types.js"

const slate: Market[] = [
  { id: "m1", question: "q1", priceYes: 0.5, priceNo: 0.5, closeTime: "T18:00" },
  { id: "m2", question: "q2", priceYes: 0.8, priceNo: 0.2, closeTime: "T18:00" },
]

describe("payout", () => {
  it("pays fair odds plus the 10% house bonus", () => {
    expect(payout(10, 0.5)).toBe(22)
    expect(payout(100, 0.5)).toBe(220)
  })

  it("rounds rather than floors, so small stakes stay positive-EV", () => {
    // Under floor() this returned 1 — a -45% EV bet at p just above 0.55.
    expect(payout(1, 0.56)).toBe(2)
    expect(payout(3, 0.9)).toBe(4)
  })

  it("pays more for an underdog than a favourite", () => {
    expect(payout(10, 0.2)).toBeGreaterThan(payout(10, 0.8))
  })

  it("is monotonic in stake", () => {
    for (let s = 1; s < 50; s++) {
      expect(payout(s + 1, 0.4)).toBeGreaterThanOrEqual(payout(s, 0.4))
    }
  })

  it("clamps price to the slate filter band", () => {
    // A price below the 0.10 filter can only arrive via a bug; the clamp caps
    // the blast radius at 11x rather than an unbounded payout.
    expect(payout(10, 0.001)).toBe(payout(10, 0.1))
  })
})

describe("escrow", () => {
  it("takes price from the slate by side, never from the order", () => {
    const order: Order = {
      factionId: "f1",
      deploys: [],
      attacks: [],
      protect: null,
      wagers: [{ marketId: "m2", side: "no", stake: 10 }],
    }
    expect(escrow(order, slate, 1, 0)[0]!.price).toBe(0.2)
  })

  it("records the stake, side and placement day", () => {
    const order: Order = {
      factionId: "f1",
      deploys: [],
      attacks: [],
      protect: null,
      wagers: [{ marketId: "m1", side: "yes", stake: 50 }],
    }
    const pending = escrow(order, slate, 3, 0)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.price).toBe(0.5)
    expect(pending[0]!.placedOnDay).toBe(3)
    expect(pending[0]!.stake).toBe(50)
  })

  it("mints unique wager ids", () => {
    const order: Order = {
      factionId: "f1",
      deploys: [],
      attacks: [],
      protect: null,
      wagers: [
        { marketId: "m1", side: "yes", stake: 1 },
        { marketId: "m2", side: "no", stake: 1 },
      ],
    }
    const ids = escrow(order, slate, 2, 0).map((p) => p.wagerId)
    expect(new Set(ids).size).toBe(2)
  })
})

const pending = (over: Partial<PendingWager> = {}): PendingWager => ({
  wagerId: "w1",
  factionId: "f1",
  marketId: "m1",
  side: "yes",
  stake: 10,
  price: 0.5,
  placedOnDay: 1,
  ...over,
})

describe("settleAll", () => {
  it("credits a winner and clears the wager", () => {
    const r = settleAll([pending()], { m1: "yes" }, 2)
    expect(r.credits.get("f1")).toBe(22)
    expect(r.keep).toHaveLength(0)
  })

  it("credits nothing on a loss and never debits (regression: double-charge)", () => {
    const r = settleAll([pending()], { m1: "no" }, 2)
    expect(r.credits.get("f1") ?? 0).toBe(0)
    expect(r.keep).toHaveLength(0)
  })

  it("rolls an unsettled wager forward", () => {
    const r = settleAll([pending()], { m1: "unsettled" }, 2)
    expect(r.keep).toHaveLength(1)
    expect(r.credits.size).toBe(0)
  })

  it("refunds the stake once two ticks have passed", () => {
    const r = settleAll([pending({ placedOnDay: 1 })], { m1: "unsettled" }, 3)
    expect(r.credits.get("f1")).toBe(10)
    expect(r.keep).toHaveLength(0)
  })

  it("treats a missing settlement as unsettled, not a loss", () => {
    const r = settleAll([pending()], {}, 2)
    expect(r.keep).toHaveLength(1)
    expect(r.credits.size).toBe(0)
  })

  it("settles wagers older than yesterday, not just yesterday's", () => {
    const r = settleAll(
      [pending({ placedOnDay: 1 }), pending({ wagerId: "w2", placedOnDay: 2 })],
      { m1: "yes" },
      3,
    )
    expect(r.credits.get("f1")).toBe(44)
  })

  it("emits one settle event per resolved wager", () => {
    const r = settleAll([pending()], { m1: "yes" }, 2)
    expect(r.events.filter((e) => e.t === "wagerSettle")).toHaveLength(1)
  })

  it("is order-independent across the pending list", () => {
    const a = pending({ wagerId: "wa", factionId: "f1" })
    const b = pending({ wagerId: "wb", factionId: "f2" })
    const r1 = settleAll([a, b], { m1: "yes" }, 2)
    const r2 = settleAll([b, a], { m1: "yes" }, 2)
    expect(Object.fromEntries(r1.credits)).toEqual(Object.fromEntries(r2.credits))
    expect(r1.events).toEqual(r2.events)
  })
})
