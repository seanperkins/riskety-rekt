# Riskety Rekt — Tick Runner & Orders Design

**Date:** 2026-08-10
**Status:** Approved
**Supersedes nothing.** Extends `2026-08-09-riskety-rekt-design.md`; deltas are listed at the end.

## Overview

The write side of the game. Orders reach SQLite, and at 21:00 America/New_York a
tick reads them, resolves them through the pure engine, saves the new state, and
posts the recap.

Nothing here draws a map, serves a page, or authenticates a player. It is the
smallest change that makes the game *playable* — with orders entered by CLI —
and it is the last piece that must exist before any interface is worth building.

## Where this sits

The original design's "Plan 4" bundled four subsystems. They are independent and
each is testable alone, so they are now three plans plus a prerequisite:

| Project | Scope | Depends on |
|---|---|---|
| **This spec** | orders, `claimTick`, the 21:00 tick, season deal | Plans 1–3 |
| **Map** | a ~70-territory board: names, continents, adjacency, polygons | nothing |
| **Projection & renderer** | public projection, confidentiality tests, SVG board, PNG for the recap | map |
| **Web app** | Next.js, `/login` magic link, order forms, droplet + Caddy | projection |

This spec is deliberately **map-agnostic**. `createSeason(seasonId, factions,
territoryIds)` already takes an arbitrary territory list, so nothing here needs
to know how big the board is.

## Goals

- A tick that runs unattended, exactly once per day, and cannot double-pay.
- Orders that can be revised until their own deadline and not after.
- A recovery path for a bad tick that does not involve hand-written SQL at 21:30.
- Enough CLI surface to play a real season before any UI exists.

## Non-goals

- The web app, authentication, or the board renderer.
- Rate limiting and per-day revision caps. Those are properties of a session,
  and there are no sessions yet.
- Multi-season concurrency. The schema is keyed by `season_id` throughout, so
  it is not *precluded*, but nothing here exercises it.

## Storage

Migration 3 adds four tables.

```sql
CREATE TABLE states (
  season_id      TEXT NOT NULL,
  day            INTEGER NOT NULL,
  state          TEXT NOT NULL,   -- GameState as JSON
  engine_version TEXT NOT NULL,
  run_at         TEXT NOT NULL,
  PRIMARY KEY (season_id, day)
);

CREATE TABLE orders (
  season_id  TEXT NOT NULL,
  day        INTEGER NOT NULL,
  faction_id TEXT NOT NULL,
  body       TEXT NOT NULL,       -- deploys, attacks, protect as JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (season_id, day, faction_id)
);

CREATE TABLE order_wagers (
  season_id  TEXT NOT NULL,
  day        INTEGER NOT NULL,
  faction_id TEXT NOT NULL,
  market_id  TEXT NOT NULL,
  side       TEXT NOT NULL CHECK (side IN ('yes','no')),
  stake      INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (season_id, day, faction_id, market_id)
);

CREATE TABLE day_locks (
  season_id TEXT NOT NULL,
  day       INTEGER NOT NULL,
  locked_at TEXT NOT NULL,
  PRIMARY KEY (season_id, day)
);
```

**Wagers are separate rows, not part of `body`.** Deploys, attacks and `protect`
stay editable until 21:00, while each wager locks when its own market closes. A
single JSON blob would force every save to merge the incoming wagers against the
stored ones, discarding those whose markets had closed — and a bug in that merge
silently rewrites a locked bet. Separate rows put each clock in its own table.

The `order_wagers` primary key also *is* the spec's "at most one wager per market
per faction" rule, which exists to close the both-sides hedge. Enforcing it in
the schema means it cannot be forgotten by a caller.

`states.state` is a JSON blob because the engine owns that shape and the store
has no business knowing it. It is schema-checked on load, not trusted.

## Two clocks

**`saveOrder(seasonId, day, factionId, body, now)`** is rejected once a
`day_locks` row exists for that day. Judged by the server clock only.

