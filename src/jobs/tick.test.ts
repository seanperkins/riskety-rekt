import { describe, expect, it } from "vitest"
import { ENGINE_VERSION, RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction, GameState, Market } from "../engine/index.js"
import { openStore } from "../store/sqlite.js"
import { runTick } from "./tick.js"
import { pendingWagersOf } from "../engine/modules/index.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }

/** A wall-clock ET instant on a season day. Sep is EDT, UTC-4. */
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

const market = (id: string, day: number): Market => ({
  id,
  question: `will ${id}?`,
  priceYes: 0.4,
  priceNo: 0.6,
  closeTime: at(day, 20).toISOString(),
})

interface SeedOpts {
  /** Save states for days 0..latestSavedDay. Omit for a season with no deal. */
  latestSavedDay?: number
}

function seeded(opts: SeedOpts = {}) {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  if (opts.latestSavedDay !== undefined) {
    const base = dealt()
    for (let day = 0; day <= opts.latestSavedDay; day++) {
      store.transaction(() => store.saveState({ ...base, day }, ENGINE_VERSION))
    }
  }
  return { store, seasonId: "s1" }
}

describe("runTick — the day clock", () => {
  it("resolves the aligned case", () => {
    const d = seeded({ latestSavedDay: 4 })
    const out = runTick({ ...d, now: at(5, 21, 30) })
    expect(out).toMatchObject({ status: "resolved", day: 5 })
    expect(d.store.loadState("s1", 5)).toBeDefined()
    d.store.close()
  })

  it("refuses when a day was missed, including the FINAL day", () => {
    // lengthDays 14, day 14 missed, operator looks on day 15. min(15-1, 14) = 14
    // and latestSaved 13 < 14 -> refuse. A plainer `latestSaved + 1 <
    // calendarDay` placed after the after-season skip exits 0 here, losing the
    // winner and confiscating day-13 wagers that can never settle.
    const d = seeded({ latestSavedDay: 13 })
    expect(runTick({ ...d, now: at(15, 21, 30) })).toEqual({
      status: "refused",
      reason: "missing-days",
      from: 14,
      to: 14,
    })
    d.store.close()
  })

  it("refuses a mid-season gap, naming every missing day", () => {
    const d = seeded({ latestSavedDay: 4 })
    expect(runTick({ ...d, now: at(8, 21, 30) })).toEqual({
      status: "refused",
      reason: "missing-days",
      from: 5,
      to: 7,
    })
    d.store.close()
  })

  it("skips after-season once every day has ticked", () => {
    const d = seeded({ latestSavedDay: 14 })
    expect(runTick({ ...d, now: at(15, 21, 30) })).toMatchObject({
      status: "skipped",
      reason: "after-season",
    })
    d.store.close()
  })

  it("skips before the season starts, even dealt weeks in advance", () => {
    // season-init takes a start date, so dealing early is supported. A tick that
    // derived its day from saved state would resolve day 1 that very night and
    // keep burning one day per night until the season began.
    const d = seeded({ latestSavedDay: 0 })
    expect(runTick({ ...d, now: at(-5, 21, 30) })).toMatchObject({
      status: "skipped",
      reason: "before-season",
    })
    d.store.close()
  })

  it("skips a sequential double-fire", () => {
    // Fire, complete, fire again. A state-derived guard is idempotent per GAME
    // day, not per calendar day: it would compute N+1, find no state there, and
    // resolve it as plain Risk with zero orders.
    const d = seeded({ latestSavedDay: 5 })
    expect(runTick({ ...d, now: at(5, 21, 30) })).toMatchObject({
      status: "skipped",
      reason: "already-run",
    })
    d.store.close()
  })

  it("skips before the 21:00 cutoff", () => {
    // Without this a manual run at 14:00 resolves the day while its markets are
    // still open and its approvals still arriving.
    const d = seeded({ latestSavedDay: 4 })
    expect(runTick({ ...d, now: at(5, 14) })).toMatchObject({
      status: "skipped",
      reason: "before-cutoff",
    })
    expect(d.store.loadState("s1", 5)).toBeUndefined()
    d.store.close()
  })

  it("resolves exactly at 21:00:00", () => {
    const d = seeded({ latestSavedDay: 4 })
    expect(runTick({ ...d, now: at(5, 21) })).toMatchObject({ status: "resolved" })
    d.store.close()
  })

  it("refuses a season with no day-0 state", () => {
    // Runs FIRST. latestSavedDay is undefined until it passes, and defaulting it
    // to 0 would let this season reach the transaction and fail loading
    // states[0] -- a stack trace where a named refusal was intended.
    const d = seeded()
    expect(runTick({ ...d, now: at(1, 21, 30) })).toEqual({ status: "refused", reason: "no-deal" })
    d.store.close()
  })

  it("throws on an unknown season", () => {
    const d = seeded({ latestSavedDay: 0 })
    expect(() => runTick({ ...d, seasonId: "nope", now: at(1, 21, 30) })).toThrow(/unknown season/)
    d.store.close()
  })
})

