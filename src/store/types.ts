import type {
  DailyContext,
  FactionId,
  GameState,
  Market,
  MarketId,
  Order,
  Settlement,
  TerritoryId,
} from "../engine/index.js"

export interface SeasonRow {
  seasonId: string
  startDate: string
  lengthDays: number
}

/**
 * The slice of the spec's `Store` that Plan 2 needs. Plan 4 adds loadState /
 * saveState / loadOrders / saveOrder / claimTick against the same database.
 */
/**
 * Season rows. Split from `SlateStore` because `insertSeason` is a different
 * kind of operation: `upsertSeason` silently rewrites `start_date` and
 * `length_days` on conflict, and every day in this system is derived from
 * `start_date`, so an accidental second call would shift the calendar under a
 * live season and retroactively change which day every saved state belongs to.
 */
export interface SeasonStore {
  season(seasonId: string): SeasonRow | undefined
  upsertSeason(season: SeasonRow): void
  /** Insert-only, and records the shuffle seed. Throws if the season exists. */
  insertSeason(season: SeasonRow, seed: number): void
}

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

export interface RosterMember {
  slackUserId: string
  factionId: FactionId
  displayName: string
}

/**
 * The Slack roster. Seeded by `npm run roster:add`, read on every ingested
 * event so a player can be added mid-season without a service restart.
 */
export interface RosterStore {
  /** Idempotent on slackUserId; updates the display name. Throws if the faction is taken. */
  addRosterMember(member: RosterMember): void
  /** Every member, ordered by faction id. */
  roster(): RosterMember[]
  factionForSlackUser(slackUserId: string): FactionId | undefined
  slackUserForFaction(factionId: FactionId): string | undefined
}

export interface PostRow {
  messageTs: string
  factionId: FactionId
  postedAt: string
  etDate: string
}

export interface ApproverRow {
  factionId: FactionId
  reactedAt: string
}

/**
 * Raw Slack ingest. Every write is idempotent, because Slack redelivers.
 *
 * Approvals are NOT stored: an approved action is a property of a post plus two
 * distinct reactors, so it is derived at read time by `dailyApprovals`. Writing
 * derived rows would make `reaction_removed` a state machine.
 */
export interface ApprovalStore {
  /**
   * Record an event id. Returns false if it was already recorded, which means
   * this delivery is a Slack retry and must not be processed again.
   */
  markEventSeen(eventId: string, receivedAt: Date): boolean

  /** Idempotent. postedAt and etDate are derived from messageTs, never from a clock. */
  recordPost(post: { messageTs: string; factionId: FactionId }): void

  /** Hides a post from every query. A no-op if the post was never recorded. */
  deletePost(messageTs: string): void

  /** Idempotent per (post, approver). The first reaction's timestamp wins. */
  recordApproval(approval: { messageTs: string; factionId: FactionId; reactedAt: string }): void

  removeApproval(messageTs: string, factionId: FactionId): void

  /** Live posts on an ET calendar date, ordered by post time then message ts. */
  postsOn(etDate: string): PostRow[]

  /** A post by message ts, including a deleted one. Undefined if never recorded. */
  postFor(messageTs: string): PostRow | undefined

  /** Distinct approvers of a post, ordered by reaction time then faction id. */
  approversOf(messageTs: string): ApproverRow[]
}

/**
 * The single owner of `BEGIN IMMEDIATE`.
 *
 * SQLite has no nested transactions, so exactly one place opens them and every
 * other store method is statement-only. The public writers -- publishSlate,
 * saveOrder, saveWager, the tick, the rerun, season-init -- each wrap
 * themselves in one call. That is load-bearing rather than stylistic: if a
 * writer's gates and its write were separately committed, a tick could commit
 * between them, which is the race the design has no lock table to catch.
 *
 * One exemption, and only one: `migrate` in schema.ts. It runs against a
 * database whose schema predates this interface, before `openStore` has
 * returned anything to call `transaction` on, and each migration must commit
 * separately so a later failure does not roll back earlier ones.
 */
