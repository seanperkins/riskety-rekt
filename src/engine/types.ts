export const ENGINE_VERSION = "1.0.0"

export type FactionId = string
export type TerritoryId = string
export type ContinentId = string
export type MarketId = string

export type WagerSide = "yes" | "no"
export type Settlement = "yes" | "no" | "unsettled"

export interface Territory {
  id: TerritoryId
  name: string
  continent: ContinentId
  neighbors: TerritoryId[]
}

export interface Continent {
  id: ContinentId
  name: string
  bonus: number
}

export interface GameMap {
  territories: Territory[]
  continents: Continent[]
}

export interface Faction {
  id: FactionId
  playerName: string
  color: string
}

export interface PendingWager {
  wagerId: string
  factionId: FactionId
  marketId: MarketId
  side: WagerSide
  stake: number
  price: number
  placedOnDay: number
}

export interface Market {
  id: MarketId
  question: string
  priceYes: number
  priceNo: number
  closeTime: string
}

export interface ApprovedAction {
  eventId: string
  playerId: FactionId
  postedAt: string
  approvedAt: string
}

export interface DailyContext {
  slate: Market[]
  approvals: ApprovedAction[]
  /**
   * Faction ids that POSTED an action today, approved or not.
   *
   * Separate from `approvals` because the elimination veto gates on posting
   * while the +1 soldier gates on peer approval. Gating the veto on approval
   * would give living factions a reason to withhold the reaction from someone
   * whose veto they fear, which weaponizes the one mechanic the design insists
   * stays non-adversarial.
   *
   * Post times are deliberately absent: Early Bird keys on `postedAt` of an
   * approved action, so nothing needs a time here.
   */
  postedToday: FactionId[]
  settlements: Record<MarketId, Settlement>
}

export interface Deploy {
  territory: TerritoryId
  count: number
}

export interface Attack {
  from: TerritoryId
  to: TerritoryId
  count: number
}

export interface WagerOrder {
  marketId: MarketId
  side: WagerSide
  stake: number
}

export interface Order {
  factionId: FactionId
  deploys: Deploy[]
  attacks: Attack[]
  wagers: WagerOrder[]
  protect: TerritoryId | null
}

export type TickEvent =
  | { t: "income"; faction: FactionId; amount: number }
  | { t: "irl"; faction: FactionId; actions: number; bonus: number }
  | { t: "deploy"; faction: FactionId; territory: TerritoryId; count: number }
  | { t: "fieldBattle"; a: TerritoryId; b: TerritoryId; aContinues: number; bContinues: number }
  | { t: "protected"; territory: TerritoryId; byCount: number }
  | {
      t: "attack"
      from: TerritoryId
      to: TerritoryId
      attacker: FactionId
      committed: number
      survivors: number
      captured: boolean
    }
  | { t: "wagerSettle"; wagerId: string; outcome: Settlement; payout: number }
  | { t: "rejected"; faction: FactionId; field: string; reason: string }

export interface GameState {
  seasonId: string
  day: number
  map: GameMap
  factions: Faction[]
  ownership: Record<TerritoryId, FactionId>
  garrisons: Record<TerritoryId, number>
  reserves: Record<FactionId, number>
  pending: PendingWager[]
  log: TickEvent[]
  engineVersion: string
}
