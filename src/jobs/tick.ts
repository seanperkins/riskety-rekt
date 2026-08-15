import { resolve as resolveEngine } from "../engine/index.js"
import { ENGINE_VERSION } from "../engine/index.js"
import { DEFAULT_MODULES, marketIdsOf } from "../engine/modules/index.js"
import type { DailyContext, GameState, MarketId, Settlement } from "../engine/index.js"
import { currentDay, tickInstant } from "../season.js"
import { UsageError } from "./flags.js"
import { dailyApprovals } from "../slack/approvals.js"
import { dailyRuleSelection } from "../slack/rule-vote.js"
import type {
  ApprovalStore,
  OrderStore,
  RuleVoteStore,
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
  store: SeasonStore &
    SlateStore &
    ApprovalStore &
    OrderStore &
    RuleVoteStore &
    StateStore &
    Transactional
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
  // A UsageError, not a plain Error: it exits 2, which the unit's
  // RestartPreventExitStatus=2 treats as final. A misconfigured RR_SEASON_ID
  // exiting 1 restart-looped this service 778 times in production — the same
  // hazard the exit-0 refusal contract exists to avoid, arriving by the door
  // marked "system failure worth a retry".
  if (season === undefined) throw new UsageError(`runTick: unknown season ${seasonId}`)

  // FIRST, before the day-clock table: latestSavedDay is undefined until this
  // passes. Defaulting it to 0 would let a season with a `seasons` row and an
  // empty `states` table sail through every guard at calendarDay = 1, open the
  // transaction, and fail loading states[0] -- a rollback and a stack trace
  // where a named refusal was intended. Dealing a board is an explicit act.
  const latestSavedDay = store.latestSavedDay(seasonId)
  if (latestSavedDay === undefined) return { status: "refused", reason: "no-deal" }

  const calendarDay = currentDay(season, now)

  // The tick fires AT the boundary that ends a day, so the day it resolves is
  // the one that just closed -- never the calendar day it wakes up in. At
  // 00:05 on `startDate + N + 1`, currentDay is already N+1 and the day owed a
  // resolution is N.
  //
  // This is inherent to the deadline and the rollover being one instant, not a
  // quirk of choosing midnight: at ANY aligned hour the job wakes up in the day
  // after the one it must resolve. Every guard below is therefore written
  // against `day`, and reading `calendarDay` in any of them is a bug.
  const day = calendarDay - 1

  // Row 1, and it MUST precede the after-season skip. A plainer
  // `latestSavedDay + 1 < day` placed after it swallows the most expensive
  // failure of the season: a missed day-14 tick noticed on day 15 has
  // day > lengthDays, so after-season fires first and the run exits 0 having
  // done nothing. The winner is then read off the day-13 state, and day-13
  // wagers never settle -- settleAll refunds only at a tick 15 that never runs,
  // so those stakes are confiscated and the tiebreak moves.
  //
  // The bound is min(day - 1, lengthDays) for the same reason: plain `day`
  // would keep refusing forever once the season ended.
  const owed = Math.min(day - 1, season.lengthDays)
  if (latestSavedDay < owed) {
    return { status: "refused", reason: "missing-days", from: latestSavedDay + 1, to: owed }
  }

  // day 0 is the deal and never ticks, so the first real resolution is day 1 --
  // at the midnight that ends it, when calendarDay has become 2.
  if (day < 1) return { status: "skipped", day, reason: "before-season" }
  // `day`, NOT calendarDay. The final tick resolves day `lengthDays` at a
  // moment when calendarDay is already lengthDays + 1, so a calendarDay test
  // here skips the last night of the season -- silently, and only on the one
  // day of the season when it matters.
  if (day > season.lengthDays) {
    return { status: "skipped", day, reason: "after-season" }
  }
  // The sequential double-fire: fire, complete, fire again. A state-derived
  // guard is idempotent per GAME day, not per calendar day, so it would compute
  // N+1, find no state there, and resolve it as plain Risk with zero orders.
  if (latestSavedDay + 1 > day) {
    return { status: "skipped", day, reason: "already-run" }
  }

  // Now unreachable, and kept anyway. `tickInstant(calendarDay - 1)` is
  // midnight at the START of calendarDay, so it is always already past -- the
  // derivation above enforces structurally what this used to enforce by clock
  // (a manual 14:00 run must not resolve a day whose markets are still open).
  // Every guard in this table has a season-breaking bug behind it; this is not
  // the one to delete because it currently looks redundant.
  if (now.getTime() < tickInstant(season, day).getTime()) {
    return { status: "skipped", day, reason: "before-cutoff" }
  }
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

    // The tally runs inside this transaction: it counts a reaction row only
    // if it is present when the transaction reads AND reacted_at <= the tick
    // instant — the explicit cutoff predicate, so a delayed tick cannot count
    // a post-21:00 vote. The winner freezes into ctx.rules, the durable
    // record of what won.
    const instant = tickInstant(season, day).toISOString()
    const context: DailyContext = {
      slate,
      approvals: irl.approvals,
      postedToday: irl.postedToday,
      settlements,
      tickInstant: instant,
      modules: season.modules ?? [...DEFAULT_MODULES],
      rules: dailyRuleSelection(store, seasonId, day, instant),
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
