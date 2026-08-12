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
  `
  -- Login tokens. Stored HASHED, never raw: the database sits on the same
  -- droplet as the app, and a magic link IS a credential.
  --
  -- slack_user_id is UNIQUE rather than merely indexed, which is what makes
  -- "a new /login invalidates the previous token" a property of the schema
  -- instead of a step someone can forget.
  CREATE TABLE login_tokens (
    token_hash    TEXT PRIMARY KEY,
    slack_user_id TEXT NOT NULL UNIQUE,
    faction_id    TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );

  -- Sessions expire at the season's end, so nobody is bounced mid-week and
  -- certainly not at 20:55 against a hard 21:00 deadline.
  --
  -- season_id is on the row because a factionId only means something within a
  -- season; a session carried across one would point at a faction that no
  -- longer exists.
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    faction_id TEXT NOT NULL,
    season_id  TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX sessions_by_faction ON sessions (faction_id);
  `,
  `
  -- Live prices, separate from slate_markets on purpose.
  --
  -- slate_markets is the PUBLISHED slate and stays frozen: publishSlate refuses
  -- a second write precisely so a rerun at 20:00 cannot re-snapshot the day's
  -- prices. But freezing is also what created the exploit -- a wager placed at
  -- 20:59, when the outcome is nearly public, paid at the morning's odds for
  -- roughly +94% EV.
  --
  -- So prices live here, refreshed every 30 minutes by poll-prices, and a wager
  -- records the price it was PLACED at. The slate stays the slate; the odds move.
  CREATE TABLE market_prices (
    market_id   TEXT PRIMARY KEY,
    price_yes   REAL NOT NULL,
    price_no    REAL NOT NULL,
    observed_at TEXT NOT NULL
  );

  -- The price for the chosen side at the moment the wager was saved. NULL for
  -- rows written before this migration, which fall back to the slate price.
  ALTER TABLE order_wagers ADD COLUMN price REAL;
  `,
  `
  -- Up to MAX_LIVE_TOKENS links per person instead of exactly one.
  --
  -- The UNIQUE on slack_user_id made "a new /login kills the old link" a
  -- property of the schema, which was the point -- but it also meant a second
  -- /login run before clicking the first, or a link minted on someone's behalf,
  -- silently killed a link they were about to use. The cap is what actually
  -- bounds token spam; strict single-token buys nothing on top of a 10-minute
  -- TTL and single use.
  --
  -- SQLite cannot drop a constraint, so the table is rebuilt and its rows
  -- carried across -- a link outstanding at migration time still works.
  CREATE TABLE login_tokens_v2 (
    token_hash    TEXT PRIMARY KEY,
    slack_user_id TEXT NOT NULL,
    faction_id    TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );

  INSERT INTO login_tokens_v2 (token_hash, slack_user_id, faction_id, expires_at)
    SELECT token_hash, slack_user_id, faction_id, expires_at FROM login_tokens;

  DROP TABLE login_tokens;
  ALTER TABLE login_tokens_v2 RENAME TO login_tokens;

  CREATE INDEX login_tokens_by_user ON login_tokens (slack_user_id);
  `,
  `
  -- Pluggable mechanics: the season's enabled module set, and the state-shape
  -- move of GameState.pending into moduleState.markets.pending.
  --
  -- The UPDATE is a DATA migration, pinned in the spec because its failure
  -- mode is severe and silent: a mis-composed rewrite drops pending without
  -- writing moduleState, parseState then rejects every row, and user_version
  -- has already advanced — an unbootable database with no rollback. The
  -- migration test loads a real pre-migration row through this exact SQL.
  ALTER TABLE seasons ADD COLUMN modules TEXT NOT NULL DEFAULT '["markets","irl","veto"]';

  UPDATE states SET state = json_set(
    json_remove(state, '$.pending'),
    '$.moduleState',
    json_object('markets', json_object('pending', json_extract(state, '$.pending')))
  )
  WHERE json_extract(state, '$.pending') IS NOT NULL;
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
