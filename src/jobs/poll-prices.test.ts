import { describe, expect, it } from "vitest"
import type { Market, MarketId, Settlement } from "../engine/index.js"
import type { MarketAdapter } from "../adapters/types.js"
import { openStore } from "../store/sqlite.js"
import { runPollPrices } from "./poll-prices.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }
const NOW = new Date("2026-09-04T22:00:00Z") // 18:00 ET on day 3
const market = (id: string, yes: number): Market => ({
  id,
  question: `q ${id}`,
  priceYes: yes,
  priceNo: Math.round((1 - yes) * 100) / 100,
  closeTime: "2026-09-05T00:00:00.000Z",
})

function stub(out: Market[] | Error): MarketAdapter {
  return {
    async getCandidates() {
      if (out instanceof Error) throw out
      return out.map((m) => ({ ...m, series: "S", volume: 1000 }))
    },
    async getSettlements(): Promise<Record<MarketId, Settlement>> {
      return {}
    },
  }
}

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  store.publishSlate("s1", 3, [market("A", 0.2), market("B", 0.5)], new Date("2026-09-04T12:00:00Z"))
  return store
}

describe("runPollPrices", () => {
  it("refreshes the slate's markets", () => {
    const store = seeded()
    return runPollPrices({ store, adapter: stub([market("A", 0.8)]), seasonId: "s1", now: NOW }).then(
      (out) => {
        expect(out).toMatchObject({ day: 3, markets: 2, refreshed: 1 })
        store.saveWager("s1", 3, "f1", { marketId: "A", side: "yes", stake: 1 }, NOW)
        expect(store.wagersFor("s1", 3, "f1")[0]?.price).toBe(0.8)
        store.close()
      },
    )
  })

  it("ignores markets that are not on today's slate", async () => {
    // Kalshi returns thousands; writing them all would grow the table without
    // bound and none of them can be wagered on.
    const store = seeded()
    const out = await runPollPrices({
      store,
      adapter: stub([market("A", 0.8), market("NOT-ON-SLATE", 0.5)]),
      seasonId: "s1",
      now: NOW,
    })
    expect(out.refreshed).toBe(1)
    store.close()
  })

  it("leaves prices alone when the adapter fails", async () => {
    // A Kalshi outage must not throw: the tick still never touches the network,
    // and a stale price is the old behaviour rather than a new failure.
    const store = seeded()
    await runPollPrices({ store, adapter: stub([market("A", 0.8)]), seasonId: "s1", now: NOW })
    const out = await runPollPrices({
      store,
      adapter: stub(new Error("kalshi down")),
      seasonId: "s1",
      now: NOW,
    })
    expect(out.refreshed).toBe(0)
    store.saveWager("s1", 3, "f1", { marketId: "A", side: "yes", stake: 1 }, NOW)
    expect(store.wagersFor("s1", 3, "f1")[0]?.price).toBe(0.8)
    store.close()
  })

  it("does nothing on a day with no slate", async () => {
    const store = openStore(":memory:")
    store.upsertSeason(SEASON)
    expect(await runPollPrices({ store, adapter: stub([]), seasonId: "s1", now: NOW })).toMatchObject({
      markets: 0,
      refreshed: 0,
    })
    store.close()
  })

  it("throws on an unknown season", async () => {
    const store = seeded()
    await expect(
      runPollPrices({ store, adapter: stub([]), seasonId: "nope", now: NOW }),
    ).rejects.toThrow(/unknown season/)
    store.close()
  })
})
