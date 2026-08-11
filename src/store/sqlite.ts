import { createRequire } from "node:module"
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite"
import { MAX_LIVE_TOKENS } from "../auth/token.js"
import type { Market, MarketId, Settlement } from "../engine/index.js"

/**
 * Loaded through createRequire rather than a static import.
 *
 * Vite decides a specifier is a Node builtin with
 * `builtinModules.filter(id => !id.includes(":"))`, and Node lists this module
 * only as "node:sqlite" -- never bare "sqlite". Something upstream strips the
 * prefix before the check, so a static `import ... from "node:sqlite"` resolves
 * to "sqlite", matches nothing, and every test in this file fails to load.
 * A runtime require is opaque to the bundler and reaches Node unchanged.
 *
 * The `import type` above is erased at compile time, so this keeps full typing
 * without reintroducing the static specifier. Revisit when Vite handles the
 * prefixed-only builtins.
 */
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSyncCtor }
import { migrate } from "./schema.js"
import type {
  ApprovalStore,
  AuthStore,
  OrderBody,
  OrderStore,
  SaveResult,
  StateStore,
  TickContextRow,
  Transactional,
  WagerInput,
  WagerRow,
  ApproverRow,
  PostRow,
  RecapKind,
  RecapLedger,
  RosterMember,
  RosterStore,
  SeasonRow,
  SeasonStore,
  SlateStore,
} from "./types.js"
import { cmp } from "../engine/index.js"
import type { DailyContext, FactionId, GameState, Order } from "../engine/index.js"
import { tickInstant } from "../season.js"
import { etDate, slackTsToIso } from "../time.js"

/** SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999; stay well under it. */
const PARAM_CHUNK = 500

const isCount = (n: unknown): boolean => typeof n === "number" && Number.isSafeInteger(n) && n >= 0

/**
 * The `states.state` column, back into a `GameState`.
 *
 * Checks the top level only. `resolve` assumes nothing about its arguments and
 * re-validates everything it touches, so this exists for the error message: a
 * truncated or hand-edited row should fail at load naming the season and day,
 * not as an undefined lookup six steps into the pipeline.
 *
 * `reserves` is checked for non-negative integers because a negative one is the
 * exact thing the engine's closing invariant throws on -- catching it at load
 * says the row was already bad, rather than blaming the tick that read it.
 */
function parseState(json: string, seasonId: string, day: number): GameState {
  const bad = (why: string): never => {
    throw new Error(`states row for ${seasonId} day ${day} is not a GameState: ${why}`)
  }
  const raw: unknown = JSON.parse(json)
  if (typeof raw !== "object" || raw === null) return bad("not an object")
  const s = raw as GameState
  if (typeof s.seasonId !== "string") return bad("seasonId is not a string")
  if (!Number.isSafeInteger(s.day)) return bad("day is not an integer")
  if (!Array.isArray(s.map?.territories) || s.map.territories.length === 0) {
    return bad("map.territories is empty or absent")
  }
  if (!Array.isArray(s.map.regions)) return bad("map.regions is absent")
  if (!Array.isArray(s.factions)) return bad("factions is absent")
  for (const key of ["ownership", "garrisons", "reserves"] as const) {
    if (typeof s[key] !== "object" || s[key] === null) return bad(`${key} is absent`)
  }
  if (!Array.isArray(s.pending)) return bad("pending is absent")
  if (!Array.isArray(s.log)) return bad("log is absent")
  for (const [faction, reserve] of Object.entries(s.reserves)) {
    if (!isCount(reserve)) return bad(`reserve for ${faction} is ${String(reserve)}`)
  }
  return s
}

/**
 * The `orders.body` column, back into a typed body.
 *
 * The only writer is `saveOrder`, stringifying an `OrderBody`, so a row that
 * fails this check means the file was edited by hand. It throws rather than
 * coercing to an empty body: assembly runs inside the tick's transaction, so a
 * throw rolls the tick back and refuses loudly, where a coercion would resolve
 * the day having silently dropped a player's deploys and attacks.
 *
 * Element shapes are the engine's job -- `validateOrder` checks every count and
 * territory and publishes a named rejection for each. This only has to
 * guarantee the three fields are the right kind, so a bad row fails here with
 * the faction in the message instead of somewhere in the pipeline.
 */
