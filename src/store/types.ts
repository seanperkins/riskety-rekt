import type { Market, MarketId, Settlement } from "../engine/index.js"

export interface SeasonRow {
  seasonId: string
  startDate: string
  lengthDays: number
}

/**
 * The slice of the spec's `Store` that Plan 2 needs. Plan 4 adds loadState /
 * saveState / loadOrders / saveOrder / claimTick against the same database.
 */
export interface SlateStore {
  season(seasonId: string): SeasonRow | undefined
  upsertSeason(season: SeasonRow): void

  /**
   * Persist the day's slate. Returns false and writes nothing if a slate has
   * already been published for that day.
   *
   * Refusing the second write is the point: a rerun at 20:00 would otherwise
   * re-snapshot prices hours later, handing whoever triggered it a slate priced
   * on the afternoon's information.
   */
  publishSlate(seasonId: string, day: number, slate: Market[], publishedAt: Date): boolean
  slatePublished(seasonId: string, day: number): boolean
  loadSlate(seasonId: string, day: number): Market[]

  /** First observation wins. Returns false if an outcome was already recorded. */
  recordSettlement(marketId: MarketId, outcome: "yes" | "no", at: Date): boolean
  loadSettlements(marketIds: MarketId[]): Record<MarketId, Settlement>

  /**
   * Market ids on this season's slates that have closed, have no settlement
   * yet, and are recent enough to still matter to a live wager.
   */
  marketsAwaitingSettlement(seasonId: string, now: Date, horizonDays: number): MarketId[]

  close(): void
}
