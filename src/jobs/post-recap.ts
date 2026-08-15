import type { GameState } from "../engine/index.js"
import type { Poster } from "../slack/post.js"
import { renderRecap } from "../slack/recap.js"
import type { RecapKind, RecapLedger } from "../store/types.js"

export type RecapResult =
  | { status: "posted"; attempt: number }
  | { status: "suppressed"; attempt: number }

export interface PostRecapDeps {
  poster: Poster
  /** The post-tick state, day N. */
  state: GameState
  /** Day N-1, for standings movement. */
  previous: GameState
  lengthDays: number
  /** A rerun. Marked visibly rather than posted as a silent second recap. */
  correction?: boolean
  /**
   * The idempotency ledger. Optional so the existing offline tests keep working
   * unchanged; when absent the recap always posts.
   */
  ledger?: RecapLedger
  seasonId?: string
  now?: Date
  /**
   * Post a NEW attempt even though one is recorded. The recovery path for the
   * ordinary failure — a Slack 5xx or a timeout leaves the ledger row present,
   * so a plain retry would see it and silently skip.
   */
  force?: boolean
  /** The day's winning rule ids, read from the frozen tick_context. */
  ruleIds?: string[]
  /**
   * Display names by faction id, from the roster.
   *
   * `RecapInput` has accepted these since the rename feature shipped and
   * nothing ever passed them, so every recap rendered the name frozen into the
   * state at the deal — the exact thing the field exists to prevent. The
   * Markets section made it visible by putting a name in every line.
   */
  names?: Record<string, string>
  /** Market question by id, for the Markets section. */
  marketTitles?: Record<string, string>
  log?: (msg: string) => void
}

/**
 * Post the day's recap.
 *
 * Deliberately separate from resolution, and never called by `resolve()`. The
 * tick saves state first and calls this afterwards, so a Slack outage cannot
 * stall or double-run a tick.
 *
 * The ledger row is claimed BEFORE the post. A crash in between therefore loses
 * that recap rather than duplicating it — the deliberate trade, since a
 * duplicate is confusing and public while a miss is recoverable with `--force`.
 */
export async function runPostRecap(deps: PostRecapDeps): Promise<RecapResult> {
  const log = deps.log ?? (() => {})
  const day = deps.state.day
  const kind: RecapKind = deps.correction === true ? "correction" : "original"

  // The default path must use a FIXED attempt number. "Skip when a row exists
  // for this (day, kind, attempt)" is trivially false for a fresh attempt, so
  // deriving it from max+1 here would make the suppression never fire.
  let attempt = 1
  if (deps.ledger !== undefined && deps.seasonId !== undefined) {
    if (deps.force === true) attempt = deps.ledger.latestRecapAttempt(deps.seasonId, day, kind) + 1
    const claimed = deps.ledger.claimRecap(
      deps.seasonId,
      day,
      kind,
      attempt,
      deps.now ?? new Date(),
    )
    if (!claimed) {
      log(`recap for day ${day} (${kind}, attempt ${attempt}) already recorded; not posting`)
      return { status: "suppressed", attempt }
    }
  }

  // Spread rather than `correction: deps.correction`: exactOptionalPropertyTypes
  // is on, so an explicit `undefined` is not the same as an absent key.
  const message = renderRecap({
    state: deps.state,
    previous: deps.previous,
    lengthDays: deps.lengthDays,
    ...(deps.correction === undefined ? {} : { correction: deps.correction }),
    ...(deps.ruleIds === undefined ? {} : { ruleIds: deps.ruleIds }),
    ...(deps.names === undefined ? {} : { names: deps.names }),
    ...(deps.marketTitles === undefined ? {} : { marketTitles: deps.marketTitles }),
  })
  await deps.poster.post(message)
  log(`recap posted for day ${day}`)
  return { status: "posted", attempt }
}
