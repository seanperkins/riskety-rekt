import type { Market, MarketId, Settlement } from "../engine/index.js"

/**
 * A slate-eligible market plus the two fields selection needs and the engine
 * does not: how much it has traded, and which series it belongs to.
 */
export interface Candidate extends Market {
  volume: number
  series: string
}

/**
 * The close-time window a candidate must fall inside. Passed in rather than
 * computed, so the adapter holds no clock and its tests pin time exactly.
 */
export interface CandidateWindow {
  opensAfter: Date
  closesBefore: Date
}

export interface MarketAdapter {
  getCandidates(window: CandidateWindow): Promise<Candidate[]>
  getSettlements(ids: MarketId[]): Promise<Record<MarketId, Settlement>>
}
