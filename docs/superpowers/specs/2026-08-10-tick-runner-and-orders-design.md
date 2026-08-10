# Riskety Rekt — Tick Runner & Orders Design

**Date:** 2026-08-10
**Status:** Revised after multi-model review (round 1)
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
each is testable alone, so they are now three plans plus two prerequisites:

| Project | Scope | Blocks |
|---|---|---|
| **This spec** | orders, the 21:00 tick, season deal | — |
| **Wager economy** | the deploy-inflation void and the stale-price placement exploit; periodic price snapshots | a real season |
| **Map** | a board of ~15 continents of *varying* size: names, adjacency, polygons | a real season |
| **Projection & renderer** | public projection, confidentiality tests, SVG board, PNG for the recap | the web app |
| **Web app** | Next.js, `/login` magic link, order forms, droplet + Caddy | — |

This spec can ship first and be exercised on the CLI. **Two of those siblings
must land before a competitive season starts**, and each has its own section
below saying why.

### The board scales with the roster

The economy keys on the *absolute* territory count. `territoryIncome` is
`max(5, floor(count / 2)) + bonuses` (`src/engine/income.ts:14`), so
`floor(t/2) > 5` only at **t ≥ 12**: income is exactly 5 for every holding from 1
to 11 territories.

So the *income* constraint is **≤ 11 territories per faction at the deal**, not a
specific number: the original 42/6 board sits at 7.0, and anything from 1 to 11 is
identical to the engine on day 0. A board sized for the maximum headcount and dealt
whole would break it — 105 territories to 8 factions is 13 each, above the floor
from the first tick — so a season deals a subset sized to its roster.

Income is not the only constraint. A faction dealt 2–3 territories holds 4–6 troops
and dies to one focused attack, and no continent of any size is reachable from
there. So the deal is bounded on **both** sides —
`5 <= floor(t/f)` and `ceil(t/f) <= 11` — and `season-init` enforces both.

| Factions | Territories dealt | Per faction | Income at deal |
|---|---|---|---|
| 8 | ~56 | 7.0 | 5 |
| 12 | ~84 | 7.0 | 5 |
| 15 | ~105 | 7.0 | 5 |

The `≤ 11` slack is what makes "~15 continents of varying size" workable:
continents of 5, 7 or 9 all leave every faction at the income floor.

**The economy is *not* wholly untouched, and the map spec must know it.** Risk's
cheapest continent is 4 territories for +2 — holdable from a 7-territory deal,
and the sim's `Consolidator` policy is built on exactly that. A board of uniform
7-territory continents raises the cheapest rung by 75% and removes the ladder
entirely. **The map must include at least one small continent**, or `Consolidator`
play is designed out. Continent sizes are deliberately variable for this reason.

All this spec needs is that the territory list and the map are arguments.

## Goals

- A tick that runs unattended, exactly once per calendar day, and cannot double-pay.
- Orders that can be revised until their own deadline and not after.
- A recovery path for a bad tick that does not involve hand-written SQL at 21:30.
- A rerun that reproduces the original tick exactly.
- Enough CLI surface to play a test season before any UI exists.

## Non-goals

- The web app, authentication, or the board renderer.
- Rate limiting and per-day revision caps. Those are properties of a session.
- **Wager mutation policy.** Whether a placed wager can be edited or withdrawn,
  and under what window, is decided by the wager-economy spec — because the fix
  it adopts changes the answer. See "Wagers are write-once here".
- Multi-season concurrency. The schema is keyed by `season_id` throughout, so it
  is not *precluded*, but nothing here exercises it.

## The day clock

**Every component derives the day from the calendar.** This is the single most
important correction in this design.

```ts
/** The season day for an instant. Shared by every producer and consumer. */
export function currentDay(season: SeasonRow, now: Date): number {
  return etDaysBetween(season.startDate, etDate(now))
}
```

`runPublishSlate` already computes exactly this (`src/jobs/publish-slate.ts:45-46`),
and `dailyApprovals` maps a day number back to a date the same way
(`src/slack/approvals.ts:31-32`). The tick must join them rather than invent a
second clock.

Deriving the tick's day as "highest saved day + 1" instead would create two clocks
that agree only while no tick is ever missed, and three failures follow from the
divergence:

- **A season dealt in advance burns days.** `season-init` takes a start date, so
  dealing on Aug 15 for a Sep 1 start is supported. A state-derived tick would
  resolve day 1 that very night, with no slate and approvals read from the wrong
  date, and keep going one day per night until the season "began".
- **One missed tick shears the game permanently.** The tick would run a day behind
  the calendar forever, reading slates whose markets settled the previous evening.
  There is no catch-up and `tick:rerun` cannot renumber calendar-keyed slates.
- **A sequential double-fire burns a day.** Fire, complete, fire again: the second
  run computes N+1, finds no state there, and resolves it as plain Risk with zero
  orders. A state-derived guard is idempotent per *game* day, not per calendar
  day, so it does not catch this.

The tick therefore compares the two and acts on the difference. **The rows are
evaluated in this order and the order is load-bearing:**

| # | Condition | Behaviour |
|---|---|---|
| 1 | `latestSavedDay < min(calendarDay - 1, season.lengthDays)` | **refuse**, naming the missing days |
| 2 | `calendarDay < 1` | skip — `before-season` |
| 3 | `calendarDay > season.lengthDays` | skip — `after-season` |
| 4 | `latestSavedDay + 1 > calendarDay` | skip — `already-run` (the sequential double-fire) |
| 5 | `latestSavedDay + 1 === calendarDay` | proceed |

