# Midnight tick boundary, and named wager settlement in the recap

**Status:** approved 2026-08-15, to be released mid-season into the live season.

Two changes that were requested together and share one release:

1. The tick moves from 21:00 ET to midnight ET, so the order deadline, the day
   rollover and the IRL approval cutoff become one instant. Every workout falls
   into exactly one day.
2. The recap's Markets section stops being anonymous. Each settled wager gets a
   named line with the stake, the market's question and the outcome.

## Why

Today three things happen at 21:00 — orders lock, approvals cut off, the tick
resolves — and a fourth, the day rollover, happens at midnight. The three hours
between them are dead in a way nothing documents and nobody designed:

- No order or wager can be written at all. `orderGate` refuses day N as
  `past-deadline`, and day N+1 is unreachable because `savePlan` and
  `saveWagerRequest` both pin the target to `currentDay`, which is still N.
- The board sits in a state nothing else in the season produces: `latestSavedDay`
  has become N while `currentDay` still returns N, so `day === state.day` where
  every ordinary hour has `day === state.day + 1`.

  (An earlier draft called that relationship an "invariant" of `projectionFor`
  and said this window was the only thing violating it. That was overstated —
  `server.ts:100-104` documents the opposite outright, because a missed tick
  leaves a gap too and the board is built to render it. The window is a real
  anomaly; it was never the only one.)
- **An IRL workout posted in that window counts for nothing, ever.**
  `postsOn(date)` collects the whole ET date, then `dailyApprovals` discards
  everything after 21:00. Those posts are accepted by Slack, stored, and
  silently dropped. This cannot be fixed while the tick stays at 21:00: the
  approval cutoff is structurally bounded above by the tick instant, because
  the tick has already read the approvals.

Aligning the boundary closes all three. The third is the reason the tick has to
move rather than just the cutoff.

## Non-goals

- The wager pricing window is untouched. A wager is already bounded by its own
  market's close (`market-locked`, `sqlite.ts:583-592`), not by the tick hour,
  so moving the boundary does not widen the late-wager edge CLAUDE.md
  documents.
- **The simulator and golden fixtures keep their synthetic `21:00`.** Their
  `tickInstant` is an opaque string whose only load-bearing property is
  *market close < tick instant* (`simInstant(day, 18)` vs `(day, 21)`).
  "Consistency" edits here would perturb the balance baseline for no behavioral
  reason. Do not touch them.

## 1. The clock

`tickInstant(season, day)` becomes midnight *ending* day N:

```ts
etInstant(etDateAdd(season.startDate, day + 1), 0)
```

`currentDay` is deliberately unchanged. Day N remains the ET date
`startDate + N`, so nothing outside the tick re-learns what a day is.

`TICK_HOUR = 21` loses both consumers and is deleted. It is not replaced with
`TICK_HOUR = 0`: the boundary is "hour 0 of the *next* day", and a bare `0`
invites the reading "midnight starting day N", which is the off-by-one that
makes the whole change wrong.

### The tick's day inverts

`runTick` fires at the boundary and must resolve the day that just ended, so
`day = calendarDay - 1`. Every guard shifts one operand:

| Guard | Today | New |
|---|---|---|
| `owed` | `min(calendarDay - 1, len)` | `min(day - 1, len)` |
| before-season | `calendarDay < 1` | `day < 1` |
| after-season | `calendarDay > len` | `day > len` |
| already-run | `latestSavedDay + 1 > calendarDay` | `latestSavedDay + 1 > day` |
| before-cutoff | `now < tickInstant(calendarDay)` | `now < tickInstant(day)` |

**after-season is the dangerous one.** Left as `calendarDay > lengthDays` it
silently skips the *final* tick, because the last day resolves when
`calendarDay` is already `lengthDays + 1`. Same class as the `missing-days`
ordering bug the existing comment documents, and invisible until day 21.

