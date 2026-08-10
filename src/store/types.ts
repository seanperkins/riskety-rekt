import type { FactionId, Market, MarketId, Settlement } from "../engine/index.js"

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
