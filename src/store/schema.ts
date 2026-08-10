import type { DatabaseSync } from "node:sqlite"

/**
 * Ordered, append-only. Each entry advances `PRAGMA user_version` by one.
 * Never edit a shipped migration -- add a new one. Plans 3 and 4 append theirs.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE seasons (
    season_id   TEXT PRIMARY KEY,
    start_date  TEXT NOT NULL,        -- ET calendar date of the day-0 deal
    length_days INTEGER NOT NULL
  );

  -- One row per day on which the publish job ran to completion. Distinguishes
  -- "no slate was published yet" from "an empty slate was published on purpose",
  -- which is the difference between retrying and playing plain Risk.
  CREATE TABLE slate_publications (
    season_id    TEXT NOT NULL,
    day          INTEGER NOT NULL,
    published_at TEXT NOT NULL,
    market_count INTEGER NOT NULL,
    PRIMARY KEY (season_id, day)
  );

  CREATE TABLE slate_markets (
    season_id  TEXT NOT NULL,
    day        INTEGER NOT NULL,
    market_id  TEXT NOT NULL,
    question   TEXT NOT NULL,
    price_yes  REAL NOT NULL,
    price_no   REAL NOT NULL,
    close_time TEXT NOT NULL,
    PRIMARY KEY (season_id, day, market_id)
  );

  CREATE INDEX slate_markets_by_market ON slate_markets (market_id);

  -- observed_at is load-bearing, not bookkeeping: Kalshi markets carry
  -- can_close_early, so a market can settle before its stated closeTime. The
  -- web app locks a market's wagers at min(close_time, observed_at), otherwise
  -- a player edits at 20:55 and stakes a known outcome at the 08:00 price.
  CREATE TABLE settlements (
    market_id   TEXT PRIMARY KEY,
    outcome     TEXT NOT NULL CHECK (outcome IN ('yes','no')),
    observed_at TEXT NOT NULL
  );
  `,

  `
  -- Slack user id -> faction. Opaque ids (U01ABCDEF) that only a human can map,
  -- and per-season configuration rather than code, so it lives in the database
  -- and is seeded by "npm run roster:add".
  --
  -- faction_id is UNIQUE on purpose: two Slack accounts on one faction would
  -- let a player approve their own post, and the self-approval check keys on
  -- faction id.
  CREATE TABLE roster (
    slack_user_id TEXT PRIMARY KEY,
    faction_id    TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL
  );

  -- Dedupe ledger. Slack redelivers an event up to three times when the ack is
  -- slow, and a retry carries the same event_id. Without this, one retried
  -- reaction becomes two approvals.
  CREATE TABLE slack_events (
    event_id    TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  );

  -- One row per workout photo. message_ts is Slack's own identifier for the
  -- message and is stable across edits, which is what lets a reaction find its
  -- post.
  --
  -- posted_at and et_date both derive from message_ts, never from the time the
  -- row was written: a post at 20:59:59 delivered at 21:00:01 still counts for
  -- that day.
  CREATE TABLE posts (
    message_ts TEXT PRIMARY KEY,
    faction_id TEXT NOT NULL,
    posted_at  TEXT NOT NULL,          -- ISO instant derived from message_ts
    et_date    TEXT NOT NULL,          -- America/New_York calendar date
    deleted    INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX posts_by_date ON posts (et_date);

  -- One row per (post, distinct approver). The primary key IS the "count
  -- distinct reactors" rule: a second approval emoji from the same player --
  -- 👍 after 👍🏽 -- collides and is ignored.
  --
  -- reacted_at is the reaction's Slack event_ts as an ISO instant, so it is
  -- directly comparable with the 21:00 cutoff. The second one of these, in
  -- ascending order, becomes ApprovedAction.approvedAt.
  CREATE TABLE reactions (
    message_ts TEXT NOT NULL,
    faction_id TEXT NOT NULL,
    reacted_at TEXT NOT NULL,
    PRIMARY KEY (message_ts, faction_id)
  );
  `,
]

/** Apply any migrations the database has not seen. Safe to call on every boot. */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN")
    try {
      db.exec(MIGRATIONS[v]!)
      // user_version does not accept a bound parameter.
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  }
}