**Row 1 must precede row 3, and its bound must be `min(calendarDay - 1,
lengthDays)` rather than `calendarDay`.** A plainer `latestSavedDay + 1 <
calendarDay` placed after the after-season skip silently swallows the single most
expensive failure in the season: with `lengthDays = 14`, a missed day-14 tick
noticed on day 15 has `calendarDay > lengthDays`, so the after-season row fires
first and the run exits 0 having done nothing. The winner would then be read off
the day-13 state, and day-13 wagers would never settle — `settleAll` refunds an
unsettled wager only at `today − placedOnDay >= REFUND_AFTER_TICKS`
(`src/engine/wagers.ts:71`), i.e. at a tick 15 that never runs, so those stakes are
confiscated and the `garrisons + reserves` tiebreak moves.

Worked: `lengthDays = 14`, day 14 missed, operator looks on day 15.
`latestSavedDay = 13`, `min(15 − 1, 14) = 14`, and `13 < 14` → refuse. The normal
case `D = 5, latestSavedDay = 4` gives `min(4, 14) = 4` and `4 < 4` is false, so it
proceeds. A season dealt in advance (`calendarDay = −5`, `latestSavedDay = 0`)
gives `min(−6, 14) = −6`, `0 < −6` false, and falls through to row 2.

A missed day is refused rather than auto-resolved. Those orders were written for a
night that never came, and resolving them a day late — after their markets settled
and their recap window passed — is worse than stopping and telling an operator.

**The refusal exits 0, not 1.** It is a deliberate stop, and its condition never
clears with time: `latestSavedDay < min(calendarDay − 1, lengthDays)` stays true
every subsequent night until an operator acts. Exiting 1 under the existing units'
`Restart=on-failure` / `RestartSec=300` would restart every five minutes all night,
reopening the database and writing a stack trace each time, and systemd's default
start-limit never trips at that rate. The tick logs loudly, posts a generic
failure note to Slack, and exits 0. See "Deployment".

`saveOrder` and `saveWager` take `day` as a parameter, and **every caller derives
it from `currentDay`**. Both reject `day < 1 || day > season.lengthDays` — a season
dealt in advance yields a non-positive `currentDay`, and orders written for day −3
or day 15 would otherwise be accepted and never read by any tick.

## Storage

Migration 3 adds four tables and one column.

**There is no lock table.** An earlier draft carried `day_locks`; it is gone, and
"Why there is no lock table" below explains what replaced it.

```sql
ALTER TABLE seasons ADD COLUMN seed INTEGER;   -- nullable: existing rows predate the deal

CREATE TABLE states (
  season_id      TEXT NOT NULL,
  day            INTEGER NOT NULL,
  state          TEXT NOT NULL,   -- GameState as JSON
  engine_version TEXT NOT NULL,
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

-- first_staked_at is the stable ordering key for the aggregate reserve check.
-- Ordering by updated_at would hand a player a lever over which bet survives a
-- short reserve. Millisecond precision matters: at second precision ties are
-- common and the market_id tiebreak -- which the player picks -- would decide
-- which bet survives.
CREATE TABLE order_wagers (
  season_id       TEXT NOT NULL,
  day             INTEGER NOT NULL,
  faction_id      TEXT NOT NULL,
  market_id       TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('yes','no')),
  stake           INTEGER NOT NULL CHECK (stake > 0),
  first_staked_at TEXT NOT NULL,   -- toISOString(), millisecond precision
  PRIMARY KEY (season_id, day, faction_id, market_id)
);

-- The frozen inputs of one tick, written in the SAME transaction as the state
-- row. A rerun replays exactly what the original tick saw; nothing else reads it.
-- engine_version is recorded so an adopted replay cannot silently cross a
-- version boundary.
CREATE TABLE tick_context (
  season_id      TEXT NOT NULL,
  day            INTEGER NOT NULL,
  orders         TEXT NOT NULL,   -- the assembled Order[] as JSON
  context        TEXT NOT NULL,   -- the assembled DailyContext as JSON
  engine_version TEXT NOT NULL,
  PRIMARY KEY (season_id, day)
);

-- Recap idempotency. A lost acknowledgement must not post the recap twice.
-- attempt is in the key: a second correction for the same day is an ordinary
-- event (the first fix was wrong) and must not be suppressed.
CREATE TABLE recaps (
  season_id TEXT NOT NULL,
  day       INTEGER NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('original','correction')),
  attempt   INTEGER NOT NULL,
  posted_at TEXT NOT NULL,
  PRIMARY KEY (season_id, day, kind, attempt)
);
```

**Wagers are separate rows, not part of `body`.** Deploys, attacks and `protect`
stay editable until the day lock, while each wager locks when its own market
closes. A single JSON blob would force every save to merge incoming wagers against
stored ones, and a bug in that merge silently rewrites a locked bet.

The `order_wagers` primary key *is* the spec's "at most one wager per market per
faction" rule, which closes the both-sides hedge below the caller.

`CHECK (stake > 0)`, not `>= 0`: wagers are write-once here, so there is no
withdrawal tombstone to represent, and a zero stake is only ever a malformed
write. `saveWager` additionally rejects a stake that is not a safe integer, so
the CLI errors at submission rather than in the recap.

