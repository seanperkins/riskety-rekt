import { describe, expect, it } from "vitest"
import { ENGINE_VERSION, RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction, Market } from "../engine/index.js"
import { openStore } from "./sqlite.js"
import type { OrderBody } from "./types.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }
const DAY = 3 // 2026-09-04

/** An instant on day 3 of the season, at a wall-clock ET hour. EDT is UTC-4. */
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 8, 4, hour + 4, minute))

const MARKET: Market = {
  id: "KX-1",
  question: "q",
  priceYes: 0.4,
  priceNo: 0.6,
  // 20:00 ET on day 3.
  closeTime: at(20).toISOString(),
}

const BODY: OrderBody = { deploys: [], attacks: [], protect: null }
const W = { marketId: "KX-1", side: "yes" as const, stake: 5 }

const factions: Faction[] = ["f1", "f2"].map((id) => ({ id, playerName: id, color: "#000" }))

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  store.publishSlate(SEASON.seasonId, DAY, [MARKET], at(8))
  return store
}

const dealt = () => createSeason(SEASON.seasonId, factions, RISK_MAP.territories.map((t) => t.id))

describe("saveOrder", () => {
  it("accepts an order before the deadline", () => {
    const store = seeded()
    expect(store.saveOrder("s1", DAY, "f1", BODY, at(20))).toEqual({ ok: true })
    store.close()
  })

  it("rejects after the 21:00 deadline even with no state row", () => {
    // The clock is the deadline. An earlier draft used a lock row alone, which
    // silently extended editing whenever the tick ran late.
    const store = seeded()
    expect(store.saveOrder("s1", DAY, "f1", BODY, at(21, 1))).toEqual({
      ok: false,
      reason: "past-deadline",
    })
    store.close()
  })

  it("rejects once the day has resolved", () => {
    // The race guard. A submit that waits behind the tick's transaction then
    // sees the state row rather than landing on a resolved day.
    const store = seeded()
    store.transaction(() => store.saveState({ ...dealt(), day: DAY }, ENGINE_VERSION))
    expect(store.saveOrder("s1", DAY, "f1", BODY, at(20))).toEqual({
      ok: false,
      reason: "already-resolved",
    })
    store.close()
  })

  it("rejects a day outside [1, lengthDays]", () => {
    // currentDay is negative for a season dealt in advance, and orders for a day
    // past the end would never be read by any tick.
    const store = seeded()
    for (const d of [0, -3, 15]) {
      expect(store.saveOrder("s1", d, "f1", BODY, at(20))).toEqual({
        ok: false,
        reason: "day-out-of-range",
      })
    }
    store.close()
  })

  it("replaces the body on a re-submit", () => {
    const store = seeded()
    store.saveOrder("s1", DAY, "f1", BODY, at(9))
    const withDeploy: OrderBody = { ...BODY, deploys: [{ territory: "alaska", count: 2 }] }
    expect(store.saveOrder("s1", DAY, "f1", withDeploy, at(10))).toEqual({ ok: true })
    store.close()
  })
})

describe("saveWager", () => {
  it("accepts a wager on an open, unsettled market", () => {
    // The NULL case, and the one two natural implementations get backwards:
    // SQLite's min() returns NULL when observed_at is absent, so a bare
    // MIN(close_time, observed_at) <= now evaluates NULL and reads a CLOSED
    // market as open.
    const store = seeded()
    expect(store.saveWager("s1", DAY, "f1", W, at(14))).toEqual({ ok: true })
    store.close()
  })

  it("rejects once the market's close time has passed", () => {
    const store = seeded()
    expect(store.saveWager("s1", DAY, "f1", W, at(20, 1))).toEqual({
      ok: false,
      reason: "market-locked",
    })
    store.close()
  })

  it("rejects a market that settled early, with close_time still ahead", () => {
    // can_close_early: the outcome is public hours before the stated close.
    const store = seeded()
    store.recordSettlement("KX-1", "yes", at(12))
    expect(store.saveWager("s1", DAY, "f1", W, at(12, 30))).toEqual({
      ok: false,
      reason: "market-locked",
    })
    store.close()
  })

  it("rejects a market that is not on the day's slate", () => {
    const store = seeded()
    expect(store.saveWager("s1", DAY, "f1", { ...W, marketId: "KX-OTHER" }, at(14))).toEqual({
      ok: false,
      reason: "not-on-slate",
    })
    store.close()
  })

  it("rejects once the day has resolved", () => {
    const store = seeded()
    store.transaction(() => store.saveState({ ...dealt(), day: DAY }, ENGINE_VERSION))
    expect(store.saveWager("s1", DAY, "f1", W, at(14))).toEqual({
      ok: false,
      reason: "already-resolved",
    })
    store.close()
  })

  it("rejects a non-integer or non-positive stake", () => {
    // CHECK (stake > 0) alone does not enforce integrality: INTEGER is a type
    // AFFINITY, so 1.5 binds and stores as 1.5 and 1.5 > 0 passes.
    const store = seeded()
    for (const stake of [1.5, 0, -2, Number.NaN, 2 ** 53]) {
      expect(store.saveWager("s1", DAY, "f1", { ...W, stake }, at(14))).toEqual({
        ok: false,
        reason: "bad-stake",
      })
    }
    store.close()
  })

  it("replaces a re-staked market and preserves first_staked_at", () => {
    // first_staked_at is the ordering key for the sequential-greedy reserve
    // check; letting a re-stake move it would hand the player that lever.
    const store = seeded()
    store.saveWager("s1", DAY, "f1", W, at(9))
    store.saveWager("s1", DAY, "f1", { ...W, side: "no", stake: 7 }, at(10))
    const rows = store.wagersFor("s1", DAY, "f1")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      marketId: "KX-1",
      side: "no",
      stake: 7,
      firstStakedAt: at(9).toISOString(),
    })
    store.close()
  })

  it("orders wagers by first_staked_at then market_id", () => {
    const store = seeded()
    const second: Market = { ...MARKET, id: "KX-2" }
    const third: Market = { ...MARKET, id: "KX-0" }
    store.publishSlate("s1", 4, [MARKET, second, third], at(8))
    store.saveWager("s1", 4, "f1", { marketId: "KX-2", side: "yes", stake: 1 }, at(9))
    // Same instant as KX-2: the market_id tiebreak decides.
    store.saveWager("s1", 4, "f1", { marketId: "KX-0", side: "yes", stake: 1 }, at(9))
    store.saveWager("s1", 4, "f1", { marketId: "KX-1", side: "yes", stake: 1 }, at(8, 30))
    expect(store.wagersFor("s1", 4, "f1").map((r) => r.marketId)).toEqual([
      "KX-1",
      "KX-0",
      "KX-2",
    ])
    store.close()
  })
})