**`saveWager(seasonId, day, factionId, marketId, side, stake, now)`** is rejected
once that market is locked, where locked means:

```
min(slate_markets.close_time, settlements.observed_at) <= now
```

Not `close_time` alone. Every Kalshi market sampled carries `can_close_early`, so
an outcome can become public before the stated close — the same exploit the
per-market lock exists to close, arriving through a different door. The
`settlements.observed_at` column exists for this and this is where it gets used.

A wager on a market not on the day's slate is rejected outright. The stake price
is never taken from the caller; the engine reads it from the persisted slate.

Re-staking the same market replaces the row rather than adding one — the primary
key sees to that. **A stake of `0` deletes the row**, which is how a player backs
out of a bet before its market closes; after the lock, both the replace and the
delete are refused.

## The tick

```
runTick(deps) :
  day      <- latest saved day + 1
  guard      1 <= day <= season.lengthDays
  orders   <- claimTick(seasonId, day, now)        -- null means already run
  context  <- { slate, settlements, approvals, postedToday }   all local
  next     <- resolve(previous, orders, context)
  saveState(next)
  runPostRecap(next, previous)
```

The day is derived, never passed in: it is the highest saved day plus one.
`season-init` writes day 0, so the first tick resolves day 1. A season with no
day-0 state is an error rather than a deal — dealing a board is an explicit act,
not something a timer does at 21:00.

**`claimTick`** does two things in one transaction: it returns null if a `states`
row for day N already exists, and otherwise inserts the `day_locks` row and reads
the orders. A submit racing the timer therefore either lands before the read or
is rejected — never mid-resolution.

**`saveState` is an INSERT, not an upsert.** `claimTick` narrows the race; the
primary key closes it. Two ticks that somehow both got past the claim cannot both
write.

**The tick never touches the network.** Every input is a local table: the slate
and settlements from Plan 2, approvals and `postedToday` from Plan 3's
`dailyApprovals`. `runPostRecap` is the only outbound call and it happens strictly
after the state is saved, so a Slack outage cannot stall or double-run a tick.

## Failure and recovery

The interesting property falls out of the ordering above.

| Failure | Left behind | Recovery |
|---|---|---|
| `resolve` throws | lock set, no state | fix the code, `tick:rerun` — reads the *same frozen orders* |
| process dies before save | lock set, no state | same |
| state saved, recap failed | state, no recap | `recap <day>` |
| timer double-fires | nothing | second run returns null from `claimTick` |

Orders are frozen at lock and the tables are append-only in effect, so a rerun
cannot pick up orders edited by players who now know the outcome. That is the
whole reason the lock is set *before* resolution rather than after.

**`tick:rerun <day> --confirm`** deletes `states` from that day forward, replays
each day against its frozen orders, and posts each recap with `correction: true`.
It is destructive, so it demands the flag. Without `--confirm` it prints what it
*would* delete and exits non-zero.

System errors propagate. "Invalid orders never throw" is a rule about order
validation, and must not become "engine and database errors are swallowed and the
tick is marked successful."

## Season initialization

`season-init` currently writes only the seasons row. It now also deals day 0:

```
npm run season:init -- 2026-09-01 --seed 4711
```

- **Factions come from the roster table** that Plan 3 built. One Slack user per
  faction is already enforced there, so the roster is the single source of truth
  for who is playing. Duplicating it in a config file would let the two drift.
- **Colors** are assigned from a fixed palette by sorted faction id, so the deal
  is a pure function of the roster.
- **The shuffle is seeded and the seed is stored** on the seasons row. The engine
  holds no randomness by design — `createSeason` takes an already-shuffled list —
  so the shuffle happens here, and recording the seed makes the deal auditable
  and reproducible.
- **The territory list is an argument**, defaulting to `RISK_MAP`. This is what
  keeps the whole plan map-agnostic.
- It refuses if a day-0 state already exists, and if the roster size is outside
  the configured faction bounds.

## Order entry

Until the web app exists, orders are entered by CLI:

