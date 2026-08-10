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
