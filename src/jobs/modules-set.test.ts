import { describe, expect, it } from "vitest"
import { ENGINE_VERSION, RISK_MAP, createSeason } from "../engine/index.js"
import { openStore } from "../store/sqlite.js"
import { runModulesSet } from "./modules-set.js"
import { runPollPrices } from "./poll-prices.js"
import { runPollSettlements } from "./poll-settlements.js"
import { runPublishSlate } from "./publish-slate.js"
import { runTick } from "./tick.js"
import type { Faction, GameState } from "../engine/index.js"
import type { MarketAdapter } from "../adapters/types.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }
const at = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 1 + day, hour + 4, minute))

const factions: Faction[] = ["f1", "f2", "f3", "f4"].map((id) => ({
  id,
  playerName: id,
  color: "#000",
}))

const dealt = (): GameState =>
  createSeason(
    SEASON.seasonId,
    factions,
    RISK_MAP.territories.map((t) => t.id),
  )

const explodingAdapter: MarketAdapter = {
  // A gated poller must return before any network call — hence an adapter
  // that fails the test loudly if touched.
  getSlateCandidates: () => Promise.reject(new Error("network touched")),
  getSettlements: () => Promise.reject(new Error("network touched")),
  getPrices: () => Promise.reject(new Error("network touched")),
} as unknown as MarketAdapter

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  store.transaction(() => store.saveState(dealt(), ENGINE_VERSION))
  return store
}

describe("runModulesSet — the operator's mid-season change", () => {
  it("applies a valid change and records it for the NEXT day's context only", () => {
    const store = seeded()
    const out = runModulesSet({ store, seasonId: "s1", modules: ["irl"] })
    expect(out).toEqual({ status: "applied", modules: ["irl"] })
    expect(store.season("s1")?.modules).toEqual(["irl"])
    // The change is visible in the next tick's frozen context.
    const tick = runTick({ store, seasonId: "s1", now: at(1, 21, 30) })
    expect(tick.status).toBe("resolved")
    expect(store.loadTickContext("s1", 1)?.context.modules).toEqual(["irl"])
    store.close()
  })

  it("refuses veto without irl and unknown ids — season-init's rules apply mid-season too", () => {
    const store = seeded()
    expect(runModulesSet({ store, seasonId: "s1", modules: ["markets", "veto"] })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/veto requires irl/),
    })
    expect(runModulesSet({ store, seasonId: "s1", modules: ["ghost"] })).toMatchObject({
      status: "refused",
    })
    store.close()
  })

  it("refuses to disable markets while escrow is non-zero, allows it once idle", () => {
    const store = seeded()
    const withEscrow: GameState = {
      ...dealt(),
      day: 1,
      moduleState: {
        markets: {
          pending: [
            {
              wagerId: "w1",
              factionId: "f1",
              marketId: "m1",
              side: "yes",
              stake: 4,
              price: 0.5,
              placedOnDay: 1,
            },
          ],
        },
      },
    }
    store.transaction(() => store.saveState(withEscrow, ENGINE_VERSION))
    expect(runModulesSet({ store, seasonId: "s1", modules: ["irl"] })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/4 escrowed/),
    })

    // Idle book ({pending: []} — structurally non-empty, semantically idle):
    // the gate is escrowed > 0, not slot presence, so this applies.
    const idle: GameState = { ...withEscrow, day: 2, moduleState: { markets: { pending: [] } } }
    store.transaction(() => store.saveState(idle, ENGINE_VERSION))
    expect(runModulesSet({ store, seasonId: "s1", modules: ["irl"] })).toMatchObject({
      status: "applied",
    })
    store.close()
  })

  it("disable-then-re-enable resurrects nothing: the slot drops at the next tick", () => {
    const store = seeded()
    runModulesSet({ store, seasonId: "s1", modules: [] })
    const t1 = runTick({ store, seasonId: "s1", now: at(1, 21, 30) })
    expect(t1.status).toBe("resolved")
    expect(store.loadState("s1", 1)?.moduleState).toEqual({})

    runModulesSet({ store, seasonId: "s1", modules: ["markets", "irl", "veto"] })
    const t2 = runTick({ store, seasonId: "s1", now: at(2, 21, 30) })
    expect(t2.status).toBe("resolved")
    // The markets module starts FRESH: an empty book, no resurrected escrow.
    expect(store.loadState("s1", 2)?.moduleState).toEqual({ markets: { pending: [] } })
    store.close()
  })
})

describe("module-off gating in the market jobs", () => {
  it("publish-slate skips exit-0-style with markets off, touching no network", async () => {
    const store = seeded()
    runModulesSet({ store, seasonId: "s1", modules: ["irl"] })
    const out = await runPublishSlate({
      store,
      adapter: explodingAdapter,
      seasonId: "s1",
      now: at(3, 8),
    })
    expect(out).toMatchObject({ status: "skipped", reason: "markets-off" })
    store.close()
  })

  it("both pollers skip with markets off, touching no network", async () => {
    const store = seeded()
    runModulesSet({ store, seasonId: "s1", modules: ["irl"] })
    expect(
      await runPollSettlements({ store, adapter: explodingAdapter, seasonId: "s1", now: at(3, 12) }),
    ).toEqual({ checked: 0, recorded: 0, stillOpen: 0 })
    expect(
      await runPollPrices({ store, adapter: explodingAdapter, seasonId: "s1", now: at(3, 12) }),
    ).toMatchObject({ markets: 0, refreshed: 0 })
    store.close()
  })
})