`states.run_at` is deliberately absent — nothing reads it. `engine_version` is kept
and **has a stated consumer**: `tick:rerun` compares the recorded
`tick_context.engine_version` against the running one and logs the difference. It
does **not** refuse: "fix the code, then rerun" is the documented recovery for a
`resolve` that threw, so refusing on a version change would block the primary use.
An earlier draft had it refuse without a flag, which contradicted that recovery
path. It warns, names both versions, and proceeds.

## Two clocks

**`saveOrder(seasonId, day, factionId, body, now)`** is rejected when any of:

- `day` is outside `[1, season.lengthDays]`;
- `now >= etInstant(dayDate, TICK_HOUR)` — the 21:00 constant already in
  `src/slack/config.ts:20`;
- a `states` row exists for that day, i.e. the tick has already resolved it.

All three are evaluated inside one `BEGIN IMMEDIATE` together with the write. The
clock is the deadline; the state check is what closes the race. A submit at
20:59:59.9 is legal by the clock, and under WAL it either commits before the tick's
transaction or waits behind it — and if it waits, it then sees the state row and is
rejected rather than landing on a day that has already resolved.

**`saveWager(seasonId, day, factionId, marketId, side, stake, now)`** is rejected
when *any* of these holds:

```sql
-- 1. the day is locked (same gate as saveOrder — see below)
-- 2. the market is closed or has settled:
COALESCE(MIN(sm.close_time, s.observed_at), sm.close_time) <= :now
```

The `COALESCE` is load-bearing. An unsettled market has **no `settlements` row**,
so `observed_at` is NULL, and SQLite's `min()` returns NULL when any argument is
NULL. Written bare as `MIN(close_time, observed_at) <= now`, the common case
evaluates to NULL and the market reads as *open* — including after its close time.
Computed in TypeScript as `Math.min(closeMs, NaN)` it is NaN, and `NaN <= now` is
false, with the same result. Two of the three natural implementations fail in the
player's favour, which is precisely what this rule exists to prevent.

**`saveWager` takes the same three gates as `saveOrder`, plus the market clock.**
The original design gave wagers only the per-market clock, which left a wager
writable for day N after the tick had read the orders — invisible to that tick, but
`tick:rerun` re-reads and would activate a bet placed with the outcome known.
Today that gap is closed only by the coincidence that `WINDOW_CLOSE_HOUR` equals
`TICK_HOUR` (`src/config.ts:10`), which is a configuration value, not an
enforcement.

**The operands of the market clock must be normalized instants.** `close_time` is
stored verbatim as Kalshi sent it (`src/adapters/kalshi/parse.ts:138` →
`src/store/sqlite.ts:98`), validated only by `Number.isFinite(Date.parse(v))`
(`src/adapters/kalshi/parse.ts:74-76`), which accepts `2026-08-10T21:30:00+00:00`,
`2026-08-10T17:30:00-04:00` and bare `2026-08-11`. The comparison above is a
*string* comparison against `now.toISOString()`, and a date-only `close_time` sorts
*after* any same-day instant — so the market reads as open forever. `toCandidate`
must normalize with `new Date(m.close_time).toISOString()` at ingest. This latent
bug already exists at `src/store/sqlite.ts:172`, but this design promotes the
comparison to a load-bearing anti-exploit rule, so it has to be fixed here.

A wager on a market not on the day's slate is rejected outright. The stake price is
never taken from the caller; `escrow` reads it from the persisted slate
(`src/engine/wagers.ts:41`).

### Wagers are write-once here

A placed wager cannot be edited or withdrawn in this phase.

An earlier draft specified a 60-minute correction window anchored to first touch,
to allow fixing a fat-fingered stake without granting a free option. Review
established that the same free option is reachable through two larger doors that
this spec does not own — and that the wager-economy spec's chosen fix, pricing at
placement from periodic snapshots, makes the window nearly redundant. Building it
now would be building machinery to delete.

So: write-once, and the mutation policy is decided once with the pricing model.
`first_staked_at` survives because the aggregate reserve check is sequential-greedy
(`src/engine/validate.ts:106`) and needs a stable order.

## Order assembly

The tick's transaction joins two tables into the engine's `Order[]`
(`src/engine/types.ts:96`).
The rules are explicit because each has a failure mode:

- **Filter `stake > 0`.** A zero stake must never reach the engine:
  `validateOrder` *rejects* it (`src/engine/validate.ts:89-92`) and the recap
  renders every rejection by name (`src/slack/recap.ts:157-168`), so a malformed
  row becomes a public accusation of a bad stake.
- **Order wagers by `first_staked_at`, then `market_id`.** The reserve check drops
  wagers sequentially, so ordering decides which survive a short reserve.
- **Synthesize an `Order` for a faction with wagers but no body** — `{deploys: [],
  attacks: [], protect: null, wagers: [...]}`. The two CLI commands are
  independent, so a player can wager without ever submitting deploys, and those
  wagers must not vanish.
- **Every assembled order passes through `validateOrder` before `escrow`.**
  `escrow` does an unchecked `byId.get(w.marketId)!` (`src/engine/wagers.ts:34`),
  safe only because validation filters to today's slate first. `tick:rerun` is a
  new caller and must not bypass it.

## The tick

