import type {
  DailyContext,
  FactionId,
  GameMap,
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
  /**
   * Enabled module ids, copied into each day's frozen context by the tick.
   * Absent on write means the all-three default (the column's DEFAULT).
   */
  modules?: string[]
  /**
   * The deal's shuffle seed, recorded by insertSeason. Absent on rows written
   * before the deal existed. Read-only here — upsertSeason never writes it.
   * The rule-offer draw folds it into its own per-day seed.
   */
  seed?: number
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
  /**
   * The operator's mid-season module change, between ticks. Recorded in each
   * subsequent day's frozen context; never retroactive. The escrow gate lives
   * in the job (`runModulesSet`), not here — the store only writes.
   */
  setSeasonModules(seasonId: string, modules: string[]): void
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
  /**
   * Every market question published this season, by id — for the recap's
   * Markets section.
   *
   * Season-wide rather than per-day on purpose: a wager settles a tick after
   * it was placed, and a matured refund two ticks after, so a day-scoped read
   * would have to reconstruct that window and would still miss anything the
   * refund path surfaces late. One DISTINCT read cannot.
   */
  marketQuestions(seasonId: string): Record<string, string>

  /**
   * Refresh live prices. Latest observation wins, unlike settlements where the
   * first does — a price is a moving fact, an outcome is a final one.
   */
  recordPrices(markets: Market[], at: Date): void

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
  /** Absent in bodies saved before moves existed; read as empty. */
  moves?: { from: TerritoryId; to: TerritoryId; count: number }[]
  protect: TerritoryId | null
}

export type SaveRejection =
  | "day-out-of-range"
  | "past-deadline"
  | "already-resolved"
  | "market-locked"
  | "not-on-slate"
  | "bad-stake"
  | "markets-off"

export type SaveResult = { ok: true } | { ok: false; reason: SaveRejection }

export interface WagerRow {
  marketId: MarketId
  side: "yes" | "no"
  stake: number
  firstStakedAt: string
  /** The price for this side when the wager was placed, if it was recorded. */
  price?: number
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
  /**
   * One faction's saved plan for a day, or undefined if they have none.
   *
   * The web app reads this to show a player what they already submitted.
   * Deliberately single-faction: there is no method that hands a caller
   * everybody's plans except `assembleOrders`, which only the tick calls.
   */
  orderFor(seasonId: string, day: number, factionId: FactionId): OrderBody | undefined

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

/**
 * Login tokens and sessions.
 *
 * Both are keyed by the SHA-256 hash of the token; the raw value exists only in
 * the DM, the URL and the cookie. This layer never sees one.
 */
export interface AuthStore {
  /**
   * Add a live token for that Slack user, keeping the newest `MAX_LIVE_TOKENS`
   * and evicting the rest. Existing links keep working until they age out of
   * the cap or expire.
   */
  mintLoginToken(row: {
    slackUserId: string
    factionId: FactionId
    tokenHash: string
    expiresAt: Date
  }): void

  /**
   * Consume a login token and create a session, in ONE transaction.
   *
   * Returns the faction, or undefined if the token is unknown, expired or
   * already used. The delete and the insert commit together, so a link opened
   * twice yields exactly one session rather than two — or one session and a
   * dangling token.
   */
  consumeLoginToken(args: {
    tokenHash: string
    seasonId: string
    sessionHash: string
    sessionExpiresAt: Date
    now: Date
  }): FactionId | undefined

  /** The faction for a live session in this season, or undefined. */
  sessionFaction(tokenHash: string, seasonId: string, now: Date): FactionId | undefined

  /** Drop every session for a faction. Returns how many. */
  revokeSessions(factionId: FactionId): number
}

export type RecapKind = "original" | "correction" | "gap"

/**
 * Outbound-message idempotency. A lost acknowledgement must not post twice.
 *
 * `attempt` is in the key because a second correction for the same day is an
 * ordinary event — the first fix was wrong — and a `(season, day, kind)` key
 * would suppress it.
 */
export interface RecapLedger {
  /**
   * Claim the right to post. Returns false when this `(day, kind, attempt)` has
   * already been claimed, which is the signal to post nothing.
   *
   * The claim happens BEFORE the post, so a crash in between loses that recap
   * rather than duplicating it. That is the deliberate trade: a duplicate is
   * confusing and public, a miss is recoverable with `--force`.
   */
  claimRecap(seasonId: string, day: number, kind: RecapKind, attempt: number, at: Date): boolean
  /** Highest attempt recorded for this (day, kind), or 0 if there is none. */
  latestRecapAttempt(seasonId: string, day: number, kind: RecapKind): number
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

/**
 * Rewrites the frozen map inside a saved state. `states` is otherwise
 * INSERT-only (`saveState` runs once inside the tick's transaction); this is
 * the one path that overwrites a row already on disk, for a season whose map
 * was frozen before an adjacency fix landed. `updateStateMap` is the ONLY
 * updater of `states` — every other write to that table is an INSERT.
 */
export interface StateMapStore {
  /** Throws if no row exists for `seasonId`/`day`. */
  updateStateMap(seasonId: string, day: number, map: GameMap): void
}

/** One candidate in a day's rule-vote offer. */
export interface RuleOfferRow {
  ruleId: string
  ordinal: number
  seed: string
  /** NULL between the claim and the successful Slack post (claim-then-post). */
  messageTs: string | null
}

/** One still-present numeral reaction — the RAW record the tally derives from. */
export interface RuleReactionRow {
  factionId: FactionId
  ordinal: number
  /** ISO instant, via slackTsToIso at write. */
  reactedAt: string
}

/**
 * The daily rule vote's storage. Offers are claim-then-post (the recap
 * ledger's pattern); reactions are raw events, latest-wins per (faction,
 * ordinal), deleted on reaction_removed. The derived tally is never stored.
 */
export interface RuleVoteStore {
  /**
   * Claim the day's draw before posting. Throws on a rule id the catalogue
   * does not know — nothing arriving over the wire can name a rule.
   */
  claimRuleOffers(seasonId: string, day: number, ruleIds: string[], seed: string): void
  ruleOffersFor(seasonId: string, day: number): RuleOfferRow[]
  /** Record the posted Slack ts on every one of the day's offer rows. */
  recordOfferMessage(seasonId: string, day: number, messageTs: string): void
  /** The ingest's offer-message gate: which day does this ts vote on? */
  offerForMessage(
    messageTs: string,
  ): { seasonId: string; day: number; ordinals: number[] } | undefined
  recordRuleReaction(r: {
    seasonId: string
    day: number
    factionId: FactionId
    ordinal: number
    reactedAt: string
  }): void
  removeRuleReaction(seasonId: string, day: number, factionId: FactionId, ordinal: number): void
  ruleReactionsFor(seasonId: string, day: number): RuleReactionRow[]
}
