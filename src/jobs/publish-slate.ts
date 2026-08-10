import { SLATE_MIN, WINDOW_CLOSE_HOUR, WINDOW_OPEN_HOUR } from "../config.js"
import { etDate, etDaysBetween, etInstant } from "../time.js"
import { selectSlate } from "../slate/select.js"
import type { Market } from "../engine/index.js"
import type { MarketAdapter } from "../adapters/types.js"
import type { SlateStore } from "../store/types.js"

export type SkipReason = "before-season" | "after-season" | "final-day" | "already-published"

export type PublishOutcome =
  | { status: "published"; day: number; count: number }
  | { status: "skipped"; day: number; reason: SkipReason }

export interface PublishDeps {
  store: SlateStore
  adapter: MarketAdapter
  seasonId: string
  /** Injected: the job holds no clock of its own, so tests can pin the day. */
  now: Date
  log?: (msg: string) => void
  /**
   * Optional so the job's existing tests stay offline and unchanged. Called
   * only after the slate is persisted: a Slack outage must never cost the day
   * its slate, and a slate announced but not stored would be a lie.
   */
  announce?: (day: number, slate: Market[]) => Promise<void>
}

/**
 * The 08:00 job. Fetch candidates closing today, pick the slate, snapshot its
 * prices, persist.
 *
 * On an adapter failure this throws and writes nothing. That is deliberate:
 * recording an empty slate would burn the day permanently, while throwing lets
 * a systemd retry a few minutes later still deliver a slate. An empty slate is
 * only ever written after a *successful* fetch that yielded no eligible market.
 */
export async function runPublishSlate(deps: PublishDeps): Promise<PublishOutcome> {
  const { store, adapter, seasonId, now } = deps
  const log = deps.log ?? (() => {})

  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`publishSlate: unknown season ${seasonId}`)

  const today = etDate(now)
  const day = etDaysBetween(season.startDate, today)

  if (day < 1) return { status: "skipped", day, reason: "before-season" }
  if (day > season.lengthDays) return { status: "skipped", day, reason: "after-season" }
  // Day-N wagers escrow at tick N and settle at tick N+1, so the final day's
  // would settle at a tick that never runs.
  if (day >= season.lengthDays) return { status: "skipped", day, reason: "final-day" }

  // Checked before fetching: a double-fired timer should neither spend a round
  // trip nor be in a position to see fresher prices.
  if (store.slatePublished(seasonId, day)) {
    return { status: "skipped", day, reason: "already-published" }
  }

  const window = {
    opensAfter: etInstant(today, WINDOW_OPEN_HOUR),
    closesBefore: etInstant(today, WINDOW_CLOSE_HOUR),
  }

  const candidates = await adapter.getCandidates(window)
  const slate = selectSlate(candidates)

  if (slate.length < SLATE_MIN) {
    log(
      `day ${day}: only ${slate.length} eligible market(s) from ${candidates.length} candidates` +
        ` (target ${SLATE_MIN})`,
    )
  }

  const written = store.publishSlate(seasonId, day, slate, now)
  if (!written) {
    // Lost a race with a concurrent run; the other run's slate stands.
    return { status: "skipped", day, reason: "already-published" }
  }

  log(`day ${day}: published ${slate.length} market(s): ${slate.map((m) => m.id).join(", ")}`)

  if (deps.announce !== undefined) {
    try {
      await deps.announce(day, slate)
    } catch (err) {
      // The slate is already persisted and the game is playable. A failed
      // announcement is worth a loud log, but not a throw: the retry it would
      // trigger can only hit already-published.
      log(`day ${day}: slate published but the Slack announcement failed: ${String(err)}`)
    }
  }

  return { status: "published", day, count: slate.length }
}