```
runTick(deps) :
  season      <- store.season(seasonId)                 -- error if absent
  calendarDay <- currentDay(season, now)
  guard         day-clock table above                   -- skip or refuse per row
  guard         now >= etInstant(dayDate, TICK_HOUR)    -- refuse an early manual run

  outcome <- store.transaction(() => {                  -- ONE transaction
    if states[day] exists  -> return "already-run"
    orders  <- assemble from orders + order_wagers
    context <- { slate, settlements, approvals, postedToday }
    next    <- resolve(previous, orders, context)       -- pure, in-memory
    INSERT states(day, next)
    INSERT tick_context(day, orders, context, ENGINE_VERSION)
    return next
  })

  postRecap(next, previous, kind: "original")           -- outside, after commit
```

`season-init` writes day 0, so the first tick resolves day 1. A season with no
day-0 state is an error rather than a deal — dealing a board is an explicit act,
not something a timer does at 21:00.

The **`now >= 21:00` guard** is separate from the day-clock table and easy to miss:
without it a manual `npm run tick` at 14:00 resolves the day while its markets are
still open and its approvals still arriving.

### Why there is no lock table

An earlier draft had a `day_locks` table and a two-phase `claimTick` that froze the
orders, then resolved, then saved. Review showed the two phases created an
ambiguity they could not resolve: after the freeze, `tick_context[day] exists`
means either *"a previous attempt died"* or *"another process is resolving right
now"*, and adopting on that signal lets two concurrent runs both resolve, with one
then dying on the `states` primary key.

Collapsing claim, resolve and save into one transaction removes the ambiguity
rather than arbitrating it. `resolve` is pure, in-memory and has no I/O
(`src/engine/resolve.ts:32`), so holding the write lock across it costs
microseconds — there is nothing to be gained by releasing it in between.

What that buys:

- **The concurrent double-fire is genuinely closed.** The second process blocks on
  `BEGIN IMMEDIATE`, and when it proceeds it sees the `states` row and returns
  `already-run`. No duplicate resolve, no primary-key violation, no failed unit.
- **A crash leaves nothing behind.** The transaction rolls back, so a retry starts
  clean. There is no half-state to adopt and no lock to collide with, which was
  the whole source of the retry crash-loop.
- **`day_locks` was redundant anyway.** Its job was to reject `saveOrder` after
  21:00; the clock check plus the `states`-row check do that, and do it without a
  row that outlives the transaction that wrote it.

The price is that orders are no longer frozen *before* `resolve` runs — a crashed
tick lets a player edit before the retry. That is acceptable because the freeze
exists to stop editing by players **who know the outcome**, and no outcome is
public until `postRecap`, which is after the commit. A crashed tick publishes
nothing.

### Why `tick_context` still exists

Not for crash recovery — for replay. `settleAll` reads live settlements
(`src/engine/wagers.ts:68`) and `dailyApprovals` reads live posts and reactions
(`src/slack/approvals.ts:34`), so a rerun days later would resolve differently from
the original tick. Filtering by a timestamp was considered and rejected: it works
for settlements, but **not for approvals**, because `posts.deleted` is an
untimestamped flag and `removeApproval` hard-deletes its row
(`src/store/sqlite.ts:232-234`, `:249-254`). A player deleting an old photo would
retroactively change `postedToday` — and possibly an elimination veto — on replay.

The context is therefore recorded at the moment it is read, in the same transaction
as the state. This also gives the original design spec's golden-file replay test
real recorded inputs.

**Settlements are snapshotted over the union of today's slate and every market with
a pending wager**, not just today's slate. `resolve` settles *all* matured pending
wagers at step 1 (`src/engine/resolve.ts:38-40`), which includes wagers placed on
earlier days whose markets are not on today's slate, while `loadSettlements` only
returns the ids it is asked for (`src/store/sqlite.ts:148-161`). Snapshotting the
slate alone would silently mark those unsettled and refund them.

**`saveState` is an INSERT, not an upsert.** Inside the transaction it can only run
once; the primary key is the backstop.

**The tick never touches the network.** Every input is a local table. `postRecap`
is the only outbound call, and it happens after the commit — so a Slack outage can
neither stall nor roll back a resolved day.

## Failure and recovery

| Failure | Left behind | Recovery |
|---|---|---|
| `resolve` throws | **nothing** — the transaction rolls back | fix the code; the next run resolves the day normally |
| process dies mid-tick | **nothing** | same |
| state saved, recap post failed | state + a `recaps` row | `recap <day> --force` |
| recap posted, ack lost | state + a `recaps` row | nothing — the ledger suppresses the duplicate |
| timer fires twice concurrently | nothing | the second blocks, sees the state row, returns `already-run` |
| timer fires twice sequentially | nothing | the day-clock guard skips `already-run` |
| a day is missed entirely | nothing | `tick:rerun <day> --confirm --assemble-missing` |

A crashed tick leaving *nothing* behind is the point of the single transaction. It
is also why the `resolve`-throws row no longer says "replays the recorded context":
there is no recorded context, because nothing committed.

**Recap idempotency.** `postRecap` inserts into `recaps` *before* posting and skips
when a row already exists for that `(day, kind, attempt)`. A crash between the
insert and the post therefore loses that recap rather than duplicating it — the
deliberate trade, since a duplicate is confusing and a miss is recoverable.