function parseBody(json: string, factionId: string): OrderBody {
  const raw: unknown = JSON.parse(json)
  const body = raw as OrderBody
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray(body.deploys) ||
    !Array.isArray(body.attacks) ||
    !(body.moves === undefined || Array.isArray(body.moves)) ||
    !(body.protect === null || typeof body.protect === "string")
  ) {
    throw new Error(`orders row for ${factionId} is not an order body: ${json}`)
  }
  return body
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function openStore(
  path: string,
): SeasonStore &
  AuthStore &
  SlateStore &
  RecapLedger &
  RosterStore &
  ApprovalStore &
  OrderStore &
  StateStore &
  Transactional {
  const db = new DatabaseSync(path)
  // WAL lets the web app, the Slack bot and the timer share one file. The
  // likeliest thing to block the 21:00 tick is our own second process.
  db.exec("PRAGMA journal_mode = WAL")
  // The ONE layer of contention handling. Every transaction here opens with
  // BEGIN IMMEDIATE, which takes the write lock up front, and busy_timeout
  // applies to exactly that acquisition. The failure mode people reach for a
  // manual retry to cover -- SQLITE_BUSY_SNAPSHOT, where a deferred transaction
  // that has already read tries to upgrade and gets an immediate error that
  // busy_timeout does NOT cover -- cannot arise, because nothing here opens a
  // deferred transaction.
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
  migrate(db)

  let inTransaction = false

  const stateExistsRow = (seasonId: string, day: number): boolean =>
    db.prepare("SELECT 1 FROM states WHERE season_id = ? AND day = ?").get(seasonId, day) !==
    undefined

  const seasonRow = (seasonId: string): SeasonRow => {
    const row = db
      .prepare("SELECT season_id, start_date, length_days FROM seasons WHERE season_id = ?")
      .get(seasonId) as { season_id: string; start_date: string; length_days: number } | undefined
    if (row === undefined) throw new Error(`unknown season ${seasonId}`)
    return {
      seasonId: row.season_id,
      startDate: row.start_date,
      lengthDays: Number(row.length_days),
    }
  }

  /**
   * The three gates every order write shares, evaluated inside the caller's
   * transaction. A local closure, not a store method — nothing outside this
   * file should be able to check the gates without also doing the write.
   *
   * The clock is the deadline and the state row is the race guard: a submit at
   * 20:59:59.9 is legal by the clock and either commits before the tick's
   * transaction or waits behind it — and if it waits, it then sees the state row
   * rather than landing on a day that has already resolved.
   */
  const orderGate = (seasonId: string, day: number, now: Date): SaveResult => {
    const season = seasonRow(seasonId)
    if (!Number.isSafeInteger(day) || day < 1 || day > season.lengthDays) {
      return { ok: false, reason: "day-out-of-range" }
    }
    if (now.getTime() >= tickInstant(season, day).getTime()) {
      return { ok: false, reason: "past-deadline" }
    }
    if (stateExistsRow(seasonId, day)) return { ok: false, reason: "already-resolved" }
    return { ok: true }
  }

  return {
    season(seasonId: string): SeasonRow | undefined {
      const row = db
        .prepare("SELECT season_id, start_date, length_days FROM seasons WHERE season_id = ?")
        .get(seasonId) as
        | { season_id: string; start_date: string; length_days: number }
        | undefined
      if (row === undefined) return undefined
      return {
        seasonId: row.season_id,
        startDate: row.start_date,
        lengthDays: Number(row.length_days),
      }
    },

    insertSeason(season: SeasonRow, seed: number): void {
      // No ON CONFLICT clause. A second call must fail, not rewrite start_date
      // under a season whose every saved day is derived from it.
      db.prepare(
        `INSERT INTO seasons (season_id, start_date, length_days, seed) VALUES (?, ?, ?, ?)`,
      ).run(season.seasonId, season.startDate, season.lengthDays, seed)
    },

    upsertSeason(season: SeasonRow): void {
      db.prepare(
        `INSERT INTO seasons (season_id, start_date, length_days) VALUES (?, ?, ?)
         ON CONFLICT (season_id) DO UPDATE SET start_date = excluded.start_date,
                                               length_days = excluded.length_days`,
      ).run(season.seasonId, season.startDate, season.lengthDays)
    },

    publishSlate(seasonId: string, day: number, slate: Market[], publishedAt: Date): boolean {
      // Goes through `transaction` like every other public writer. It used to
      // open its own BEGIN IMMEDIATE without touching the nesting flag, which
      // made the "single owner of BEGIN" rule in types.ts false and left the
      // nesting guard blind to it: composing it under a transaction raised
      // SQLite's "cannot start a transaction within a transaction" from
      // whatever statement happened to run next. Composing it is still an
      // error -- public writers own their transaction and do not nest -- but it
      // is now this file's error, raised at the BEGIN, naming the cause.
      //
      // Returning false now commits an empty transaction rather than rolling
      // back. Same outcome: nothing was written on that path.
      return this.transaction(() => {
        // The publication row is the lock. Inserting it first means a second
        // caller collides on the primary key before writing a single market.
        const existing = db
          .prepare("SELECT 1 FROM slate_publications WHERE season_id = ? AND day = ?")
          .get(seasonId, day)
        if (existing !== undefined) return false

        db.prepare(
          `INSERT INTO slate_publications (season_id, day, published_at, market_count)
           VALUES (?, ?, ?, ?)`,
        ).run(seasonId, day, publishedAt.toISOString(), slate.length)

        const insert = db.prepare(
          `INSERT INTO slate_markets
             (season_id, day, market_id, question, price_yes, price_no, close_time)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const m of slate) {
          insert.run(seasonId, day, m.id, m.question, m.priceYes, m.priceNo, m.closeTime)
        }
        return true
      })
    },

    slatePublished(seasonId: string, day: number): boolean {
      return (
        db
          .prepare("SELECT 1 FROM slate_publications WHERE season_id = ? AND day = ?")
          .get(seasonId, day) !== undefined
      )
    },

    loadSlate(seasonId: string, day: number): Market[] {
      const rows = db
        .prepare(
          `SELECT market_id, question, price_yes, price_no, close_time
             FROM slate_markets WHERE season_id = ? AND day = ?
            ORDER BY market_id`,
        )
        .all(seasonId, day) as {
        market_id: string
        question: string
        price_yes: number
        price_no: number
        close_time: string
      }[]
      return rows.map((r) => ({
        id: r.market_id,
        question: r.question,
        priceYes: r.price_yes,
        priceNo: r.price_no,
        closeTime: r.close_time,
      }))
    },

    recordPrices(markets: Market[], at: Date): void {
      // Upsert: the LATEST price wins. Settlements are the opposite -- first
      // observation wins there, because an outcome is final and a price is not.
      const stmt = db.prepare(
        `INSERT INTO market_prices (market_id, price_yes, price_no, observed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (market_id) DO UPDATE SET price_yes = excluded.price_yes,
                                               price_no  = excluded.price_no,
                                               observed_at = excluded.observed_at`,
      )
      this.transaction(() => {
        for (const m of markets) stmt.run(m.id, m.priceYes, m.priceNo, at.toISOString())
      })
    },

    recordSettlement(marketId: MarketId, outcome: "yes" | "no", at: Date): boolean {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO settlements (market_id, outcome, observed_at) VALUES (?, ?, ?)`,
        )
        .run(marketId, outcome, at.toISOString())
      return Number(res.changes) > 0
    },

    loadSettlements(marketIds: MarketId[]): Record<MarketId, Settlement> {
      const out: Record<MarketId, Settlement> = {}
      for (const id of [...marketIds].sort()) out[id] = "unsettled"
      for (const batch of chunk([...marketIds].sort(), PARAM_CHUNK)) {
        if (batch.length === 0) continue
        const holes = batch.map(() => "?").join(",")
        const rows = db
          .prepare(`SELECT market_id, outcome FROM settlements WHERE market_id IN (${holes})`)
          .all(...batch) as { market_id: string; outcome: string }[]
        for (const r of rows) {
          if (r.outcome === "yes" || r.outcome === "no") out[r.market_id] = r.outcome
        }
      }
      return out
    },

    marketsAwaitingSettlement(seasonId: string, now: Date, horizonDays: number): MarketId[] {
      const cutoff = new Date(now.getTime() - horizonDays * 86_400_000).toISOString()
      const rows = db
        .prepare(
          `SELECT DISTINCT sm.market_id
             FROM slate_markets sm
             LEFT JOIN settlements s ON s.market_id = sm.market_id
            WHERE sm.season_id = ?
              AND sm.close_time <= ?
              AND sm.close_time >= ?
              AND s.market_id IS NULL
            ORDER BY sm.market_id`,
        )
        .all(seasonId, now.toISOString(), cutoff) as { market_id: string }[]
      return rows.map((r) => r.market_id)
    },

    addRosterMember(member: RosterMember): void {
      db.prepare(
        `INSERT INTO roster (slack_user_id, faction_id, display_name) VALUES (?, ?, ?)
         ON CONFLICT (slack_user_id) DO UPDATE SET display_name = excluded.display_name,
                                                   faction_id   = excluded.faction_id`,
      ).run(member.slackUserId, member.factionId, member.displayName)
    },

    roster(): RosterMember[] {
      const rows = db
        .prepare("SELECT slack_user_id, faction_id, display_name FROM roster ORDER BY faction_id")
        .all() as { slack_user_id: string; faction_id: string; display_name: string }[]
      return rows.map((r) => ({
        slackUserId: r.slack_user_id,
        factionId: r.faction_id,
        displayName: r.display_name,
      }))
    },

    factionForSlackUser(slackUserId: string): FactionId | undefined {
      const row = db
        .prepare("SELECT faction_id FROM roster WHERE slack_user_id = ?")
        .get(slackUserId) as { faction_id: string } | undefined
      return row?.faction_id
    },

    slackUserForFaction(factionId: FactionId): string | undefined {
      const row = db
        .prepare("SELECT slack_user_id FROM roster WHERE faction_id = ?")
        .get(factionId) as { slack_user_id: string } | undefined
      return row?.slack_user_id
    },

    markEventSeen(eventId: string, receivedAt: Date): boolean {
      const res = db
        .prepare("INSERT OR IGNORE INTO slack_events (event_id, received_at) VALUES (?, ?)")
        .run(eventId, receivedAt.toISOString())
      return Number(res.changes) > 0
    },

    recordPost(post: { messageTs: string; factionId: FactionId }): void {
      // Both derived from the Slack ts, never from the write time: a post at
      // 20:59:59 delivered at 21:00:01 still belongs to that day.
      const postedAt = slackTsToIso(post.messageTs)
      db.prepare(
        `INSERT INTO posts (message_ts, faction_id, posted_at, et_date, deleted)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (message_ts) DO NOTHING`,
      ).run(post.messageTs, post.factionId, postedAt, etDate(new Date(postedAt)))
    },

    deletePost(messageTs: string): void {
      db.prepare("UPDATE posts SET deleted = 1 WHERE message_ts = ?").run(messageTs)
    },

    recordApproval(a: { messageTs: string; factionId: FactionId; reactedAt: string }): void {
      // OR IGNORE, not an upsert: the first reaction's timestamp is the one
      // that counts, because approvedAt is defined as the second distinct
      // approver's reaction and a re-reaction must not move it later.
      //
      // Stored as an ISO instant so it is directly comparable with the 21:00
      // cutoff. A raw Slack ts and an ISO string compare as strings and would
      // put every reaction on the wrong side of the cutoff, silently.
      db.prepare(
        `INSERT OR IGNORE INTO reactions (message_ts, faction_id, reacted_at) VALUES (?, ?, ?)`,
      ).run(a.messageTs, a.factionId, slackTsToIso(a.reactedAt))
    },

    removeApproval(messageTs: string, factionId: FactionId): void {
      db.prepare("DELETE FROM reactions WHERE message_ts = ? AND faction_id = ?").run(
        messageTs,
        factionId,
      )
    },

    postsOn(date: string): PostRow[] {
      const rows = db
        .prepare(
          `SELECT message_ts, faction_id, posted_at, et_date
             FROM posts WHERE et_date = ? AND deleted = 0
            ORDER BY posted_at, message_ts`,
        )
        .all(date) as {
        message_ts: string
        faction_id: string
        posted_at: string
        et_date: string
      }[]
      return rows.map((r) => ({
        messageTs: r.message_ts,
        factionId: r.faction_id,
        postedAt: r.posted_at,
        etDate: r.et_date,
      }))
    },

    postFor(messageTs: string): PostRow | undefined {
      const r = db
        .prepare(
          "SELECT message_ts, faction_id, posted_at, et_date FROM posts WHERE message_ts = ?",
        )
        .get(messageTs) as
        | { message_ts: string; faction_id: string; posted_at: string; et_date: string }
        | undefined
      if (r === undefined) return undefined
      return {
        messageTs: r.message_ts,
        factionId: r.faction_id,
        postedAt: r.posted_at,
        etDate: r.et_date,
      }
    },

    approversOf(messageTs: string): ApproverRow[] {
      const rows = db
        .prepare(
          `SELECT faction_id, reacted_at FROM reactions WHERE message_ts = ?
            ORDER BY reacted_at, faction_id`,
        )
        .all(messageTs) as { faction_id: string; reacted_at: string }[]
      return rows.map((r) => ({ factionId: r.faction_id, reactedAt: r.reacted_at }))
    },

    /**
     * The only BEGIN in this file. Every other method is statement-only and
     * composes inside this one -- that is what makes the nesting guard below
     * meaningful rather than decorative.
     *
     * There is deliberately no retry loop. An earlier one matched
     * `/SQLITE_BUSY/` against `String(err)`, but node:sqlite renders a lock
     * collision as `Error: database is locked` with the code on `err.errcode`
     * (5), so the branch never once fired -- it was 750ms of backoff that could
     * not be reached, plus a SharedArrayBuffer that existed only to sleep for
     * it. busy_timeout already waits 5s for the write lock; a collision that
     * outlives that is a stuck writer, not a transient one.
     */
    transaction<T>(fn: () => T): T {
      if (inTransaction) throw new Error("transaction: cannot nest transactions")
      db.exec("BEGIN IMMEDIATE")
      inTransaction = true
      try {
        const out = fn()
        db.exec("COMMIT")
        return out
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      } finally {
        // Released on every path, or one failed tick would leave the store
        // permanently unable to open another transaction.
        inTransaction = false
      }
    },

    saveOrder(
      seasonId: string,
      day: number,
      factionId: FactionId,
      body: OrderBody,
      now: Date,
    ): SaveResult {
      return this.transaction((): SaveResult => {
        const gate = orderGate(seasonId, day, now)
        if (!gate.ok) return gate
        db.prepare(
          `INSERT INTO orders (season_id, day, faction_id, body, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (season_id, day, faction_id)
             DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
        ).run(seasonId, day, factionId, JSON.stringify(body), now.toISOString())
        return { ok: true }
      })
    },

    saveWager(
      seasonId: string,
      day: number,
      factionId: FactionId,
      wager: WagerInput,
      now: Date,
    ): SaveResult {
      return this.transaction((): SaveResult => {
        const gate = orderGate(seasonId, day, now)
        if (!gate.ok) return gate
        if (!Number.isSafeInteger(wager.stake) || wager.stake <= 0) {
          return { ok: false, reason: "bad-stake" }
        }

        const onSlate = db
          .prepare(
            `SELECT 1 FROM slate_markets
              WHERE season_id = ? AND day = ? AND market_id = ?`,
          )
          .get(seasonId, day, wager.marketId)
        if (onSlate === undefined) return { ok: false, reason: "not-on-slate" }

        // COALESCE is load-bearing. An unsettled market has no settlements row,
        // so observed_at is NULL, and SQLite's min() returns NULL if ANY
        // argument is NULL -- a bare MIN(close_time, observed_at) > now would
        // evaluate NULL for the common case and read a closed market as open.
        const stillOpen = db
          .prepare(
            `SELECT 1
               FROM slate_markets sm
               LEFT JOIN settlements s ON s.market_id = sm.market_id
              WHERE sm.season_id = ? AND sm.day = ? AND sm.market_id = ?
                AND COALESCE(MIN(sm.close_time, s.observed_at), sm.close_time) > ?`,
          )
          .get(seasonId, day, wager.marketId, now.toISOString())
        if (stillOpen === undefined) return { ok: false, reason: "market-locked" }

        // The price at the moment of placing, which is the whole fix for the
        // stale-price exploit. Live price if the poller has one, otherwise the
        // slate's 08:00 snapshot -- which is what every wager used before.
        const priceRow = db
          .prepare(
            `SELECT COALESCE(p.price_yes, sm.price_yes) AS yes,
                    COALESCE(p.price_no,  sm.price_no)  AS no
               FROM slate_markets sm
               LEFT JOIN market_prices p ON p.market_id = sm.market_id
              WHERE sm.season_id = ? AND sm.day = ? AND sm.market_id = ?`,
          )
          .get(seasonId, day, wager.marketId) as { yes: number; no: number } | undefined
        const price = wager.side === "yes" ? priceRow?.yes : priceRow?.no

        // first_staked_at is deliberately absent from the DO UPDATE list: it
        // anchors the ordering of the sequential-greedy reserve check, and
        // letting a re-stake move it would hand the player that lever.
        db.prepare(
          `INSERT INTO order_wagers
             (season_id, day, faction_id, market_id, side, stake, first_staked_at, price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (season_id, day, faction_id, market_id)
             DO UPDATE SET side = excluded.side, stake = excluded.stake,
                           -- Re-staking re-prices. Keeping the original price
                           -- would let a player lock in the morning's odds and
                           -- then change sides once the outcome was clear.
                           price = excluded.price`,
        ).run(
          seasonId,
          day,
          factionId,
          wager.marketId,
          wager.side,
          wager.stake,
          now.toISOString(),
          price ?? null,
        )
        return { ok: true }
      })
    },

    orderFor(seasonId: string, day: number, factionId: FactionId): OrderBody | undefined {
      const row = db
        .prepare("SELECT body FROM orders WHERE season_id = ? AND day = ? AND faction_id = ?")
        .get(seasonId, day, factionId) as { body: string } | undefined
      return row === undefined ? undefined : parseBody(row.body, factionId)
    },

    wagersFor(seasonId: string, day: number, factionId: FactionId): WagerRow[] {
      const rows = db
        .prepare(
          `SELECT market_id, side, stake, first_staked_at, price
             FROM order_wagers
            WHERE season_id = ? AND day = ? AND faction_id = ?
            ORDER BY first_staked_at, market_id`,
        )
        .all(seasonId, day, factionId) as {
        market_id: string
        side: string
        stake: number
        first_staked_at: string
        price: number | null
      }[]
      return rows.map((r) => ({
        marketId: r.market_id,
        side: r.side === "no" ? "no" : "yes",
        stake: Number(r.stake),
        firstStakedAt: r.first_staked_at,
        ...(r.price === null ? {} : { price: Number(r.price) }),
      }))
    },

    assembleOrders(seasonId: string, day: number): Order[] {
      // Two queries merged in TypeScript rather than one FULL OUTER JOIN: SQLite
      // gained that only in 3.39, and the version here is whatever Node was
      // built against.
      const bodies = db
        .prepare(`SELECT faction_id, body FROM orders WHERE season_id = ? AND day = ?`)
        .all(seasonId, day) as { faction_id: string; body: string }[]

      // The stake filter repeats the column CHECK from migration 3, so it is
      // unreachable today -- kept because this is the last gate before a pure
      // engine whose only response to a bad stake is a public rejection in the
      // recap, naming the faction and the market.
      //
      // ORDER BY first_staked_at, market_id is not cosmetic: the engine's
      // reserve check drops wagers sequentially, so this decides which bet
      // survives a short reserve.
      const wagers = db
        .prepare(
          `SELECT faction_id, market_id, side, stake, price
             FROM order_wagers
            WHERE season_id = ? AND day = ?
              AND stake > 0 AND typeof(stake) = 'integer'
            ORDER BY first_staked_at, market_id`,
        )
        .all(seasonId, day) as {
        faction_id: string
        market_id: string
        side: string
        stake: number
        price: number | null
      }[]

      const byFaction = new Map<FactionId, Order>()
      const orderFor = (factionId: FactionId): Order => {
        let order = byFaction.get(factionId)
        if (order === undefined) {
          // Every field present, so a faction that only wagered still produces a
          // complete Order. The engine iterates deploys, attacks and wagers
          // unconditionally.
          order = { factionId, deploys: [], attacks: [], wagers: [], protect: null }
          byFaction.set(factionId, order)
        }
        return order
      }

      for (const row of bodies) {
        const body = parseBody(row.body, row.faction_id)
        const order = orderFor(row.faction_id)
        order.deploys = body.deploys
        order.attacks = body.attacks
        if (body.moves !== undefined) order.moves = body.moves
        order.protect = body.protect
      }
      for (const row of wagers) {
        orderFor(row.faction_id).wagers.push({
          marketId: row.market_id,
          side: row.side === "no" ? "no" : "yes",
          stake: Number(row.stake),
          // Absent rather than null: exactOptionalPropertyTypes, and the engine
          // falls back to the slate price when there is none.
          ...(row.price === null ? {} : { price: Number(row.price) }),
        })
      }

      return [...byFaction.values()].sort((a, b) => cmp(a.factionId, b.factionId))
    },

    stateExists(seasonId: string, day: number): boolean {
      return stateExistsRow(seasonId, day)
    },

    /**
     * INSERT, never upsert: inside the tick's transaction it can run only once,
     * so a second call means two ticks raced onto one day. The loser must fail
     * and roll back rather than overwrite a resolved board.
     */
    saveState(state: GameState, engineVersion: string): void {
      db.prepare(
        `INSERT INTO states (season_id, day, state, engine_version) VALUES (?, ?, ?, ?)`,
      ).run(state.seasonId, state.day, JSON.stringify(state), engineVersion)
    },

    loadState(seasonId: string, day: number): GameState | undefined {
      const row = db
        .prepare("SELECT state FROM states WHERE season_id = ? AND day = ?")
        .get(seasonId, day) as { state: string } | undefined
      if (row === undefined) return undefined
      return parseState(row.state, seasonId, day)
    },

    latestSavedDay(seasonId: string): number | undefined {
      // MAX over an empty set is a row holding NULL, not an empty result -- so
      // the undefined that distinguishes "never dealt" from "day 0 dealt" has to
      // come from the NULL check, not from a missing row.
      const row = db
        .prepare("SELECT MAX(day) AS day FROM states WHERE season_id = ?")
        .get(seasonId) as { day: number | null } | undefined
      if (row?.day === null || row?.day === undefined) return undefined
      return Number(row.day)
    },

    saveTickContext(
      seasonId: string,
      day: number,
      orders: Order[],
      context: DailyContext,
      engineVersion: string,
    ): void {
      db.prepare(
        `INSERT INTO tick_context (season_id, day, orders, context, engine_version)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(seasonId, day, JSON.stringify(orders), JSON.stringify(context), engineVersion)
    },

    loadTickContext(seasonId: string, day: number): TickContextRow | undefined {
      const row = db
        .prepare(
          "SELECT orders, context, engine_version FROM tick_context WHERE season_id = ? AND day = ?",
        )
        .get(seasonId, day) as
        | { orders: string; context: string; engine_version: string }
        | undefined
      if (row === undefined) return undefined
      return {
        orders: JSON.parse(row.orders) as Order[],
        context: JSON.parse(row.context) as DailyContext,
        engineVersion: row.engine_version,
      }
    },

    claimRecap(
      seasonId: string,
      day: number,
      kind: RecapKind,
      attempt: number,
      at: Date,
    ): boolean {
      // INSERT OR IGNORE, so the claim is the primary key. Two processes racing
      // to post the same recap: one inserts, the other sees changes = 0.
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO recaps (season_id, day, kind, attempt, posted_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(seasonId, day, kind, attempt, at.toISOString())
      return Number(res.changes) > 0
    },

    latestRecapAttempt(seasonId: string, day: number, kind: RecapKind): number {
      const row = db
        .prepare(
          `SELECT MAX(attempt) AS attempt FROM recaps
            WHERE season_id = ? AND day = ? AND kind = ?`,
        )
        .get(seasonId, day, kind) as { attempt: number | null } | undefined
      return row?.attempt == null ? 0 : Number(row.attempt)
    },

    deleteStatesFrom(seasonId: string, day: number): void {
      // Both tables, or a rerun of `day` would replay frozen inputs whose state
      // no longer exists.
      db.prepare("DELETE FROM states WHERE season_id = ? AND day >= ?").run(seasonId, day)
      db.prepare("DELETE FROM tick_context WHERE season_id = ? AND day >= ?").run(seasonId, day)
    },

    mintLoginToken(row: {
      slackUserId: string
      factionId: FactionId
      tokenHash: string
      expiresAt: Date
    }): void {
      // Insert, then evict everything past the newest MAX_LIVE_TOKENS. One
      // transaction, so a reader never sees a user over the cap.
      //
      // Recency is `rowid`, not `expires_at`. The TTL is a constant, so two
      // links minted in the same millisecond carry the same expiry and there is
      // no tie-break; rowid is the insertion sequence. SQLite assigns a new row
      // max(rowid)+1 over the rows still present, so the newest row always
      // sorts highest even after deletes recycle a value.
      this.transaction(() => {
        db.prepare(
          `INSERT INTO login_tokens (token_hash, slack_user_id, faction_id, expires_at)
           VALUES (?, ?, ?, ?)`,
        ).run(row.tokenHash, row.slackUserId, row.factionId, row.expiresAt.toISOString())
        db.prepare(
          `DELETE FROM login_tokens
            WHERE slack_user_id = ?
              AND rowid NOT IN (
                SELECT rowid FROM login_tokens
                 WHERE slack_user_id = ?
                 ORDER BY rowid DESC
                 LIMIT ?)`,
        ).run(row.slackUserId, row.slackUserId, MAX_LIVE_TOKENS)
      })
    },

    consumeLoginToken(args: {
      tokenHash: string
      seasonId: string
      sessionHash: string
      sessionExpiresAt: Date
      now: Date
    }): FactionId | undefined {
      return this.transaction((): FactionId | undefined => {
        const row = db
          .prepare("SELECT faction_id FROM login_tokens WHERE token_hash = ? AND expires_at > ?")
          .get(args.tokenHash, args.now.toISOString()) as { faction_id: string } | undefined
        if (row === undefined) return undefined

        db.prepare("DELETE FROM login_tokens WHERE token_hash = ?").run(args.tokenHash)
        db.prepare(
          `INSERT INTO sessions (token_hash, faction_id, season_id, expires_at)
           VALUES (?, ?, ?, ?)`,
        ).run(args.sessionHash, row.faction_id, args.seasonId, args.sessionExpiresAt.toISOString())
        return row.faction_id
      })
    },

    sessionFaction(tokenHash: string, seasonId: string, now: Date): FactionId | undefined {
      const row = db
        .prepare(
          `SELECT faction_id FROM sessions
            WHERE token_hash = ? AND season_id = ? AND expires_at > ?`,
        )
        .get(tokenHash, seasonId, now.toISOString()) as { faction_id: string } | undefined
      return row?.faction_id
    },

    revokeSessions(factionId: FactionId): number {
      return Number(db.prepare("DELETE FROM sessions WHERE faction_id = ?").run(factionId).changes)
    },

    close(): void {
      db.close()
    },
  }
}
