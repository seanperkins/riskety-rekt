export const ENGINE_VERSION = "1.1.0"

export type FactionId = string
export type TerritoryId = string
export type RegionId = string
export type MarketId = string

export type WagerSide = "yes" | "no"
export type Settlement = "yes" | "no" | "unsettled"

export interface Territory {
  id: TerritoryId
  name: string
  region: RegionId
  neighbors: TerritoryId[]
}

export interface Region {
  id: RegionId
  name: string
  bonus: number
}

export interface GameMap {
  territories: Territory[]
  regions: Region[]
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
   * The tick's frozen ISO instant, supplied by the runner and recorded in
   * tick_context. The engine still contains no clock — time enters here.
   * Deploy claims lock at this instant; wager claims at their market's close,
   * which the slate publisher guarantees is strictly earlier.
   */
  tickInstant: string
  /** Enabled module ids, from the season row, frozen per day. */
  modules: string[]
  /** Day-scoped voted rules. Always [] until the rule-catalogue change. */
  rules: string[]
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

/**
 * A reinforcement between two OWNED, adjacent territories.
 *
 * Movers arrive BEFORE combat resolves, defend the destination that same
 * night, and can die doing it. That was a design choice, not an accident of
 * ordering: the alternative -- arrival after combat, as pure logistics -- was
 * considered and declined because "send help" is what a move means to the
 * person giving the order.
 *
 * Moves share the attacker's per-origin cap: attacks plus moves out of one
 * territory total at most its post-deploy garrison minus one.
 */
export interface Move {
  from: TerritoryId
  to: TerritoryId
  count: number
}

export interface WagerOrder {
  marketId: MarketId
  side: WagerSide
  stake: number
  /**
   * The price for this side at the moment the wager was PLACED.
   *
   * Absent means "use the slate's price", which is what every wager did before
   * prices moved during the day. Present is the fix for the stale-price
   * exploit: the published slate is frozen at 08:00, so a wager placed late
   * on a nearly-decided market used to pay at the morning's odds — roughly +94%
   * EV. Pricing at placement removes the free money without unfreezing the
   * slate, which exists so a rerun cannot re-snapshot the day.
   */
  price?: number
}

export interface Order {
  factionId: FactionId
  deploys: Deploy[]
  attacks: Attack[]
  /** Absent in orders saved before moves existed; treated as empty. */
  moves?: Move[]
  wagers: WagerOrder[]
  protect: TerritoryId | null
}

export type TickEvent =
  | { t: "income"; faction: FactionId; amount: number }
  | { t: "irl"; faction: FactionId; actions: number; bonus: number }
  /** A grant from a mechanic without its own variant (module or voted rule). */
  | { t: "grant"; source: string; faction: FactionId; amount: number }
  | { t: "deploy"; faction: FactionId; territory: TerritoryId; count: number }
  | { t: "move"; faction: FactionId; from: TerritoryId; to: TerritoryId; count: number }
  /**
   * aLost/bLost: each side's field-battle deaths. Exclusively here — a troop
   * that died in the field is never repeated in an attack event's `lost`.
   */
  | {
      t: "fieldBattle"
      a: TerritoryId
      b: TerritoryId
      aContinues: number
      bContinues: number
      aLost: number
      bLost: number
    }
  | { t: "protected"; territory: TerritoryId; byCount: number }
  /**
   * lost: this movement's share of its faction's TARGET-COMBAT casualties
   * (withdrawn survivors are alive, not lost; field-battle deaths are the
   * fieldBattle event's). defenderLost: the territory's defender losses,
   * logged ONCE per contested territory on the surviving arrival with the
   * lexicographically-first `from`, zero elsewhere — one event is pushed per
   * arriving movement, and repeating it would sum to legs x defense. fee:
   * the dial's departure cost; present even on a movement annihilated in a
   * field battle, whose event survives with zero strength so the fee stays
   * in the log.
   */
  | {
      t: "attack"
      from: TerritoryId
      to: TerritoryId
      attacker: FactionId
      committed: number
      survivors: number
      captured: boolean
      lost: number
      defenderLost: number
      fee?: number
    }
  /**
   * stake retained so settlement accounting can classify win/refund/loss;
   * faction and marketId so the recap can name WHO and WHICH MARKET without
   * parsing wagerId (`${day}-${factionId}-${seq}`) or reaching back into
   * moduleState. Three outcomes, not two: `outcome === "unsettled"` is a
   * matured refund with payout === stake, which reads exactly like a win if
   * classified on payout > 0 alone.
   *
   * **faction and marketId are OPTIONAL, and that is about persisted rows, not
   * about the engine.** `settleAll` always sets both; every event this engine
   * emits carries them. But states saved by engine 1.0.0 predate the fields,
   * `parseState` checks only the top level of a loaded state and never its log
   * elements, and `npm run recap -- <day>` renders a PERSISTED log. Declaring
   * them required made that a type-level lie about every pre-1.1.0 row in a
   * live database, and the recap crashed on `undefined.replace` -- reproduced,
   * see recap.test.ts. Optional here is what forces each reader to decide.
   */
  | {
      t: "wagerSettle"
      wagerId: string
      faction?: FactionId
      marketId?: MarketId
      outcome: Settlement
      payout: number
      stake: number
    }
  /** ref names the order item an allocation or lock drop rejected. */
  | { t: "rejected"; faction: FactionId; field: string; reason: string; ref?: string }

export interface GameState {
  seasonId: string
  day: number
  map: GameMap
  factions: Faction[]
  ownership: Record<TerritoryId, FactionId>
  garrisons: Record<TerritoryId, number>
  reserves: Record<FactionId, number>
  /**
   * Each module's cross-tick state under its own key; replaces `pending`.
   * Module code is the only code that interprets a value — including through
   * the module's exported helpers (marketIdsOf, pendingWagersOf).
   */
  moduleState: Record<string, unknown>
  log: TickEvent[]
  engineVersion: string
}