describe("runTick — behaviour", () => {
  it("records the assembled orders and context alongside the state", () => {
    const d = seeded({ latestSavedDay: 4 })
    d.store.publishSlate("s1", 5, [market("KX-1", 5)], at(5, 8))
    d.store.saveOrder("s1", 5, "f1", { deploys: [], attacks: [], protect: null }, at(5, 9))
    d.store.saveWager("s1", 5, "f1", { marketId: "KX-1", side: "yes", stake: 3 }, at(5, 9))

    expect(runTick({ ...d, now: at(5, 21, 30) })).toMatchObject({ status: "resolved" })
    const frozen = d.store.loadTickContext("s1", 5)
    expect(frozen?.engineVersion).toBe(ENGINE_VERSION)
    expect(frozen?.orders).toEqual([
      {
        factionId: "f1",
        deploys: [],
        attacks: [],
        protect: null,
        wagers: [{ marketId: "KX-1", side: "yes", stake: 3, price: 0.4 }],
      },
    ])
    expect(frozen?.context.slate.map((m) => m.id)).toEqual(["KX-1"])
    d.store.close()
  })

  it("snapshots settlements for prior pending markets, not just today's slate", () => {
    // resolve settles ALL matured pending wagers at step 1, including wagers on
    // markets absent from today's slate, while loadSettlements returns only the
    // ids it is asked for. Snapshotting the slate alone marks those unsettled
    // and refunds them.
    const store = openStore(":memory:")
    store.upsertSeason(SEASON)
    const base = dealt()
    const withPending: GameState = {
      ...base,
      day: 4,
      moduleState: {
        markets: {
          pending: [
            {
              wagerId: "w1",
              factionId: "f1",
              marketId: "KX-OLD",
              side: "yes",
              stake: 5,
              price: 0.4,
              placedOnDay: 4,
            },
          ],
        },
      },
    }
    for (let day = 0; day <= 3; day++) {
      store.transaction(() => store.saveState({ ...base, day }, ENGINE_VERSION))
    }
    store.transaction(() => store.saveState(withPending, ENGINE_VERSION))

    // KX-OLD is settled but is NOT on day 5's slate.
    store.publishSlate("s1", 4, [market("KX-OLD", 4)], at(4, 8))
    store.publishSlate("s1", 5, [market("KX-NEW", 5)], at(5, 8))
    store.recordSettlement("KX-OLD", "yes", at(4, 20, 30))

    runTick({ store, seasonId: "s1", now: at(5, 21, 30) })
    const frozen = store.loadTickContext("s1", 5)
    expect(frozen?.context.settlements["KX-OLD"]).toBe("yes")
    expect(frozen?.context.settlements["KX-NEW"]).toBe("unsettled")
    // And the wager actually paid: 5 at 0.4 yes returns more than the stake.
    expect(store.loadState("s1", 5)?.reserves["f1"]).toBeGreaterThan(0)
    expect(pendingWagersOf(store.loadState("s1", 5)!)).toHaveLength(0)
    store.close()
  })

  it("leaves nothing behind when resolve throws", () => {
    // One transaction, so a crash rolls back to nothing and a retry starts
    // clean. There is no half-state to adopt and no lock row to collide with.
    const d = seeded({ latestSavedDay: 4 })
    expect(() =>
      runTick({
        ...d,
        now: at(5, 21, 30),
        resolve: () => {
          throw new Error("boom")
        },
      }),
    ).toThrow("boom")
    expect(d.store.loadState("s1", 5)).toBeUndefined()
    expect(d.store.loadTickContext("s1", 5)).toBeUndefined()
    d.store.close()
  })

  it("returns already-run for a second call, without resolving again", () => {
    const d = seeded({ latestSavedDay: 4 })
    const first = runTick({ ...d, now: at(5, 21, 30) })
    expect(first).toMatchObject({ status: "resolved" })

    let resolveCalls = 0
    const second = runTick({
      ...d,
      now: at(5, 21, 45),
      resolve: (...args) => {
        resolveCalls++
        return args[0]
      },
    })
    expect(second).toMatchObject({ status: "skipped", reason: "already-run" })
    expect(resolveCalls).toBe(0)
    d.store.close()
  })

  it("rejects orders for the day it is resolving", () => {
    // The race guard from the other side: a submit that waits behind the tick's
    // transaction then sees the state row rather than landing on a resolved day.
    const d = seeded({ latestSavedDay: 4 })
    runTick({ ...d, now: at(5, 21, 30) })
    expect(
      d.store.saveOrder("s1", 5, "f1", { deploys: [], attacks: [], protect: null }, at(5, 20)),
    ).toEqual({ ok: false, reason: "already-resolved" })
    d.store.close()
  })

  it("advances the day and carries the previous state forward", () => {
    const d = seeded({ latestSavedDay: 4 })
    const out = runTick({ ...d, now: at(5, 21, 30) })
    if (out.status !== "resolved") throw new Error("expected resolved")
    expect(out.previous.day).toBe(4)
    expect(out.next.day).toBe(5)
    // Income was granted, so every faction gained.
    for (const f of factions) expect(out.next.reserves[f.id]).toBeGreaterThan(0)
    d.store.close()
  })
})

