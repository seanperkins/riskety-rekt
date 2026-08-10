import type { DatabaseSync } from "node:sqlite"

/**
 * Ordered, append-only. Each entry advances `PRAGMA user_version` by one.
 * Never edit a shipped migration -- add a new one.
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

  `
  -- Nullable: any season row written before the deal existed has no seed.
  ALTER TABLE seasons ADD COLUMN seed INTEGER;

  -- One GameState per (season, day), as JSON, because the engine owns that shape
  -- and the store has no business knowing it. Schema-checked on load, not trusted.
  --
  -- There is deliberately no run_at column: nothing reads it. And there is no
  -- lock table -- the tick's claim, resolve and save are one transaction, so
  -- there is no intermediate state for a second process to misread.
  CREATE TABLE states (
    season_id      TEXT NOT NULL,
    day            INTEGER NOT NULL CHECK (day >= 0),
    state          TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    PRIMARY KEY (season_id, day)
  );

  CREATE TABLE orders (
    season_id  TEXT NOT NULL,
    day        INTEGER NOT NULL CHECK (day >= 1),
    faction_id TEXT NOT NULL,
    body       TEXT NOT NULL,       -- deploys, attacks, protect as JSON
    updated_at TEXT NOT NULL,
    PRIMARY KEY (season_id, day, faction_id)
  );

  -- first_staked_at is the stable ordering key for the aggregate reserve check,
  -- which is sequential-greedy. Ordering by updated_at would hand a player a
  -- lever over which bet survives a short reserve. Millisecond precision matters:
  -- at second precision ties are common and the market_id tiebreak -- which the
  -- player picks -- would decide it.
  --
  -- typeof(stake) = 'integer' is not redundant with the > 0 check: INTEGER is a
  -- type AFFINITY in SQLite, so 1.5 binds and stores as 1.5, and 1.5 > 0 passes.
  CREATE TABLE order_wagers (
    season_id       TEXT NOT NULL,
    day             INTEGER NOT NULL CHECK (day >= 1),
    faction_id      TEXT NOT NULL,
    market_id       TEXT NOT NULL,
    side            TEXT NOT NULL CHECK (side IN ('yes','no')),
    stake           INTEGER NOT NULL CHECK (stake > 0 AND typeof(stake) = 'integer'),
    first_staked_at TEXT NOT NULL,
    PRIMARY KEY (season_id, day, faction_id, market_id)
  );

  -- The frozen inputs of one tick, written in the SAME transaction as the state
  -- row. Only a rerun reads it.
  --
  -- It exists because the context is not reconstructable after the fact:
  -- settlements could be filtered by a timestamp, but posts.deleted is an
  -- untimestamped flag and removeApproval hard-deletes its row, so a player
  -- deleting an old photo would retroactively change postedToday on replay.
  CREATE TABLE tick_context (
    season_id      TEXT NOT NULL,
    day            INTEGER NOT NULL CHECK (day >= 1),
    orders         TEXT NOT NULL,   -- the assembled Order[] as JSON
    context        TEXT NOT NULL,   -- the assembled DailyContext as JSON
    engine_version TEXT NOT NULL,
    PRIMARY KEY (season_id, day)
  );

  -- Outbound-message idempotency. A lost acknowledgement must not post twice.
  --
  -- attempt is in the key because a second correction for the same day is an
  -- ordinary event -- the first fix was wrong -- and must not be suppressed.
  -- 'gap' is the once-only note for a missed day, whose predicate stays true
  -- every night thereafter and would otherwise post forever.
  CREATE TABLE recaps (
    season_id TEXT NOT NULL,
    day       INTEGER NOT NULL CHECK (day >= 1),
    kind      TEXT NOT NULL CHECK (kind IN ('original','correction','gap')),
    attempt   INTEGER NOT NULL CHECK (attempt >= 1),
    posted_at TEXT NOT NULL,
    PRIMARY KEY (season_id, day, kind, attempt)
  );

  -- close_time was stored verbatim as Kalshi sent it, and the per-market wager
  -- lock is a STRING comparison -- a date-only value sorts after every same-day
  -- instant and reads as open forever. Normalize what is already on disk;
  -- toCandidate normalizes new rows at ingest.
  UPDATE slate_markets
     SET close_time = strftime('%Y-%m-%dT%H:%M:%fZ', close_time)
   WHERE close_time NOT LIKE '____-__-__T__:__:__.___Z';
  `,
]

/** Apply any migrations the database has not seen. Safe to call on every boot. */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE")
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