**before-cutoff becomes structurally unreachable.** `tickInstant(calendarDay - 1)`
is midnight at the start of `calendarDay`, always in the past. Its purpose — a
manual 14:00 run must not resolve an open day — is now served by the derivation
itself, since `calendarDay - 1` always names a day that has ended. Keep it as a
defensive assert. Every guard in that table has a season-breaking bug behind it;
this is not the moment to remove the one that looks redundant.

### Run time vs cutoff

The job runs at **00:05**, with the cutoff frozen at exactly **00:00**. The
architecture already separates these — `tickInstant` is computed from the
calendar and `before-cutoff` only requires `now >= tickInstant` — so this is a
timer setting, not a code path.

The five minutes are Slack delivery grace. A workout posted at 23:59:58 and
delivered at 00:00:03 has a valid `postedAt` but would not be in the table when
the tick's transaction reads, and could not fall into the next day either
because its ET date belongs to this one. This is the same two-part cutoff
CLAUDE.md documents for rule votes.

## 2. The cutoff

`dailyApprovals` stops computing its own cutoff from `TICK_HOUR` and calls
`tickInstant(season, day)`. One source of truth.

Because `postsOn(date)` returns exactly the posts whose ET date is
`startDate + day`, and the cutoff is now midnight ending that date, every post
it returns passes the filter. The discard set becomes empty. Keep the filter as
an invariant guard — `postedAt` is a third-party Slack timestamp.

The *approver* filter stays load-bearing and unchanged in meaning: a 👍 on
yesterday's workout arriving this morning must not count.

### Accepted limit

A workout posted at 23:50 has ten minutes to collect the two distinct 👍s the
+1 soldier needs. The post always lands and always belongs to a day; the
approval may not arrive in time. Structurally identical to a 20:50 post today,
but 21:00 was a schelling point people scheduled around and midnight is not, so
this will bite more often.

Accepted rather than designed around. The alternative — crediting a late
approval to the next day — makes a workout pay out a day after it was posted,
which is more confusing than a missed +1. The veto is unaffected: it gates on
`postedToday`, which needs only the post.

## 3. Frozen history

`backfillContext` synthesizes `tickInstant` for rows that lack it. It must NOT
follow the live formula, or a rerun of a past day would replay midnight where
the original tick used 21:00.

A row missing `tickInstant` is by definition pre-change, so backfill pins the
legacy formula unconditionally:

```ts
// Frozen history. NEVER the live tickInstant() — a row without this field
// predates the midnight boundary by definition, so 21:00 is unconditionally
// correct for it. Same reason the module list below is a literal.
etInstant(etDateAdd(season.startDate, day), 21)
```

This is the pattern CLAUDE.md already documents for backfill's hardcoded
`["markets","irl","veto"]`. **No schema migration is needed** — contexts written
since `e9934c1` carry `tickInstant` explicitly and are untouched.

## 4. The recap

### Engine

`wagerSettle` gains `faction: FactionId` and `marketId: MarketId`. Both are in
scope at the two emit sites (`wagers.ts:87,98`).

This *removes* code: `markets.ts:38-45` currently builds a `byId` map purely to
recover the faction the event should have carried. The map goes away and the
grant becomes `{ faction: e.faction, amount: e.payout, event: e }`.

Bumps `engineVersion`; regenerates the golden file.

### Three outcomes, not two

The current copy renders a refund as `resolved unsettled — paid 5`, which reads
exactly like a win. A market that never settles is refunded after
`REFUND_AFTER_TICKS = 2` (`wagers.ts:87-90`) with `payout === stake`.

Discriminate off the two existing fields — no `side` needed:

- `outcome === "unsettled"` → refund
- otherwise `payout > 0` → win
- otherwise → loss

### Titles

One query, run by the caller: `SELECT DISTINCT market_id, question FROM
slate_markets WHERE season_id = ?`. Every title published this season. This
avoids window arithmetic over which slate a settling wager came from — day −1
normally, day −2 for a matured refund — and cannot miss the refund case.

