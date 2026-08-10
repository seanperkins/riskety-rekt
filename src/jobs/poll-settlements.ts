import { SETTLEMENT_HORIZON_DAYS } from "../config.js"
import type { MarketAdapter } from "../adapters/types.js"
import type { SlateStore, Transactional } from "../store/types.js"

export interface PollResult {
  checked: number
  recorded: number
  stillOpen: number
}

export interface PollDeps {
  store: SlateStore & Transactional
  adapter: MarketAdapter
  seasonId: string
  now: Date
  log?: (msg: string) => void
}

/**
 * The 30-minute job. Writes resolved outcomes to the database so the 21:00 tick
 * can read settlements locally and never touch the network.
 *
 * Never throws. A Kalshi outage leaves markets unsettled, the next run retries,
 * and a wager that stays unsettled for two ticks is refunded by the engine.
 * That chain is the whole reason the tick is allowed to be offline.
 */
export async function runPollSettlements(deps: PollDeps): Promise<PollResult> {
  const { store, adapter, seasonId, now } = deps
  const log = deps.log ?? (() => {})

  const ids = store.marketsAwaitingSettlement(seasonId, now, SETTLEMENT_HORIZON_DAYS)
  if (ids.length === 0) return { checked: 0, recorded: 0, stillOpen: 0 }

  let outcomes: Record<string, string>
  try {
    outcomes = await adapter.getSettlements(ids)
  } catch (err) {
    log(`settlement poll failed, ${ids.length} market(s) left unsettled: ${String(err)}`)
    return { checked: ids.length, recorded: 0, stillOpen: ids.length }
  }

  // One transaction, so the tick cannot observe a partial poll. Each
  // recordSettlement used to autocommit on its own, which meant a poll landing
  // while the tick read the settlements table could have some of a batch
  // visible and not the rest -- and tick_context then makes that torn snapshot
  // permanently authoritative for the day, including on every later replay.
  //
  // The network call is deliberately OUTSIDE: holding the write lock across an
  // HTTP request would let a slow Kalshi response block the 21:00 tick, which
  // is the exact coupling this job exists to prevent.
  const recorded = store.transaction(() => {
    let n = 0
    for (const id of ids) {
      const outcome = outcomes[id]
      if (outcome !== "yes" && outcome !== "no") continue
      if (store.recordSettlement(id, outcome, now)) n++
    }
    return n
  })

  log(`settlement poll: ${recorded} of ${ids.length} market(s) settled`)
  return { checked: ids.length, recorded, stillOpen: ids.length - recorded }
}