`recap <day> [--kind correction] --force` is the recovery: it inserts a **new
attempt** and posts. It never deletes a ledger row. This matters because the
ordinary failure — a Slack 5xx or a timeout on `poster.post`
(`src/jobs/post-recap.ts:33`) — leaves the row present, so a plain `recap <day>`
would see it and silently skip. The `attempt` column is also what lets a *second*
correction post: re-running a day twice because the first fix was wrong is an
ordinary event, and a `(season, day, kind)` key would suppress it.

**`tick:rerun <day> --confirm`** deletes `states` from that day forward and replays
each day against its recorded `tick_context`, posting each recap as a `correction`.
It logs the recorded `engine_version` against the running one, and proceeds — "fix
the code, then rerun" is its documented purpose, so refusing on a version change
would block the case it exists for.

`<day>` must satisfy `Number.isSafeInteger(day) && 1 <= day <= season.lengthDays`.
Day 0 is refused because it is the deal, not a tick — and a negative day is refused
because `DELETE FROM states WHERE day >= -1` would take the deal with it.

**`--assemble-missing` is required to replay a day that was never ticked.** A
missed day has no `tick_context` row, because that row is only written by a tick
that ran — so `tick:rerun` alone has nothing to replay, and the day-clock guard
refuses every subsequent night until the gap is filled. Without this flag the
season is bricked short of hand-written SQL, which "Goals" lists as the thing to
avoid.

With the flag, the rerun assembles the context fresh from `orders`,
`order_wagers`, `loadSlate`, `loadSettlements` and `dailyApprovals`. That is
non-deterministic in exactly the way the `tick_context` section argues against —
**and that is fine here, because there is no original tick to reproduce.** It logs
loudly that approvals and settlements are as-of-now rather than as-of-that-night,
and records the assembled context so any *later* rerun is deterministic.

The droplet account is the credential for this command, as the original spec
requires for admin paths. It must not grow a web route without one.

System errors propagate. "Invalid orders never throw" is a rule about order
validation, and must not become "engine and database errors are swallowed and the
tick is marked successful."

## Transaction composition

SQLite has no nested transactions: a `BEGIN IMMEDIATE` inside another raises
"cannot start a transaction within a transaction". Several operations here compose
— `season-init` wraps a season row, a seed and a day-0 state; the tick wraps
assembly, `resolve` and two inserts — so ownership has to be explicit.

The store gains one `transaction(fn)` helper that owns `BEGIN IMMEDIATE` / `COMMIT`
/ `ROLLBACK` and throws if called re-entrantly. **Every other store method is
statement-only** and never opens a transaction of its own. `publishSlate`
(`src/store/sqlite.ts:78`) and `migrate` (`src/store/schema.ts:110`) predate the
helper and keep their own transactions; neither is called from inside another.

## Season initialization

```
npm run season:init -- 2026-09-01 --seed 4711
```

- **Factions come from the roster table** that Plan 3 built. One Slack user per
  faction is already enforced there.
- **Colors** are assigned from a fixed palette by sorted faction id.
- **The shuffle is seeded and the seed is stored** in the new `seasons.seed`
  column. The engine holds no randomness by design, so the shuffle happens here.
- **The territory list and the map are arguments**, defaulting to `RISK_MAP`.
- **It refuses before writing anything** if a day-0 state exists or the roster is
  outside `[MIN_FACTIONS, MAX_FACTIONS]`. The existing `upsertSeason`
  (`src/store/sqlite.ts:67-71`) silently overwrites `start_date` and `length_days`
  on conflict, which would shift every calendar-keyed day under a live season.
- **The whole deal is one transaction** — season row, seed and day-0 state
  together. A partial init leaves a season configured with no board.

`MIN_FACTIONS = 4` and `MAX_FACTIONS = 15` are **new constants**; no faction bound
exists in the codebase today.

`season-init` additionally enforces a **two-sided** bound on the deal:

```
MIN_TERRITORIES_PER_FACTION (5) <= floor(t / f)   and   ceil(t / f) <= 11
```

An earlier draft had only the upper bound and claimed it caught "a 15-member roster
dealt onto the 42-territory default". It does not: **42 / 15 = 2.8**, and `2.8 > 11`
is false, so that season would have been accepted — twelve factions with 3
territories and three with 2.

The rationale was wrong too, and is corrected in "The board scales with the roster":
2.8 territories per faction does **not** differ from 7.0 on income — `max(5,
floor(t/2))` is flat 5 across the whole range, and the design *intends* the deal to
sit at the floor. What actually breaks at 2.8 is that a 2–3 territory faction holds
6 troops at the deal and is eliminated by one focused attack, and that no continent
is ever attainable. That is what the lower bound guards.

The upper bound is `ceil(t / f) <= 11` rather than `t / f <= 11` because
`createSeason` deals round-robin (`src/engine/setup.ts:27-30`), so the largest
holding is `ceil(t/f)`. The two are equivalent when `f` divides `t` and the ceiling
form is correct otherwise.

An **empty territory list is rejected** explicitly. It passes every ratio test
(`0 / 4 = 0`), and would deal a board where every faction holds nothing:
`territoryIncome` returns 0 (`src/engine/income.ts:13`), so nobody ever earns, and
every faction is simultaneously "eliminated" so every faction may `protect`
(`src/engine/validate.ts:118`).

### `createSeason` needs a map argument

