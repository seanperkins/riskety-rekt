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

export type TickSkipReason = "before-season" | "after-season" | "already-run" | "before-cutoff"

/**
 * A discriminated union, because the recap is reachable ONLY on `"resolved"`.
 * An earlier draft called `postRecap(next, …)` unconditionally, where `next`
 * exists on that branch alone — so the losing side of a concurrent double-fire
 * would have posted a recap rendered from an undefined state.
 */
export type TickOutcome =
  | { status: "resolved"; day: number; next: GameState; previous: GameState }
  | { status: "skipped"; day: number; reason: TickSkipReason }
  | { status: "refused"; reason: "missing-days"; from: number; to: number }
  | { status: "refused"; reason: "no-deal" }

export interface TickDeps {
  store: SeasonStore & SlateStore & ApprovalStore & OrderStore & StateStore & Transactional
  seasonId: string
  /** Injected: the job holds no clock of its own, so tests can pin the day. */
  now: Date
  log?: (msg: string) => void
  /** Injected only so a throwing resolve is testable. Defaults to the engine. */
  resolve?: typeof resolveEngine
}

/**
 * The 21:00 tick.
 *
 * Claim, resolve and save are ONE transaction. That is not an optimization —
 * splitting them creates an ambiguity nothing can resolve: after a freeze,
 * "context for this day exists" means either *a previous attempt died* or
 * *another process is resolving right now*, and adopting on that signal lets
 * two concurrent runs both resolve, with one then dying on the `states`
 * primary key. `resolve` is pure and in-memory, so holding the write lock
 * across it costs microseconds.
 *
 * The network is never touched. Every input is a local table, written hours
 * earlier by the slate job, the settlement poller and the Slack webhook, so a
 * Kalshi or Slack outage at 20:59 cannot stall the season. `postRecap` is the
 * only outbound call and it happens after the commit, outside this function.
 */
export function runTick(deps: TickDeps): TickOutcome {
  const { store, seasonId, now } = deps
  const log = deps.log ?? (() => {})
  const resolve = deps.resolve ?? resolveEngine

  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`runTick: unknown season ${seasonId}`)

  // FIRST, before the day-clock table: latestSavedDay is undefined until this
  // passes. Defaulting it to 0 would let a season with a `seasons` row and an
  // empty `states` table sail through every guard at calendarDay = 1, open the
  // transaction, and fail loading states[0] -- a rollback and a stack trace
  // where a named refusal was intended. Dealing a board is an explicit act.
  const latestSavedDay = store.latestSavedDay(seasonId)
  if (latestSavedDay === undefined) return { status: "refused", reason: "no-deal" }

  const calendarDay = currentDay(season, now)

  // Row 1, and it MUST precede the after-season skip. A plainer
  // `latestSavedDay + 1 < calendarDay` placed after it swallows the most
  // expensive failure of the season: a missed day-14 tick noticed on day 15 has
  // calendarDay > lengthDays, so after-season fires first and the run exits 0
  // having done nothing. The winner is then read off the day-13 state, and
  // day-13 wagers never settle -- settleAll refunds only at a tick 15 that never
  // runs, so those stakes are confiscated and the tiebreak moves.
  //
  // The bound is min(calendarDay - 1, lengthDays) for the same reason: plain
  // calendarDay would keep refusing forever once the season ended.
  const owed = Math.min(calendarDay - 1, season.lengthDays)
  if (latestSavedDay < owed) {
    return { status: "refused", reason: "missing-days", from: latestSavedDay + 1, to: owed }
  }

  if (calendarDay < 1) return { status: "skipped", day: calendarDay, reason: "before-season" }
  if (calendarDay > season.lengthDays) {
    return { status: "skipped", day: calendarDay, reason: "after-season" }
  }
  // The sequential double-fire: fire, complete, fire again. A state-derived
  // guard is idempotent per GAME day, not per calendar day, so it would compute
  // N+1, find no state there, and resolve it as plain Risk with zero orders.
  if (latestSavedDay + 1 > calendarDay) {
    return { status: "skipped", day: calendarDay, reason: "already-run" }
  }

  // Separate from the day-clock table and easy to miss: without it a manual
  // `npm run tick` at 14:00 resolves the day while its markets are still open
  // and its approvals are still arriving.
  if (now.getTime() < tickInstant(season, calendarDay).getTime()) {
    return { status: "skipped", day: calendarDay, reason: "before-cutoff" }
  }

  const day = calendarDay
  const outcome = store.transaction((): TickOutcome => {
    // Belt-and-braces against sub-second skew between two processes reading the
    // same clock. The concurrent double-fire is closed by BEGIN IMMEDIATE: the
    // second process blocks, and when it proceeds it sees this row.
    if (store.stateExists(seasonId, day)) {
      return { status: "skipped", day, reason: "already-run" }
    }
    const previous = store.loadState(seasonId, day - 1)
    if (previous === undefined) {
      throw new Error(`runTick: season ${seasonId} has no state for day ${day - 1}`)
    }

    const orders = store.assembleOrders(seasonId, day)
    const slate = store.loadSlate(seasonId, day)
    const irl = dailyApprovals(store, seasonId, day)

    // The union of today's slate and every market with a pending wager. resolve
    // settles ALL matured pending wagers at step 1, including ones placed on
    // earlier days whose markets are not on today's slate, while
    // loadSettlements returns only the ids it is asked for -- so snapshotting
    // the slate alone would mark those unsettled and refund them.
    const ids = new Set<MarketId>(slate.map((m) => m.id))
    for (const id of marketIdsOf(previous)) ids.add(id)
    const settlements: Record<MarketId, Settlement> = store.loadSettlements([...ids].sort())

    const context: DailyContext = {
      slate,
      approvals: irl.approvals,
      postedToday: irl.postedToday,
      settlements,
      tickInstant: tickInstant(season, day).toISOString(),
      modules: [...DEFAULT_MODULES],
      rules: [],
    }

    const next = resolve(previous, orders, context)
    store.saveState(next, ENGINE_VERSION)
    // Same transaction as the state, because the context is not reconstructable
    // after the fact: posts.deleted is an untimestamped flag and removeApproval
    // hard-deletes its row, so a player deleting an old photo would
    // retroactively change postedToday on replay.
    store.saveTickContext(seasonId, day, orders, context, ENGINE_VERSION)
    return { status: "resolved", day, next, previous }
  })

  if (outcome.status === "resolved") {
    log(`day ${day} resolved: ${outcome.next.log.length} events`)
  }
  return outcome
}