```bash
npm run order -- f1 '{"deploys":[{"territory":"alaska","count":3}],
                      "attacks":[],"protect":null}'
npm run wager -- f1 KXBTC-26AUG10 yes 5
```

Both write through the same `saveOrder` / `saveWager` path the web app will use,
so the lock behaviour is exercised from day one rather than discovered later.
`factionId` is a positional argument here and a session lookup there; in neither
case does it come from the order body. That is why `body` holds only deploys,
attacks and protect — the unauthenticated form is unrepresentable rather than
merely rejected.

The CLI validates JSON shape and rejects unknown fields, but does **not**
validate against game rules. The engine owns that, and its rejections surface in
the recap.

## Season length

`SEASON_LENGTH` drops from 21 to 14. With 8–10 players a 21-day season runs long,
and the closest commercial analogues — Neptune's Pride and Subterfuge — settle
around a week at that headcount.

Measured on 2,000 simulated seasons at six policies, shortening to 14 days moves
the day-3 leader's conversion from 32.3% to 36.3% and leaves the exploit prober
dead at 0.3%. The spec's test is "if the day-3 leader *usually* wins, the season
is decided too early"; 36.3% against a 16.7% chance baseline is not that.

`lengthDays` is stored per season, so this constant only affects seasons dealt
after the change.

## Testing

In priority order:

1. **Lock behaviour.** `saveOrder` after 21:00 is rejected; a wager on a market
   whose `close_time` has passed is rejected; a wager on a market that *settled
   early* is rejected even though `close_time` is in the future; a wager on a
   market not on today's slate is rejected; a second wager on the same market
   replaces rather than duplicates.
2. **`claimTick` idempotency.** Second call returns null; a claim followed by a
   throw leaves the lock and no state; the orders read after a failed tick are
   byte-identical on replay.
3. **Tick assembly.** `DailyContext` carries the day's slate, the settlements
   known at lock, and both `approvals` and `postedToday`; a day with no slate
   resolves as plain Risk; a tick before day 1 or after the final day is a
   deliberate skip, not an error.
4. **Rerun.** Deletes only from the named day forward; replays produce identical
   states given identical orders; recaps carry the correction flag; no `--confirm`
   deletes nothing.
5. **Season deal.** Same seed produces the same board; the roster drives the
   faction list; refuses on an existing day-0 state or an out-of-bounds roster.
6. **No network.** No test in this project makes one, and the tick makes none in
   production either.

## Spec deltas

Recorded against `2026-08-09-riskety-rekt-design.md` so they are not
re-litigated.

| Original spec | This design | Why |
|---|---|---|
| 21-day season | 14 days | 8–10 players, not 4–6. Measured effect on early decision is +4 points, well inside tolerance. |
| 4–6 factions | 8–10 | The group is larger than the original design assumed. Requires a bigger map, specified separately. |
| Standard 42-territory Risk map | a ~70-territory board, its own spec | 42 territories at 10 factions is 4.2 each, which pins every player at the income floor all season — the exact failure the spec already rejected once. Sizing to ~7 territories per faction keeps the economy untouched. |
| `Store.saveOrder(…, orderBody)` | split into `saveOrder` and `saveWager` | Deploys and wagers lock on different clocks. One blob forces a merge on every write. |
| Slack OAuth for the web app | a `/login` slash command that DMs a magic link | The slash command payload already carries a signature-verified `user_id`, so Slack has authenticated the player before the server sees anything. No OAuth callback, no user tokens, and it reuses the roster and signing-secret verification already built. Specified with the web app. |

## Deferred

- **Rate limiting and revision caps.** Session properties; they arrive with
  sessions.
- **The map, the renderer, the projection, the web app.** Separate specs.
- **A `Ghost` sim policy** that posts nothing and plays weakly, to give the
  elimination-veto post gate real coverage. `Slacker` is currently the only
  zero-post policy and it is never eliminated.
- **Re-examining the balance run.** The recorded headline numbers no longer match
  what the committed code produces, and that predates this work.