`createSeason` takes an arbitrary territory list but writes `map: RISK_MAP`
unconditionally (`src/engine/setup.ts:37`). Passing a larger list yields a state
where `validateOrder` builds adjacency from the 42-territory map
(`src/engine/validate.ts:26`) and rejects every attack touching the rest, while
`continentBonusesFor` iterates Risk's six continents. The board is silently
unplayable with no throw.

This spec owns the fix because it owns `season-init`: add an optional trailing
`map: GameMap = RISK_MAP` parameter. All **50** existing 3-argument call sites
across **11** files keep compiling (a `grep` for `createSeason(` totals 51, but one
of those is the declaration at `src/engine/setup.ts:20`).

The invariant is **set equality**, not length: `map.territories` and the shuffled
territory list must contain the same ids. Length equality catches the 42-vs-N
regression, but if a season deals a subset of a larger map, every undealt territory
still appears in `state.map.territories` — so `validateOrder` builds adjacency that
includes it (`src/engine/validate.ts:70`), an attack into it passes validation, and
combat then reads `garrisons[t]` for a territory that has no entry. A test asserts
the sets match.

## Order entry

```bash
npm run order -- f1 --file order.json     # or: ... --stdin  < order.json
npm run wager -- f1 --file wager.json     # market id, side and stake
```

Neither command takes free text as a shell argument. `npm run X -- args` composes a
string executed by `sh`, and both the order body *and the market id* are
third-party text: a Kalshi ticker is accepted with no character validation beyond
`trim()` (`src/adapters/kalshi/parse.ts:101-103`), so a ticker containing `;`,
backticks or `$(…)` survives ingest, lands in `slate_markets.market_id`, is
rendered into the Slack slate, and is then copy-pasted onto a command line by the
operator.

**`market_id` is validated at ingest** against `^[A-Za-z0-9._-]{1,64}$` and rejected
otherwise, the same treatment `QUESTION_MAX_CHARS` (`src/config.ts:40`) already
gives Kalshi's question text. Note `seriesOf` (`src/adapters/kalshi/parse.ts:53-56`)
slices on the first `-` with no validation either.

Both write through the same `saveOrder` / `saveWager` path the web app will use.
`factionId` is a positional argument here and a session lookup there; in neither
case does it come from the order body.

The CLI validates JSON shape, rejects unknown fields, and caps array lengths with
stated numbers — `deploys` and `attacks` at the territory count of the season's map,
`wagers` at `SLATE_MAX` (5, `src/config.ts:6`). `orders.body` is unbounded `TEXT`
and flows straight into `tick_context.orders`, so an uncapped array is a storage
amplifier as well as a recap flood. It does **not** validate against game rules —
the engine owns that, and its rejections surface in the recap.

**Phase limitation, stated because the original design calls secrecy load-bearing
twice:** whoever has the shell can submit as any faction and can read every
faction's deploys and attacks — and their `protect` picks — straight out of SQLite.
The deploys and attacks are the bigger leak: `protect` is only legal for an
eliminated faction (`src/engine/validate.ts:117-119`), while every living faction's
whole plan is readable every night. The CLI path is
for solo testing and balance work. **A competitive season does not start on it** —
either the web app's session-derived `factionId` exists first, or the operator is
not a player.

## Season length

`SEASON_LENGTH` drops from 21 to 14. A 21-day season runs long for a group this
size, and the closest commercial analogues — Neptune's Pride (up to 8 players) and
Subterfuge (up to 10) — settle around a week at high player counts.

**There are two length constants and both change.** `SEASON_LENGTH`
(`src/config.ts:2`) is read only by the jobs CLI; the simulator has its own
`SEASON_DAYS` (`src/sim/run.ts:18`). Changing one leaves the simulator measuring
21 days forever, so every future balance run would be silently unreproducible.
`src/sim/run.ts` imports `SEASON_LENGTH` and `SEASON_DAYS` is deleted;
`src/sim/run.test.ts` and the `src/config.ts:1` docstring follow.

**The measurement is committed with the change, and the roster is named.** A
2,000-season run over `Turtle, Blitz, GymRat, Slacker, Gambler, Arbitrageur` — the
default roster at `src/sim/cli.ts:3-7` — moves the day-3 leader's conversion from
**32.3% ± 1.0** at 21 days to **36.3% ± 1.0** at 14, with the exploit prober near
zero throughout.

Those figures do not match the committed `2026-08-09-balance-run.md` (19.5% /
0.1%), and an earlier draft attributed that to code drift. **That diagnosis was
wrong: it is a roster difference.** The committed run used *Blitz, Consolidator,
Hunter, Slacker, GymRat, Gambler*; the CLI default swaps `Consolidator` and
`Hunter` out for `Turtle` and `Arbitrageur`. `Arbitrageur` wins ~0.1% of seasons,
so the effective field is nearer five than six and pure chance rises from 16.7%
toward 20% before any game effect. The two numbers were never comparable.

The precision is stated because it is easy to over-read: at n = 2000 and p ≈ 0.33,
SE = √(0.33·0.67/2000) ≈ 1.05 pp, so a 4.0 pp difference is about 2.7σ — a real
effect, but the true interval is ±1.0 pp, not the ±0.05 pp that one decimal place
implies.

