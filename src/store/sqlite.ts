import { createRequire } from "node:module"
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite"
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
  OrderBody,
  OrderStore,
  SaveResult,
  StateStore,
  Transactional,
  WagerInput,
  WagerRow,
  ApproverRow,
  PostRow,
  RosterMember,
  RosterStore,
  SeasonRow,
  SlateStore,
} from "./types.js"
import type { FactionId, GameState } from "../engine/index.js"
import { tickInstant } from "../season.js"
import { etDate, slackTsToIso } from "../time.js"

/** SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999; stay well under it. */
const PARAM_CHUNK = 500

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function openStore(
  path: string,
): SlateStore & RosterStore & ApprovalStore & OrderStore & StateStore & Transactional {
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

        // first_staked_at is deliberately absent from the DO UPDATE list: it
        // anchors the ordering of the sequential-greedy reserve check, and
        // letting a re-stake move it would hand the player that lever.
        db.prepare(
          `INSERT INTO order_wagers
             (season_id, day, faction_id, market_id, side, stake, first_staked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (season_id, day, faction_id, market_id)
             DO UPDATE SET side = excluded.side, stake = excluded.stake`,
        ).run(
          seasonId,
          day,
          factionId,
          wager.marketId,
          wager.side,
          wager.stake,
          now.toISOString(),
        )
        return { ok: true }
      })
    },

    wagersFor(seasonId: string, day: number, factionId: FactionId): WagerRow[] {
      const rows = db
        .prepare(
          `SELECT market_id, side, stake, first_staked_at
             FROM order_wagers
            WHERE season_id = ? AND day = ? AND faction_id = ?
            ORDER BY first_staked_at, market_id`,
        )
        .all(seasonId, day, factionId) as {
        market_id: string
        side: string
        stake: number
        first_staked_at: string
      }[]
      return rows.map((r) => ({
        marketId: r.market_id,
        side: r.side === "no" ? "no" : "yes",
        stake: Number(r.stake),
        firstStakedAt: r.first_staked_at,
      }))
    },

    stateExists(seasonId: string, day: number): boolean {
      return stateExistsRow(seasonId, day)
    },

    /** INSERT, never upsert: inside the tick's transaction it can run only once. */
    saveState(state: GameState, engineVersion: string): void {
      db.prepare(
        `INSERT INTO states (season_id, day, state, engine_version) VALUES (?, ?, ?, ?)`,
      ).run(state.seasonId, state.day, JSON.stringify(state), engineVersion)
    },

    close(): void {
      db.close()
    },
  }
}
