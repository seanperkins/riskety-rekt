import { describe, expect, it } from "vitest"
import type { Market, Order } from "../engine/index.js"
import { openStore } from "./sqlite.js"
import type { OrderBody } from "./types.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }
const DAY = 3 // 2026-09-04

/** An instant on day 3 of the season, at a wall-clock ET hour. EDT is UTC-4. */
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 8, 4, hour + 4, minute))

const market = (id: string): Market => ({
  id,
  question: "q",
  priceYes: 0.4,
  priceNo: 0.6,
  closeTime: at(20).toISOString(),
})

const EMPTY: OrderBody = { deploys: [], attacks: [], protect: null }

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  store.publishSlate(SEASON.seasonId, DAY, ["KX-0", "KX-1", "KX-2"].map(market), at(8))
  return store
}

describe("assembleOrders", () => {
  it("is empty for a day nobody touched", () => {
    const store = seeded()
    expect(store.assembleOrders("s1", DAY)).toEqual([])
    store.close()
  })

  it("synthesizes an Order for a faction that wagered but never submitted a body", () => {
    // The two CLI commands are independent; those wagers must not vanish.
    const store = seeded()
    store.saveWager("s1", DAY, "f2", { marketId: "KX-1", side: "yes", stake: 4 }, at(9))
    expect(store.assembleOrders("s1", DAY)).toEqual<Order[]>([
      {
        factionId: "f2",
        deploys: [],
        attacks: [],
        protect: null,
        wagers: [{ marketId: "KX-1", side: "yes", stake: 4 }],
      },
    ])
    store.close()
  })

  it("gives a body with no wagers an empty wagers array", () => {
    // Not `undefined`: the engine iterates `o.wagers` unconditionally.
    const store = seeded()
    store.saveOrder("s1", DAY, "f1", EMPTY, at(9))
    expect(store.assembleOrders("s1", DAY)[0]?.wagers).toEqual([])
    store.close()
  })

  it("round-trips deploys, attacks and protect from the stored body", () => {
    const store = seeded()
    const body: OrderBody = {
      deploys: [{ territory: "alaska", count: 3 }],
      attacks: [{ from: "alaska", to: "alberta", count: 2 }],
      protect: "kamchatka",
    }
    store.saveOrder("s1", DAY, "f1", body, at(9))
    expect(store.assembleOrders("s1", DAY)[0]).toEqual<Order>({
      factionId: "f1",
      ...body,
      wagers: [],
    })
    store.close()
  })

  it("merges a faction's body and wagers into one order", () => {
    const store = seeded()
    store.saveOrder("s1", DAY, "f1", { ...EMPTY, protect: "peru" }, at(9))
    store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "no", stake: 6 }, at(10))
    const orders = store.assembleOrders("s1", DAY)
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      factionId: "f1",
      protect: "peru",
      wagers: [{ marketId: "KX-1", side: "no", stake: 6 }],
    })
    store.close()
  })

  it("orders wagers by first_staked_at then market_id", () => {
    // The reserve check is sequential-greedy, so this decides which bet survives
    // a short reserve. Ordering by updated_at would hand the player that lever:
    // re-stake the bet you want kept and it jumps the queue.
    const store = seeded()
    store.saveWager("s1", DAY, "f1", { marketId: "KX-2", side: "yes", stake: 1 }, at(9))
    // Same instant as KX-2, so the market_id tiebreak decides between them.
    store.saveWager("s1", DAY, "f1", { marketId: "KX-0", side: "yes", stake: 1 }, at(9))
    store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "yes", stake: 1 }, at(8, 30))
    // Re-stake the last one; first_staked_at must not move, so it stays first.
    store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "no", stake: 9 }, at(11))
    expect(store.assembleOrders("s1", DAY)[0]?.wagers.map((w) => w.marketId)).toEqual([
      "KX-1",
      "KX-0",
      "KX-2",
    ])
    store.close()
  })

  it("sorts factions by id, whichever table they came from", () => {
    // The engine sorts orders itself, but assembly feeding tick_context means
    // this list is persisted verbatim and replayed by tick:rerun.
    const store = seeded()
    store.saveWager("s1", DAY, "f3", { marketId: "KX-1", side: "yes", stake: 1 }, at(9))
    store.saveOrder("s1", DAY, "f2", EMPTY, at(9))
    store.saveOrder("s1", DAY, "f1", EMPTY, at(9))
    expect(store.assembleOrders("s1", DAY).map((o) => o.factionId)).toEqual(["f1", "f2", "f3"])
    store.close()
  })

  it("reads only the requested day", () => {
    const store = seeded()
    store.publishSlate("s1", 4, [market("KX-1")], at(8))
    store.saveOrder("s1", DAY, "f1", EMPTY, at(9))
    store.saveWager("s1", 4, "f2", { marketId: "KX-1", side: "yes", stake: 2 }, at(9))
    expect(store.assembleOrders("s1", DAY).map((o) => o.factionId)).toEqual(["f1"])
    store.close()
  })

  it("cannot be reached by a malformed stake, because the column CHECK blocks it", () => {
    // The plan called for a `rawInsertWager` seam here, to prove assembly's
    // `stake > 0 AND typeof(stake) = 'integer'` filter drops a 1.5. No such seam
    // can exist: migration 3 puts that same pair on the column, so the row is
    // unstorable and the seam would fail on the same CHECK.
    //
    // So the filter is unreachable defense-in-depth and this test pins the gate
    // that actually holds. It matters because the engine's response to a bad
    // stake is a PUBLIC rejection -- recap.ts renders it by faction and market,
    // so a malformed row would read as an accusation.
    const store = seeded()
    for (const stake of [1.5, 0, -2]) {
      expect(
        store.saveWager("s1", DAY, "f1", { marketId: "KX-1", side: "yes", stake }, at(9)),
      ).toEqual({ ok: false, reason: "bad-stake" })
    }
    expect(store.assembleOrders("s1", DAY)).toEqual([])
    store.close()
  })
})