**+4 points is judged acceptable.** The direction is against the spec's stated goal
(a shorter season makes the day-3 leader more decisive), so it is a trade rather
than a free win: 36.3% against a ~20% chance baseline is well short of "the day-3
leader *usually* wins", which is the threshold the original spec set.

`lengthDays` is stored per season, so the constant only affects seasons dealt
afterwards.

## Testing

1. **Lock behaviour.** `saveOrder` after 21:00 is rejected; after a state row
   exists is rejected; for a `day` outside `[1, lengthDays]` is rejected. A wager is
   rejected when its `close_time` has passed, when it settled early with
   `close_time` still ahead, when it is not on today's slate, and when the day has
   resolved. **A wager on an open, unsettled market is accepted** — the NULL case
   two natural implementations of the lock get backwards. **A `close_time` in
   `+00:00` form and a date-only `close_time`** each lock at the right instant,
   pinning the normalization.
2. **The single transaction.** A `resolve` that throws leaves **no** `states` row,
   **no** `tick_context` row, and orders untouched; the next run resolves normally.
   Two concurrent runs produce exactly one state row, one recap and zero errors —
   the second returns `already-run`. A second run *after* a saved state returns
   `already-run` (the sequential case).
3. **Order assembly.** Zero-stake rows never reach the engine — assert the recap
   contains no `bad stake` rejection after one is written directly. A faction with
   wagers but no order body gets a synthesized `Order`. Wagers are ordered by
   `first_staked_at`, and two wagers written in the same second still order
   deterministically (millisecond precision).
4. **Tick assembly.** `DailyContext` carries the day's slate, both `approvals` and
   `postedToday`, and **settlements for the union of today's slate and every market
   with a pending wager** — a wager placed three days ago on a market absent from
   today's slate must still settle. A day with no slate resolves as plain Risk.
5. **The day clock.** One test per row of the guard table, **including
   `after-season`**: with `lengthDays = 14`, a missed day-14 tick observed on day 15
   refuses rather than skipping. Plus an early manual run before 21:00 refuses.
6. **Rerun determinism.** Replay produces an identical state **after mutating the
   world**: add a settlement row, `deletePost` a post, and `removeApproval` a
   reaction between the original tick and the replay. Without the recorded context
   this fails; with it, it passes.
7. **Rerun mechanics.** Deletes only from the named day forward; recaps carry the
   correction flag; no `--confirm` deletes nothing; day 0, a negative day, a
   non-integer and a day past `lengthDays` are all refused; a recorded
   `engine_version` differing from the running one logs and **proceeds**.
8. **`--assemble-missing`.** A day that was never ticked has no `tick_context`;
   `tick:rerun` without the flag refuses, and with it assembles fresh, replays, and
   writes a `tick_context` so a later rerun is deterministic.
9. **Recap idempotency.** A second `postRecap` for the same `(day, kind, attempt)`
   posts nothing. A post that fails *after* the ledger insert is recoverable with
   `--force`, which inserts a new attempt. A second correction for the same day
   posts.
10. **Season deal.** Same seed produces the same board. The roster drives the
    faction list. Refuses on: an existing day-0 state; a roster outside
    `[MIN_FACTIONS, MAX_FACTIONS]`; **too few territories per faction — the default
    42-territory map with a 15-member roster, which is the real-world case**; too
    many (`ceil(t/f) > 11`); and an empty territory list. A season dealt on a
    non-default list produces a state whose `map.territories` is the **same set** as
    the list.
11. **No network.** Enforced, not asserted: a vitest `setupFiles` stubs
    `globalThis.fetch` to throw.
12. **Ingest hardening.** A Kalshi ticker containing shell metacharacters is
    rejected at parse rather than reaching `slate_markets`.

## Surfaces this change touches

Enumerated because a sweep found each of these and none was listed:

| Surface | Change |
|---|---|
| `src/store/types.ts:3-7` `SeasonRow` | gains `seed`; `currentDay(season, now)` consumes it |
| `src/store/sqlite.ts:53-65` `season()` | must select `seed` |
| `src/store/sqlite.ts:67-73` `upsertSeason` | 3-column insert; cannot write the seed, and silently overwrites `start_date`/`length_days`. `season-init` gets an insert-only method instead |
| `src/jobs/cli.ts:58-66` | `season-init` is positional today — `Number(process.argv[4] ?? SEASON_LENGTH)`, so `--seed 4711` lands in `argv[4]` and yields `NaN` for `lengthDays`. Argument parsing is respecified and `NaN` rejected |
| `src/jobs/cli.ts:108-112` | the `unknown command` list gains `tick`, `tick-rerun`, `recap`, `order`, `wager` |
| `package.json` scripts | `tick`, `tick:rerun`, `recap`, `order`, `wager` do not exist |
| `src/config.ts:1-2` | `SEASON_LENGTH` and its "21 days" docstring |
| `src/sim/run.ts:18,71,74,138` | `SEASON_DAYS` deleted in favour of importing `SEASON_LENGTH` |
| `src/sim/run.test.ts:7,9` | hardcode 21 in the title and the assertion |
| `src/adapters/kalshi/parse.ts` | `close_time` normalized to `toISOString()`; `market_id` character-validated |
| `deploy/README.md:11,16-19` | the new tick unit and its reliance on the system `TZ` |
| `docs/…/2026-08-09-riskety-rekt-design.md:110-119` | declares `claimTick(seasonId, day): Promise<boolean>`; this design removes `claimTick` entirely, and the real store is synchronous (`DatabaseSync`) |
| `docs/…/2026-08-09-riskety-rekt-design.md:164,173` | still says "4–6 factions" and "21 days" |

