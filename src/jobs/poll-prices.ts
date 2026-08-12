import { currentDay } from "../season.js"
import { UsageError } from "./flags.js"
import type { MarketAdapter } from "../adapters/types.js"
import type { SeasonStore, SlateStore, Transactional } from "../store/types.js"

export interface PricePollResult {
  day: number
  markets: number
  refreshed: number
}

export interface PricePollDeps {
  store: SlateStore & SeasonStore & Transactional
  adapter: MarketAdapter
  seasonId: string
  now: Date
  log?: (msg: string) => void
}

/**
 * The 30-minute price job.
 *
 * The published slate is frozen at 08:00 — `publishSlate` refuses a second
 * write precisely so a rerun cannot re-snapshot the day. That freeze is also
 * what created the stale-price exploit: a wager placed at 20:59 on a market
 * whose outcome was nearly public still paid at the morning's odds, worth
 * roughly +94% EV.
 *
 * So the odds move here instead, in their own table, and `saveWager` records
 * the price a wager was PLACED at. The slate stays the slate.
 *
 * Never throws. A Kalshi outage leaves prices where they were, which is the
 * old behaviour and merely stale — the tick still never touches the network.
 */
export async function runPollPrices(deps: PricePollDeps): Promise<PricePollResult> {
  const log = deps.log ?? (() => {})
  const season = deps.store.season(deps.seasonId)
  if (season === undefined) throw new UsageError(`pollPrices: unknown season ${deps.seasonId}`)

  const day = currentDay(season, deps.now)
  // Markets off: a deliberate zero-work skip — no slate exists to price.
  if (!(season.modules ?? ["markets"]).includes("markets")) {
    log("markets module is off; price poll skipped")
    return { day, markets: 0, refreshed: 0 }
  }
  const slate = deps.store.loadSlate(deps.seasonId, day)
  if (slate.length === 0) return { day, markets: 0, refreshed: 0 }

  let fresh
  try {
    // The window is today's slate's own close times, widened a little: the
    // adapter filters by close time, and a market closing in ten minutes is
    // exactly the one whose price has moved most.
    const closes = slate.map((m) => new Date(m.closeTime).getTime())
    fresh = await deps.adapter.getCandidates({
      opensAfter: new Date(Math.min(...closes) - 60 * 60 * 1000),
      closesBefore: new Date(Math.max(...closes) + 60 * 60 * 1000),
    })
  } catch (err) {
    log(`price poll failed, ${slate.length} market(s) left at their last price: ${String(err)}`)
    return { day, markets: slate.length, refreshed: 0 }
  }

  // Only today's slate. Every other market Kalshi returned is irrelevant, and
  // writing them would grow the table without bound.
  const wanted = new Set(slate.map((m) => m.id))
  const updates = fresh.filter((c) => wanted.has(c.id))
  deps.store.recordPrices(updates, deps.now)

  log(`price poll: refreshed ${updates.length} of ${slate.length} market(s) on day ${day}`)
  return { day, markets: slate.length, refreshed: updates.length }
}
