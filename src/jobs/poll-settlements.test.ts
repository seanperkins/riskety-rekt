import { describe, expect, it } from "vitest"
import { runPollSettlements } from "./poll-settlements.js"
import { openStore } from "../store/sqlite.js"
import type { MarketAdapter } from "../adapters/types.js"
import type { Market, MarketId, Settlement } from "../engine/index.js"
import type { SlateStore } from "../store/types.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 21 }
const NOW = new Date("2026-09-04T20:00:00Z")

function market(id: string, closeTime = "2026-09-04T18:00:00Z"): Market {
  return { id, question: `q ${id}`, priceYes: 0.4, priceNo: 0.6, closeTime }
}

function stubAdapter(
  outcomes: Record<MarketId, Settlement> | Error,
): MarketAdapter & { asked: MarketId[][] } {
  const asked: MarketId[][] = []
  return {
    asked,
    async getCandidates() {
      return []
    },
    async getSettlements(ids) {
      asked.push(ids)
      if (outcomes instanceof Error) throw outcomes
      const out: Record<MarketId, Settlement> = {}
      for (const id of ids) out[id] = outcomes[id] ?? "unsettled"
      return out
    },
  }
}

function fresh(): SlateStore {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  return store
}

describe("runPollSettlements", () => {
  it("records settled outcomes", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A"), market("B")], NOW)
    const out = await runPollSettlements({
      store,
      adapter: stubAdapter({ A: "yes", B: "no" }),
      seasonId: "s1",
      now: NOW,
    })
    expect(out).toEqual({ checked: 2, recorded: 2, stillOpen: 0 })
    expect(store.loadSettlements(["A", "B"])).toEqual({ A: "yes", B: "no" })
    store.close()
  })

  it("leaves unsettled markets unrecorded so a later poll can catch them", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A"), market("B")], NOW)
    const out = await runPollSettlements({
      store,
      adapter: stubAdapter({ A: "yes" }),
      seasonId: "s1",
      now: NOW,
    })
    expect(out).toEqual({ checked: 2, recorded: 1, stillOpen: 1 })
    expect(store.loadSettlements(["B"])).toEqual({ B: "unsettled" })
    store.close()
  })

  it("does nothing and makes no call when nothing is awaiting settlement", async () => {
    const store = fresh()
    const adapter = stubAdapter({})
    const out = await runPollSettlements({ store, adapter, seasonId: "s1", now: NOW })
    expect(out).toEqual({ checked: 0, recorded: 0, stillOpen: 0 })
    expect(adapter.asked).toEqual([])
    store.close()
  })

  it("does not re-ask about a market it already settled", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A"), market("B")], NOW)
    await runPollSettlements({
      store,
      adapter: stubAdapter({ A: "yes" }),
      seasonId: "s1",
      now: NOW,
    })
    const second = stubAdapter({ B: "no" })
    await runPollSettlements({ store, adapter: second, seasonId: "s1", now: NOW })
    expect(second.asked).toEqual([["B"]])
    store.close()
  })

  it("ignores markets that have not closed", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A", "2026-09-04T23:00:00Z")], NOW)
    const adapter = stubAdapter({ A: "yes" })
    const out = await runPollSettlements({ store, adapter, seasonId: "s1", now: NOW })
    expect(out.checked).toBe(0)
    expect(adapter.asked).toEqual([])
    store.close()
  })

  it("absorbs an adapter failure without throwing", async () => {
    // The poller is a background job on a 30-minute timer. A Kalshi outage must
    // not page anyone; the next run picks the market up, and if it never
    // settles the engine refunds the wager after two ticks.
    const store = fresh()
    store.publishSlate("s1", 3, [market("A")], NOW)
    const out = await runPollSettlements({
      store,
      adapter: stubAdapter(new Error("kalshi unreachable")),
      seasonId: "s1",
      now: NOW,
    })
    expect(out).toEqual({ checked: 1, recorded: 0, stillOpen: 1 })
    expect(store.loadSettlements(["A"])).toEqual({ A: "unsettled" })
    store.close()
  })

  it("logs the failure it absorbed", async () => {
    const lines: string[] = []
    const store = fresh()
    store.publishSlate("s1", 3, [market("A")], NOW)
    await runPollSettlements({
      store,
      adapter: stubAdapter(new Error("kalshi unreachable")),
      seasonId: "s1",
      now: NOW,
      log: (m) => lines.push(m),
    })
    expect(lines.some((l) => /kalshi unreachable/.test(l))).toBe(true)
    store.close()
  })

  it("keeps the first outcome if a market is somehow reported twice", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A")], NOW)
    await runPollSettlements({
      store,
      adapter: stubAdapter({ A: "yes" }),
      seasonId: "s1",
      now: NOW,
    })
    // The market is settled, so the poller will not ask again. Prove the store
    // itself holds the line against a conflicting later write.
    expect(store.recordSettlement("A", "no", NOW)).toBe(false)
    expect(store.loadSettlements(["A"])).toEqual({ A: "yes" })
    store.close()
  })
})