## Deployment

A `riskety-tick.timer` and `.service`, at 21:00 America/New_York. **No tick unit
exists today** — `deploy/` carries only the slate publisher, the settlement poller
and the Slack bot.

`OnCalendar=*-*-* 21:00:00`, relying on the **system** timezone exactly as the
existing units do. An earlier draft said the timezone was "named explicitly,
matching the existing units" — it is not: `deploy/riskety-publish-slate.timer`
names no timezone and depends on `TZ=America/New_York`, documented at
`deploy/README.md:16-19`. (systemd has no `Timezone=` directive; a zone goes inline
as `OnCalendar=America/New_York *-*-* 21:00:00` and needs systemd ≥ 252. Not worth
the version floor when the system TZ is already pinned — but `deploy/README.md`
gains a line for the new unit.)

`Persistent=true` fires one catch-up run after a boot.

**The tick unit sets no `Restart=`.** The publish job justifies its
`Restart=on-failure` in its own comment — "an early failure still leaves 13 hours
before the 21:00 lock" — and the tick has no such headroom. More importantly, one
of its stop conditions is *permanent*: the missed-day refusal's predicate does not
change with time, so `RestartSec=300` would restart every five minutes all night,
reopening the database and writing a stack trace each time, and systemd's default
start-limit never trips at that rate. The refusal exits 0 with a loud log and a
Slack note instead, and a genuine crash waits for tomorrow's timer — by which point
the day-clock guard reports the gap.

## Spec deltas

Recorded against `2026-08-09-riskety-rekt-design.md` so they are not re-litigated.

| Original spec | This design | Why |
|---|---|---|
| 21-day season | 14 days | A larger group over 21 days runs long. Measured effect on early decision is +4 points, committed alongside the change. |
| 4–6 factions | 4–15, plus a `territories / factions ≤ 11` check | The Slack group is 15. `MIN_FACTIONS` and `MAX_FACTIONS` are **new** constants — no faction bound exists today. |
| Standard 42-territory Risk map | a board of ~15 continents of *varying* size, dealt one continent per faction, in its own spec | 42 territories at 15 factions is 2.8 each: not an income problem (2.8 and 7.0 both sit at the floor of 5, by design) but an elimination one — 6 troops at the deal dies to one attack, and no continent is reachable. Variable sizes preserve a cheap continent so `Consolidator` play survives. |
| `Store.saveOrder(…, orderBody)` | split into `saveOrder` and `saveWager` | Deploys and wagers lock on different clocks. |
| `claimTick(seasonId, day): Promise<boolean>` | removed; claim, `resolve` and save are one synchronous transaction that also records `orders` and `DailyContext` | Two phases could not distinguish a dead attempt from a live concurrent one. Approvals are not reconstructable after the fact, so replay determinism requires recording, not filtering. |
| the tick's day is implicit | derived from the calendar, with an explicit skew guard | Every other component is calendar-keyed; a second clock shears permanently after one missed tick. |
| Slack OAuth for the web app | a `/login` slash command that DMs a magic link | The slash command payload carries a signature-verified `user_id`. Specified with the web app. |

## Deferred

- **Rate limiting and revision caps.** Session properties.
- **Wager mutation policy** — decided with the pricing model, in the wager-economy
  spec.
- **The wager economy, the map, the renderer, the projection, the web app.**
  Separate specs.
- **A `Ghost` sim policy** that posts nothing and plays weakly, to give the
  elimination-veto post gate real coverage. `Slacker` is the only zero-post policy
  and it is never eliminated.

## Blockers on a real season

Neither blocks this spec. Both block dealing a competitive season.

**The wager economy has two open exploits**, both found in shipped code by review
of this design:

1. **Deploy-inflation voids a losing wager for free.** Deploys are budgeted before
   wagers (`src/engine/validate.ts:41,106`) and dropped wagers never leave the
   reserve (`src/engine/resolve.ts:71-88`). Inflating deploys at 20:59 drops an
   already-locked wager at zero cost, hours after its outcome is public — and the
   check is sequential-greedy, so the player chooses *which* bets die.
2. **Late placement at the stale 08:00 price is roughly +94% EV.** Prices are
   snapshotted once at publish and markets stay open for hours. Staking at 19:00 on
   a market that has moved from 0.55 to 0.97 pays about 2.0× at ~97% probability.
   It strictly dominates every other use of a reserve — the property the design
   rejected when it banned the both-sides hedge.

The adopted fix is **periodic price snapshots written by the existing 30-minute
poller, with `escrow` taking the snapshot in effect at placement time.** The tick
still touches no network. That also bounds the early-settlement gap, and it is why
the correction window is not built here.

**15 factions have never been simulated.** Every balance number this project has
comes from six policies on the 42-territory board. The map spec ships with a
balance run at full headcount, which should expect to find things — notably
elimination volume (the veto was tuned when at most a couple of players could be
dead at once; note it is a *parity* rule, so overlapping picks cancel and coverage
is below the naive bound) and decisiveness (a 14-day season on a larger board may
end bunched, pushing weight onto the `garrisons + reserves` tiebreak, which is
exactly where banked IRL soldiers land).