Arrives as `marketTitles?: Record<MarketId, string>`, matching the existing
optional-narrow-dep pattern. Falls back to the bare `marketId` when absent, so
fixtures and the simulator keep rendering.

### The `names` bug ships with it

`RecapInput.names` is documented at length as the fix for a renamed player
showing their day-0 name all season — and **nothing ever passes it**.
`PostRecapDeps` has no such field, and `cli.ts:123` supplies `ledger`,
`seasonId` and `ruleIds` from the store but not names. The new lines are
name-driven, so without this every one of them reads the deal-time name.

### Copy

> Sean, you wagered 5 on *Will BTC close above $100k?* — you won. 7 soldiers report for duty.
> Ricky, you wagered 8 on *Will it rain in Seattle?* — you lost. Those soldiers are working it off in the mines.
> Dana, nobody ever called *Will it snow in Miami?* — your 4 came home, no worse off.

`payout` is the gross return; settlement is credit-only and the stake left the
reserve at escrow, so "you receive N" is the payout, not the profit.

Market questions need their own `safeText` cap — they are far longer than names
and will hit `MAX_SECTION_CHARS`. Named per-wager lines are more numerous than
today's anonymous ones, so the section's `…and N more` truncation will fire on
busy days; that degrades honestly and is left alone.

### Privacy

This flips the Markets section from anonymous to named — every player's settled
wagers become public. Deliberate and consistent: the recap already publishes
reserves, attacks and workouts per player, and a *settled* wager is past, so it
leaks no exploitable position. The web app's strictness is about **open**
positions and is unaffected.

## 5. Rollout

**Mid-season, into the live season.**

The crossover is benign in the generous direction. Landing before that day's
21:00 means the next tick fires at the following midnight instead — one
27-hour day, once. Nothing resolves twice and no day is skipped: at 00:05
`currentDay` is N+2, the tick resolves N+1, `latestSavedDay` is N, so
`missing-days` and `already-run` both stay quiet. Landing *after* a 21:00 tick
has already run, the midnight tick sees `already-run` and skips correctly.
Players only ever gain hours; no in-flight order can be stranded.

**Deploy order is directional:**

- Code before or with the timer — safe. A stale 21:00 timer with new code is a
  no-op: it computes yesterday, sees `already-run`, skips, and the day resolves
  at the next 00:05.
- **Timer before code — stalls the season.** The 00:05 run under old code
  computes today, hits `before-cutoff`, skips, and there is no 21:00 run left
  to catch it.

Announce the 27-hour day in the channel.

## 6. Tests

- `season.test.ts` — `tickInstant` is the end-of-day boundary; holds across a
  DST transition on both sides.
- `tick.test.ts` — the full guard table at each edge: first tick, **final tick**
  (the after-season case that would silently skip), a missed day, already-run,
  the sequential double-fire, and the crossover shape
  (`latestSavedDay = N`, `calendarDay = N+2`).
- `approvals.test.ts` — a 23:59 post counts for that day; a 00:01 post falls to
  the next; an approver reacting after midnight does not count.
- `rerun.test.ts` — **backfill synthesizes 21:00, not midnight.** The
  regression that matters most.
- `recap.test.ts` — three outcomes, named lines, title resolution, missing-title
  fallback, long-question truncation.
- `golden.test.ts` — regenerated for the `wagerSettle` shape.

## Spec deltas

- **`WINDOW_CLOSE_HOUR === TICK_HOUR` was a pinned equality the design missed.**
  `config.test.ts` asserted it, and the reason is load-bearing: the publisher
  rejects markets closing at or after `WINDOW_CLOSE_HOUR`, which is what
  guarantees a wager claim's `lockedAt` is strictly earlier than a deploy's
  `tickInstant`. Only the *inequality* was ever the point. The constant stays
  at 21 and the test became `0 < WINDOW_CLOSE_HOUR < 24` — with the boundary at
  hour 24, equality is the wrong shape and raising it to 24 would reopen the
  deploy-inflation exploit for late-closing markets.

