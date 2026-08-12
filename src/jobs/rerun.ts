import { resolve as resolveEngine } from "../engine/index.js"
import { ENGINE_VERSION } from "../engine/index.js"
import { DEFAULT_MODULES, marketIdsOf } from "../engine/modules/index.js"
import type { DailyContext, GameState, MarketId, Settlement } from "../engine/index.js"
import { currentDay, tickInstant } from "../season.js"
import { dailyApprovals } from "../slack/approvals.js"
import type {
  ApprovalStore,
  OrderStore,
  SeasonStore,
  SlateStore,
  StateStore,
  Transactional,
} from "../store/types.js"

export type RerunRefusal =
  | { reason: "bad-day"; day: number; lengthDays: number }
  | { reason: "no-deal" }
  | { reason: "missing-context"; day: number }
  | { reason: "day-not-over"; day: number }

export type RerunOutcome =
  | { status: "replayed"; days: number[]; states: { day: number; next: GameState; previous: GameState }[] }
  | { status: "dry-run"; days: number[] }
  | { status: "refused"; refusal: RerunRefusal }

export interface RerunDeps {
  store: SeasonStore & SlateStore & ApprovalStore & OrderStore & StateStore & Transactional
  seasonId: string
  /** The first day to replay. */
  day: number
  now: Date
  /** Without it nothing is deleted and nothing is written. */
  confirm?: boolean
  /**
   * Assemble a fresh context for a day that has no recorded one — the
   * missed-day case, where no tick ever ran. Off by default: silently inventing
   * a context for a day the operator thought was recorded would replay live
   * settlements and live posts against orders written for a different night.
   */
  assembleMissing?: boolean
  log?: (msg: string) => void
  resolve?: typeof resolveEngine
}

/**
 * Replay days from `day` forward against their recorded inputs.
 *
 * The range is `day .. min(calendarDay - 1, lengthDays)` and it is a RANGE, not
 * a single day, because one failure produces a growing number of missing days:
 * a day-5 tick that dies leaves latestSaved = 4, so day 6 refuses too, and the
 * count grows nightly.
 *
 * The delete, every replayed state write and any `--assemble-missing` context
 * write are ONE transaction. Separately-committed deletes and replays let the
 * nightly tick interleave once the rerun has restored through `calendarDay - 1`,
 * producing a mixed live/recorded replay or a primary-key collision.
 *
 * Correction recaps are the caller's job, posted only after this commits.
 */
export function runRerun(deps: RerunDeps): RerunOutcome {
  const { store, seasonId, day, now } = deps
  const log = deps.log ?? (() => {})
  const resolve = deps.resolve ?? resolveEngine

  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`runRerun: unknown season ${seasonId}`)

  // Day 0 is the deal, not a tick. A negative day matters more than it looks:
  // `DELETE FROM states WHERE day >= -1` would take the deal with it.
  if (!Number.isSafeInteger(day) || day < 1 || day > season.lengthDays) {
    return { status: "refused", refusal: { reason: "bad-day", day, lengthDays: season.lengthDays } }
  }
  if (store.latestSavedDay(seasonId) === undefined) {
    return { status: "refused", refusal: { reason: "no-deal" } }
  }

  const last = Math.min(currentDay(season, now) - 1, season.lengthDays)
  const days: number[] = []
  for (let d = day; d <= last; d++) days.push(d)
  if (days.length === 0) {
    return { status: "refused", refusal: { reason: "day-not-over", day } }
  }

  // Every day in the range must have a context before anything is deleted, or a
  // partial rerun would delete states it cannot rebuild. --assemble-missing is
  // what waives this, and only for days whose 21:00 has passed -- which is what
  // `last` already guarantees, since it stops at calendarDay - 1.
  for (const d of days) {
    if (store.loadTickContext(seasonId, d) === undefined && deps.assembleMissing !== true) {
      return { status: "refused", refusal: { reason: "missing-context", day: d } }
    }
  }

  if (deps.confirm !== true) {
    log(`would replay day${days.length === 1 ? "" : "s"} ${days.join(", ")}; pass --confirm to act`)
    return { status: "dry-run", days }
  }

  return store.transaction((): RerunOutcome => {
    const previousStates = new Map<number, GameState>()
    const base = store.loadState(seasonId, day - 1)
    if (base === undefined) {
      throw new Error(`runRerun: no state for day ${day - 1} to replay from`)
    }
    previousStates.set(day - 1, base)

    // Read every recorded context into memory BEFORE the delete.
    // `deleteStatesFrom` drops states and tick_context together -- correct for
    // its own purpose, since a context whose state is gone would replay inputs
    // into nothing -- but it would take out the very contexts this replay is
    // about to read. Reading first, then writing each one back beside its new
    // state, keeps the two tables paired at every commit boundary.
    const recorded = new Map(days.map((d) => [d, store.loadTickContext(seasonId, d)]))
    store.deleteStatesFrom(seasonId, day)

    const states: { day: number; next: GameState; previous: GameState }[] = []
    for (const d of days) {
      const previous = previousStates.get(d - 1)!
      const frozen = recorded.get(d)

      let orders, context: DailyContext
      if (frozen === undefined) {
        // --assemble-missing: no tick ever ran for this day, so there is nothing
        // recorded to replay. The orders are real -- players wrote them -- but
        // the context is read live, which is the concession the flag names.
        orders = store.assembleOrders(seasonId, d)
        context = assembleContext(store, seasonId, d, previous)
        log(`day ${d}: no recorded context, assembled one from live tables`)
      } else {
        orders = frozen.orders
        context = frozen.context
        // Logged and proceeded, never refused. "Fix the code, then rerun" is
        // this command's documented purpose, so refusing on a version change
        // would block the exact case it exists for.
        if (frozen.engineVersion !== ENGINE_VERSION) {
          log(
            `day ${d}: recorded under engine ${frozen.engineVersion}, ` +
              `replaying under ${ENGINE_VERSION}`,
          )
        }
      }

      const next = resolve(previous, orders, context)
      store.saveState(next, ENGINE_VERSION)
      store.saveTickContext(seasonId, d, orders, context, ENGINE_VERSION)
      previousStates.set(d, next)
      states.push({ day: d, next, previous })
    }
    return { status: "replayed", days, states }
  })
}

/** The same context the tick builds, for a day that never had one recorded. */
function assembleContext(
  store: SlateStore & ApprovalStore & SeasonStore,
  seasonId: string,
  day: number,
  previous: GameState,
): DailyContext {
  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`assembleContext: unknown season ${seasonId}`)
  const slate = store.loadSlate(seasonId, day)
  const irl = dailyApprovals(store, seasonId, day)
  const ids = new Set<MarketId>(slate.map((m) => m.id))
  for (const id of marketIdsOf(previous)) ids.add(id)
  const settlements: Record<MarketId, Settlement> = store.loadSettlements([...ids].sort())
  return {
    slate,
    approvals: irl.approvals,
    postedToday: irl.postedToday,
    settlements,
    tickInstant: tickInstant(season, day).toISOString(),
    modules: [...DEFAULT_MODULES],
    rules: [],
  }
}