export interface Transactional {
  transaction<T>(fn: () => T): T
}

export interface WagerInput {
  marketId: MarketId
  side: "yes" | "no"
  stake: number
}

/** Deploys, attacks and protect. `factionId` is deliberately absent — the caller supplies it. */
export interface OrderBody {
  deploys: { territory: TerritoryId; count: number }[]
  attacks: { from: TerritoryId; to: TerritoryId; count: number }[]
  protect: TerritoryId | null
}

export type SaveRejection =
  | "day-out-of-range"
  | "past-deadline"
  | "already-resolved"
  | "market-locked"
  | "not-on-slate"
  | "bad-stake"

export type SaveResult = { ok: true } | { ok: false; reason: SaveRejection }

export interface WagerRow {
  marketId: MarketId
  side: "yes" | "no"
  stake: number
  firstStakedAt: string
}

/**
 * The two write paths. Each owns one transaction: their gates and their write
 * must be atomic, or a tick can commit between the check and the write.
 *
 * Rejections are returned rather than thrown — they are expected outcomes on a
 * normal evening, and the CLI needs to tell them apart from a system failure.
 */
export interface OrderStore {
  saveOrder(
    seasonId: string,
    day: number,
    factionId: FactionId,
    body: OrderBody,
    now: Date,
  ): SaveResult
  saveWager(
    seasonId: string,
    day: number,
    factionId: FactionId,
    wager: WagerInput,
    now: Date,
  ): SaveResult
  /** Test and assembly read path. Ordered by first_staked_at, then market_id. */
  wagersFor(seasonId: string, day: number, factionId: FactionId): WagerRow[]

  /**
   * The day's two order tables as the engine's `Order[]`, sorted by faction id.
   *
   * A faction that wagered but never submitted a body still gets an order: the
   * two CLI commands are independent, so wagering without deploying is ordinary,
   * and those wagers must not vanish.
   *
   * Callers must still pass the result through `validateOrder` before `escrow` —
   * `escrow` does an unchecked `byId.get(w.marketId)!` and is safe only because
   * validation has already filtered to today's slate. `tick:rerun` is a second
   * caller and must not bypass it.
   */
  assembleOrders(seasonId: string, day: number): Order[]
}

/** The frozen inputs of one resolved tick. Only `tick:rerun` reads them. */
export interface TickContextRow {
  orders: Order[]
  context: DailyContext
  engineVersion: string
}

/** State persistence. `saveState` is an INSERT — inside the tick's transaction it runs once. */
export interface StateStore {
  stateExists(seasonId: string, day: number): boolean
  saveState(state: GameState, engineVersion: string): void

  /**
   * Schema-checked, not trusted. The engine assumes nothing about its arguments
   * and re-validates, but a corrupt row must fail here naming the season and
   * day, rather than as an undefined lookup six steps into the pipeline.
   */
  loadState(seasonId: string, day: number): GameState | undefined

  /**
   * The highest day with a saved state, or `undefined` when the season has
   * none.
   *
   * `undefined` rather than 0 is load-bearing: the tick distinguishes "no board
   * was ever dealt" from "day 0 is dealt and waiting". Defaulting to 0 would let
   * a season with a `seasons` row and an empty `states` table pass every guard,
   * open the transaction, and fail loading `states[0]` — a rollback and a stack
   * trace where a named refusal was intended.
   */
  latestSavedDay(seasonId: string): number | undefined

  saveTickContext(
    seasonId: string,
    day: number,
    orders: Order[],
    context: DailyContext,
    engineVersion: string,
  ): void
  loadTickContext(seasonId: string, day: number): TickContextRow | undefined

  /**
   * Drop `day` and every day after it, states and frozen contexts together.
   * `tick:rerun` uses it to unwind a bad tick; a context left behind would
   * replay inputs whose state is gone.
   */
  deleteStatesFrom(seasonId: string, day: number): void
}
