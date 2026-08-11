import { describe, expect, it } from "vitest"
import type { Market } from "../engine/index.js"
import { openStore } from "./sqlite.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }
const DAY = 3
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 8, 4, hour + 4, minute))

const market = (id: string, yes: number): Market => ({
  id,
  question: "q",
  priceYes: yes,
  priceNo: Math.round((1 - yes) * 100) / 100,
  closeTime: at(20).toISOString(),
})

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  store.publishSlate("s1", DAY, [market("KX-1", 0.2)], at(8))
  return store
}

describe("live prices and the stale-price exploit", () => {
  it("prices a wager at the SLATE price when the poller has nothing", () => {
    const store = seeded()
    store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "yes", stake: 5 }, at(9))
    expect(store.wagersFor("s1", DAY, "f1")[0]?.price).toBe(0.2)
    store.close()
  })

  it("prices a wager at the LIVE price once the poller has run", () => {
    // The exploit, closed. The slate froze KX-1 at 0.2 this morning; by 20:00
    // the outcome is nearly public and the market says 0.9. A wager placed now
    // must pay at 0.9, not at the morning's odds.
    const store = seeded()
    store.recordPrices([market("KX-1", 0.9)], at(19, 50))
    store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "yes", stake: 5 }, at(19, 59))
    expect(store.wagersFor("s1", DAY, "f1")[0]?.price).toBe(0.9)
    store.close()
  })

  it("leaves the published slate frozen", () => {
    // publishSlate refuses a second write so a rerun cannot re-snapshot the day.
    // Live prices must not smuggle that back in.
    const store = seeded()
    store.recordPrices([market("KX-1", 0.9)], at(19, 50))
    expect(store.loadSlate("s1", DAY)[0]?.priceYes).toBe(0.2)
    store.close()
  })

  it("re-prices when a wager is re-staked", () => {
    // Otherwise a player takes the morning's odds, waits, and switches sides
    // once the outcome is clear while keeping the stale price.
    const store = seeded()
    store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "yes", stake: 5 }, at(9))
    store.recordPrices([market("KX-1", 0.9)], at(19))
    store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "yes", stake: 6 }, at(19, 30))
    const row = store.wagersFor("s1", DAY, "f1")[0]!
    expect(row.price).toBe(0.9)
    // ...but first_staked_at still anchors the reserve ordering.
    expect(row.firstStakedAt).toBe(at(9).toISOString())
    store.close()
  })

  it("takes the latest price, unlike settlements which take the first", () => {
    const store = seeded()
    store.recordPrices([market("KX-1", 0.5)], at(12))
    store.recordPrices([market("KX-1", 0.7)], at(18))
    store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "yes", stake: 1 }, at(19))
    expect(store.wagersFor("s1", DAY, "f1")[0]?.price).toBe(0.7)
    store.close()
  })

  it("carries the price through assembly to the engine", () => {
    const store = seeded()
    store.recordPrices([market("KX-1", 0.75)], at(18))
    store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "no", stake: 2 }, at(19))
    expect(store.assembleOrders("s1", DAY)[0]?.wagers[0]?.price).toBe(0.25)
    store.close()
  })
})
