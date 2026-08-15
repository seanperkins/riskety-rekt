import { describe, expect, it } from "vitest"
import { ENGINE_VERSION, RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction, GameState, Market } from "../engine/index.js"
import { openStore } from "../store/sqlite.js"
import { runTick } from "./tick.js"
import { UsageError } from "./flags.js"
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
  it("resolves the day that just ENDED, not the one it wakes up in", () => {
    // The scheduled 00:05 run on season day 6 resolves day 5. This is the whole
    // inversion: the tick fires AT the boundary, so currentDay has already
    // rolled and `day = calendarDay - 1` is the day owed a resolution.
    const d = seeded({ latestSavedDay: 4 })
    const out = runTick({ ...d, now: at(6, 0, 5) })
    expect(out).toMatchObject({ status: "resolved", day: 5 })
    expect(d.store.loadState("s1", 5)).toBeDefined()
    expect(d.store.loadState("s1", 6)).toBeUndefined()
    d.store.close()
  })

  it("resolves the FINAL day of the season", () => {
    // The guard that reads `day > lengthDays` rather than `calendarDay >
    // lengthDays`. Day 14 of a 14-day season resolves when calendarDay is
    // already 15, so a calendarDay test skips the last night of the season --
    // silently, and only on the one day of the season when it matters.
    const d = seeded({ latestSavedDay: 13 })
    expect(runTick({ ...d, now: at(15, 0, 5) })).toMatchObject({
      status: "resolved",
      day: 14,
    })
    d.store.close()
  })

  it("resolves the first day, and not before", () => {
    // Day 0 is the deal and never ticks. The first real resolution is day 1, at
    // the midnight that ends it -- when calendarDay has become 2.
    const d = seeded({ latestSavedDay: 0 })
    expect(runTick({ ...d, now: at(1, 0, 5) })).toMatchObject({
      status: "skipped",
      reason: "before-season",
    })
    expect(runTick({ ...d, now: at(2, 0, 5) })).toMatchObject({ status: "resolved", day: 1 })
    d.store.close()
  })

  it("refuses when a day was missed, including the FINAL day", () => {
    // lengthDays 14, day 14 missed, operator looks the following day. day is
    // 15, min(15-1, 14) = 14, and latestSaved 13 < 14 -> refuse. A plainer
    // `latestSaved + 1 < day` placed after the after-season skip exits 0 here,
    // losing the winner and confiscating day-13 wagers that can never settle.
    const d = seeded({ latestSavedDay: 13 })
    expect(runTick({ ...d, now: at(16, 0, 5) })).toEqual({
      status: "refused",
      reason: "missing-days",
      from: 14,
      to: 14,
    })
    d.store.close()
  })

  it("refuses a mid-season gap, naming every missing day", () => {
    const d = seeded({ latestSavedDay: 4 })
    expect(runTick({ ...d, now: at(9, 0, 5) })).toEqual({
      status: "refused",
      reason: "missing-days",
      from: 5,
      to: 7,
    })
    d.store.close()
  })

  it("skips after-season once every day has ticked", () => {
    const d = seeded({ latestSavedDay: 14 })
    expect(runTick({ ...d, now: at(16, 0, 5) })).toMatchObject({
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
    expect(runTick({ ...d, now: at(-5, 0, 5) })).toMatchObject({
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
    expect(runTick({ ...d, now: at(6, 0, 5) })).toMatchObject({
      status: "skipped",
      reason: "already-run",
    })
    d.store.close()
  })

  it("a manual midday run resolves the closed day, never an open one", () => {
    // This replaces the old before-cutoff test, which could only be reached
    // while the tick ran INSIDE the day it resolved. `day = calendarDay - 1`
    // always names a day that has ended, so a 14:00 run on day 6 resolves day
    // 5 -- whose markets closed and whose approvals stopped at midnight -- and
    // cannot touch day 6 at all.
    const d = seeded({ latestSavedDay: 4 })
    expect(runTick({ ...d, now: at(6, 14) })).toMatchObject({ status: "resolved", day: 5 })
    expect(d.store.loadState("s1", 6)).toBeUndefined()
    d.store.close()
  })

  it("resolves exactly at the midnight boundary", () => {
    const d = seeded({ latestSavedDay: 4 })
    expect(runTick({ ...d, now: at(6, 0) })).toMatchObject({ status: "resolved", day: 5 })
    d.store.close()
  })

  it("crosses over from the 21:00 era without losing or repeating a day", () => {
    // The live-season cutover. The last 21:00-era tick resolved day 5; the
    // change lands; the next run is the 00:05 one ending day 6. latestSaved is
    // 5 and calendarDay is 7, so day is 6: missing-days stays quiet (owed 5),
    // already-run stays quiet, and day 6 resolves. That day was 27 hours long
    // and nothing else moved.
    const d = seeded({ latestSavedDay: 5 })
    expect(runTick({ ...d, now: at(7, 0, 5) })).toMatchObject({ status: "resolved", day: 6 })
    d.store.close()
  })

  it("skips when the cutover lands after a 21:00-era tick already ran", () => {
    // Deploying at 22:00, after that evening's old-style tick resolved day 6.
    // The midnight run two hours later must not resolve day 6 again.
    const d = seeded({ latestSavedDay: 6 })
    expect(runTick({ ...d, now: at(7, 0, 5) })).toMatchObject({
      status: "skipped",
      reason: "already-run",
    })
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

  it("throws it as a UsageError, so the CLI exits 2 and systemd stops retrying", () => {
    // Observed in production: a misconfigured RR_SEASON_ID exited 1, and
    // `Restart=on-failure` retried it 778 times. An unknown season is an
    // operator mistake whose condition never clears with time — the same
    // reason a refusal exits 0 — so it must not read as a retryable failure.
    // The unit pairs this with RestartPreventExitStatus=2.
    const d = seeded({ latestSavedDay: 0 })
    expect(() => runTick({ ...d, seasonId: "nope", now: at(1, 21, 30) })).toThrow(UsageError)
    d.store.close()
  })
})

describe("runTick — behaviour", () => {
  it("records the assembled orders and context alongside the state", () => {
    const d = seeded({ latestSavedDay: 4 })
    d.store.publishSlate("s1", 5, [market("KX-1", 5)], at(5, 8))
    d.store.saveOrder("s1", 5, "f1", { deploys: [], attacks: [], protect: null }, at(5, 9))
    d.store.saveWager("s1", 5, "f1", { marketId: "KX-1", side: "yes", stake: 3 }, at(5, 9))

    expect(runTick({ ...d, now: at(6, 0, 5) })).toMatchObject({ status: "resolved" })
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

    runTick({ store, seasonId: "s1", now: at(6, 0, 5) })
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
        now: at(6, 0, 5),
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
    const first = runTick({ ...d, now: at(6, 0, 5) })
    expect(first).toMatchObject({ status: "resolved" })

    let resolveCalls = 0
    const second = runTick({
      ...d,
      now: at(6, 0, 20),
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
    runTick({ ...d, now: at(6, 0, 5) })
    expect(
      d.store.saveOrder("s1", 5, "f1", { deploys: [], attacks: [], protect: null }, at(5, 20)),
    ).toEqual({ ok: false, reason: "already-resolved" })
    d.store.close()
  })

  it("advances the day and carries the previous state forward", () => {
    const d = seeded({ latestSavedDay: 4 })
    const out = runTick({ ...d, now: at(6, 0, 5) })
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
    const out = runTick({ ...d, now: at(6, 0, 5) })
    if (out.status !== "resolved") throw new Error("expected resolved")
    expect(d.store.loadTickContext("s1", 5)!.context.rules).toEqual(["boom"])
    expect(out.next.log.some((e) => e.t === "grant" && e.source === "boom")).toBe(true)
    d.store.close()
  })

  it("a day with offers but no votes freezes rules: [] and resolves normally", () => {
    const d = withOffer()
    const out = runTick({ ...d, now: at(6, 0, 5) })
    expect(out).toMatchObject({ status: "resolved", day: 5 })
    expect(d.store.loadTickContext("s1", 5)!.context.rules).toEqual([])
    d.store.close()
  })

  it("the delayed-tick regression: a post-boundary reaction is present but never counts", () => {
    // A tick delayed to 01:00. The reaction row is stored (its webhook landed
    // before the late tick's transaction), but reacted_at is 00:30 — past day
    // 5's midnight boundary. The explicit cutoff predicate excludes it end to
    // end, so a late tick cannot count votes cast after the day closed.
    const d = withOffer()
    d.store.recordRuleReaction({
      seasonId: "s1", day: 5, factionId: "f1", ordinal: 1, reactedAt: slackTs(at(6, 0, 30)),
    })
    const out = runTick({ ...d, now: at(6, 1, 0) })
    expect(out).toMatchObject({ status: "resolved", day: 5 })
    expect(d.store.loadTickContext("s1", 5)!.context.rules).toEqual([])
    d.store.close()
  })

  it("counts a vote cast in the hours the 21:00 cutoff used to throw away", () => {
    // The other half of the same move: 22:00 on day 5 is inside day 5 now, so
    // this vote counts. Under the old cutoff it was stored and discarded.
    const d = withOffer()
    d.store.recordRuleReaction({
      seasonId: "s1", day: 5, factionId: "f1", ordinal: 1, reactedAt: slackTs(at(5, 22, 0)),
    })
    const out = runTick({ ...d, now: at(6, 0, 5) })
    expect(out).toMatchObject({ status: "resolved", day: 5 })
    expect(d.store.loadTickContext("s1", 5)!.context.rules).not.toEqual([])
    d.store.close()
  })
})