describe("runTick — the rule tally", () => {
  const slackTs = (d: Date) => `${d.getTime() / 1000}.000100`

  const withOffer = () => {
    const d = seeded({ latestSavedDay: 4 })
    d.store.claimRuleOffers("s1", 5, ["boom", "truce"], "7")
    d.store.recordOfferMessage("s1", 5, "1756758000.000100")
    return d
  }

  it("freezes the winner into ctx.rules and the rule's effect lands", () => {
    const d = withOffer()
    d.store.recordRuleReaction({
      seasonId: "s1", day: 5, factionId: "f1", ordinal: 1, reactedAt: slackTs(at(5, 12)),
    })
    const out = runTick({ ...d, now: at(5, 21, 30) })
    if (out.status !== "resolved") throw new Error("expected resolved")
    expect(d.store.loadTickContext("s1", 5)!.context.rules).toEqual(["boom"])
    expect(out.next.log.some((e) => e.t === "grant" && e.source === "boom")).toBe(true)
    d.store.close()
  })

  it("a day with offers but no votes freezes rules: [] and resolves normally", () => {
    const d = withOffer()
    const out = runTick({ ...d, now: at(5, 21, 30) })
    expect(out).toMatchObject({ status: "resolved", day: 5 })
    expect(d.store.loadTickContext("s1", 5)!.context.rules).toEqual([])
    d.store.close()
  })

  it("the delayed-tick regression: a post-21:00 reaction is present but never counts", () => {
    // The reaction row is stored (its webhook landed before the late tick's
    // transaction), but reacted_at is 21:30 — past the tick instant. The
    // explicit cutoff predicate excludes it end to end.
    const d = withOffer()
    d.store.recordRuleReaction({
      seasonId: "s1", day: 5, factionId: "f1", ordinal: 1, reactedAt: slackTs(at(5, 21, 30)),
    })
    const out = runTick({ ...d, now: at(5, 22, 0) })
    expect(out).toMatchObject({ status: "resolved", day: 5 })
    expect(d.store.loadTickContext("s1", 5)!.context.rules).toEqual([])
    d.store.close()
  })
})