- **No golden regeneration was needed, because the golden never covered
  settlement.** The spec said the `wagerSettle` shape change would regenerate
  it. In fact `__golden__/season-1.json` contains zero `wagerSettle` events —
  its log holds only `income`, `protected` and `rejected`. The file's only diff
  was the `engineVersion` string; engine behavior is byte-identical, and
  `npm run sim` reproduced the committed baseline digit for digit (day-3 leader
  47.4%, GymRat 32.9%). **Open gap, not fixed here:** the engine's settlement
  and combat paths are outside the golden regression entirely. Widening the
  golden order script to settle a wager is worth doing and is its own change.

- **The replay's rationale was wrong, though its behavior was right.**
  `replay.test.ts` justified banking payouts under `markets` with "no faction on
  the event". The event has one now, and the behavior must still not change: a
  replay is one viewer's projection, so banking under `e.faction` would put
  every other player's settled wagers on their screen. Comment corrected in
  place.

- **Codemaps were updated surgically rather than regenerated.** The stale facts
  were confined to what this change touched; a full regeneration would have
  churned unrelated content.

## What the review panel corrected

A nine-reviewer panel ran against this branch after implementation. The clock
arithmetic survived unchanged — three reviewers independently re-derived the
guard table across both season lengths, both 2026 DST transitions and the
crossover, and found no error. What it found was elsewhere, and all of it is now
fixed:

- **`recap --force` crashed on every already-resolved day.** Engine 1.0.0 wrote
  `wagerSettle` without `faction`/`marketId`, and that command renders the
  PERSISTED log. Declaring the new fields required was a type-level lie about
  every pre-1.1.0 row in the live database, which is why typecheck and 1,018
  green tests saw nothing. The fields are now optional and the recap falls back
  to the legacy line. **This is the general hazard of a mid-season engine
  change: the data already on disk is written by the old engine, and only the
  paths that re-render it will tell you.**
- **The nightly backup did not move with the tick.** `bootstrap.sh` still fired
  at 21:30 "half an hour after the tick" — 2.5 hours *before* the new boundary,
  snapshotting exactly the unresolved mid-night state its own comment says it
  avoids. Anything whose comment names the tick hour has to be swept, not just
  the tick's own unit.
- **`--assemble-missing` could defeat the delivery grace** by committing a day
  at 00:01, after which the real tick skips it. Now gated on a six-minute
  window, and only for assembled days.
- **The "Last night" link 404'd permanently.** It targeted `p.day` — the day
  being ordered for, which by definition has not resolved. Alignment turned a
  bug that used to hide in the 21:00–midnight window into an all-day one.
- **The deploy-order note in the timer was wrong** in the direction that
  matters: code-without-timer is not a self-healing no-op, it runs the season 21
  hours behind indefinitely and silently.
- **The doc sweep in `cda6b28` was not complete** — a broken README sentence it
  introduced, test counts updated in one file of three, and ~17 in-source
  comments still naming 21:00, including `tick.ts`'s own docstring and two
  stale *numbers* (13h→16h to the lock; the price poller no longer straddles
  the tick).

Rejected from the same panel, recorded so they are not re-litigated:

- **Injecting `day` into `runTick` instead of deriving `calendarDay - 1`.** The
  manual-14:00-run capability this was meant to restore is one the design
  deliberately refuses (`tick.test.ts` pins it), and sourcing the day from the
  scheduler makes the scheduler the clock — the shear CLAUDE.md exists to
  prevent.
- **Deleting the `marketTitles` layer** as unmotivated machinery. The spec
  requires capping question length at a render sink, and the question text is
  the payload the defanging exists for.
- **Deleting the unreachable `before-cutoff` guard.** Retained deliberately;
  see above.
