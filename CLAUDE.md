# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                  # vitest run — 1,034 tests, none touch the network
npm test -- src/engine/combat.test.ts     # a single file
npm test -- -t "largest surviving force"  # a single test by name
npm run test:watch
npm run typecheck                         # tsc --noEmit
npm run sim                               # 2,000-season balance run, ~7s
npm run sim -- Slacker Blitz GymRat       # custom policy roster
npm run sim:rules                         # the per-rule bounded-swing gate, 10k/arm (~20 min)
npm run sim:rules -- 200                  # a smoke run
npm run sim:balance                       # the committed run: authoritative six, then + Swarm/Ghost
npm run sim:balance -- 10000 Swarm Swarm Swarm Swarm Swarm Swarm   # a symmetric roster
npm run sim:balance -- 10000 --shuffled   # the pre-`ec692fd` scattered deal arm
npm run sample:kalshi                     # re-derive VOLUME_FLOOR from live data (hits the network)
```

Nothing is compiled or bundled — `tsx` runs TypeScript directly.

Jobs and the bot need `RR_DB_PATH` and `RR_SEASON_ID`; the bot adds the four
`SLACK_*` variables. An empty string counts as unset everywhere on purpose.

```bash
export RR_DB_PATH=./riskety.db RR_SEASON_ID=season-1
npm run roster:add -- U01ABCDEF f1 "Ada L."   # do this BEFORE season:init
npm run season:init -- 2026-09-01 --seed 4711 # deals day 0 from the roster
npm run publish-slate                         # the 08:00 job
npm run rules:publish                         # the 08:05 rule-vote offer
npm run poll-settlements                      # the 30-minute settlement job
npm run poll-prices                           # the 30-minute price job
npm run tick                                  # the 00:05 job (resolves the day that just ended)
npm run modules:set -- markets irl veto       # mid-season module change; refuses while escrow > 0
npm run order -- f1 --file order.json         # or --stdin; never a shell argument
npm run wager -- f1 --file wager.json
npm run recap -- 5 --force                    # re-post a recap the ledger suppressed
npm run tick:rerun -- 5 --confirm             # replay day 5 onward from tick_context
npm run slack                                 # long-running events bot, PORT default 3001
npm run web                                   # the player app, PORT default 3002
npm run build:shapes                          # regenerate src/map/shapes.ts AND src/map/adjacency.ts
npm run map:resync                            # plan a frozen-map fix for the live season; --confirm writes
```

**Exit codes are three-valued**: 0 success or a deliberate skip, 1 a system
failure worth a systemd retry, 2 an operator mistake or a write the rules
rejected. A tick **refusal exits 0** — its condition never clears with time, so
a non-zero exit would restart-loop all night under `Restart=on-failure`.

Exit 2 only stops a retry because every retrying unit carries
**`RestartPreventExitStatus=2`** — `Restart=on-failure` restarts on *any*
non-zero status, so the third code was documented but inert until that line
existed. An **unknown season is a `UsageError`** (exit 2) in every job module
for the same reason: a misconfigured `RR_SEASON_ID` threw a plain `Error`, exited
1, and restart-looped the tick 778 times on the live droplet.

`npm run publish-slate` late in the ET day legitimately publishes nothing. Judge
it by an 08:00 run.

## Architecture

Read `codemaps/` first — `architecture.md`, `engine.md`, `data.md`,
`integrations.md`, `jobs.md`. They are generated; edit the code, not the maps.

The shape that matters:

**`src/engine/` is pure and imports nothing outside itself.** No I/O, no clock,
no randomness, input state never mutated. `src/engine/types.test.ts` enforces the
import boundary and bans `Date.now()`, `Math.random()` and `new Date()`. Time and
randomness enter as arguments — `createSeason` takes an already-shuffled
territory list, the tick takes a `DailyContext`. If you want a clock inside the
engine, the answer is a new field on `DailyContext`.

That purity is why `src/sim/` can run thousands of seasons, and the simulator is
the only evidence the economy isn't broken. Do not weaken it.

**The midnight tick never touches the network.** Slack approvals arrive
continuously by webhook and market settlements are written by a 30-minute poller,
both landing in SQLite hours earlier. A Kalshi outage at 23:59 cannot stall the
season. Keep new work on that side of the line.

**Everything is one function**: `resolve(state, orders, context) → GameState`.
Mechanics (markets, IRL, veto) are modules dispatched through fixed hooks — the
pipeline, hook contract and module table live in `codemaps/engine.md`. Two
orderings are load-bearing and deliberate: order validation sits *after* the
grant phase (income earned this tick is spendable this tick), and the reserve
allocation — ascending parsed `lockedAt`, the earlier-locked commitment senior —
resolves *before* movement caps, so a dropped deploy shrinks the attack cap it
fed rather than leaving phantom troops legal.

**The tick's claim, resolve and save are ONE transaction.** There is no lock
table, and adding one back would reintroduce the ambiguity it was removed for:
after a two-phase freeze, "context exists" means either *a previous attempt
died* or *another process is resolving right now*, and adopting on that signal
lets two runs both resolve. `store.transaction` is the only thing in the store
that opens a `BEGIN` — `migrate` is the single documented exemption.

**Every component derives the day from the calendar**, through `currentDay` in
`src/season.ts`. A second, state-derived clock ("highest saved day + 1") agrees
only while no tick is ever missed, and shears permanently after one miss.

**The boundary is the midnight ENDING a season day, and the tick resolves
`calendarDay - 1`.** `tickInstant(season, day)` is hour 0 of `startDate + day +
1` — the `+ 1` is the whole thing, and reading it as "midnight starting day N"
puts the deadline before the day it closes. Because the job fires *at* the
boundary, `currentDay` has already rolled by the time it runs, so `runTick`
resolves the day that just ended. Every guard in that table is written against
`day`, never `calendarDay`; the after-season one especially, since the final
tick of the season runs when `calendarDay` is already `lengthDays + 1` and a
`calendarDay > lengthDays` test skips the last night silently. `before-cutoff`
is now unreachable and kept deliberately.

This is inherent to alignment rather than to midnight: at any hour where the
deadline and the rollover coincide, the job wakes in the day after the one it
must resolve. The alignment is what makes every workout fall into exactly one
day — while the tick ran at 21:00, `postsOn(date)` collected the whole ET date
and the cutoff discarded three hours of it, and that hole was unfixable, because
the approval cutoff is structurally bounded above by the tick instant.

**The timer runs at 00:05 while the cutoff stays frozen at 00:00.** Five minutes
of Slack delivery grace; `tickInstant` is calendar-derived and does not move with
the timer. Deploy order is directional — code before timer. The reverse stalls
the season (`before-cutoff` skips at 00:05 under old code, and no 21:00 run is
left).

**`backfillContext` pins the legacy 21:00, never the live `tickInstant`.** A
frozen context missing the field predates the change by definition, and rerun
saves the synthesized context back — replaying through today's formula would
launder midnight into frozen history. Same hazard as its hardcoded module list.

## Rules that are load-bearing and counterintuitive

Most exist because a reviewer or a simulation found the obvious alternative was
exploitable. Full list with reasoning in `HANDOFF.md`; the ones most likely to be
"simplified" away:

- **One wager per market per faction.** Both sides of one market at `k·p` and
  `k·(1−p)` returns `1.1k` on an outlay of `k` regardless of outcome — risk-free
  +10%/day, 7.4× over a season.
- **Orders validate after pipeline steps 1–3.** Income earned this tick is
  spendable this tick; validating against yesterday's reserve rejects every
  deploy from a faction that started at zero.
- **Casualties total exactly `D`**, split pro-rata by largest-remainder rounding.
  Applying the full defense against each attacker independently breaks troop
  conservation.
- **Mutual attacks: the smaller force dies, the larger continues at `a − 2·min`.**
  The symmetric rule let a 1-troop feint void a 100-troop assault, and the map
  froze within days.
- **A wager is priced when it is PLACED, not at the tick.** The published slate
  is frozen at 08:00 so a rerun cannot re-snapshot it, and that freeze is what
  made a 20:59 wager on a nearly-decided market worth roughly +94% EV. Live
  prices live in `market_prices`, refreshed every 30 minutes; `order_wagers`
  records the price at save time and `escrow` prefers it. Re-staking re-prices,
  or a player could take the morning's odds and switch sides once the outcome
  was clear. A residual remains: `payout` clamps price to [0.1, 0.9], so a
  market that moved to 0.95 pays at 0.9 and a near-certain late wager returns
  about +16% rather than +10%. Bounded, symmetric, and down from +422%.
- **Settlement is credit-only.** The stake left the reserve at escrow; "credit or
  debit" charges losers twice. Payout uses `round`, not `floor`.
- **A settled wager has THREE outcomes, not two.** A market that never settles
  refunds the stake after `REFUND_AFTER_TICKS`, emitting `outcome: "unsettled"`
  with `payout === stake`. Classifying on `payout > 0` alone reports that as a
  win. `outcome === "unsettled"` is the discriminator, and **both** surfaces
  follow it — `recap.ts` and `replay-data.ts`. They render the same event, so
  when only one had the rule the board called a refund winnings while Slack
  called it a wash.
- **`wagerSettle.faction` and `.marketId` are OPTIONAL, and that is about
  persisted rows.** The engine always emits them; states written by engine
  1.0.0 do not have them, `parseState` never inspects log elements, and
  `npm run recap -- <day>` renders the persisted log. Declaring them required
  was a type-level lie that crashed the recap on every pre-1.1.0 day in the
  live database while typecheck and the whole suite stayed green. Any future
  event-shape change has the same hazard: **the data already on disk was
  written by the old engine, and only the paths that re-render it will tell
  you.**
- **The recap's Markets section names players; the replay's bank does not.** A
  settled wager is past, so naming it publicly discloses no position anyone can
  still trade against, and the recap already publishes reserves and attacks per
  player. A replay is one viewer's projection, so banking a payout under
  `e.faction` instead of `markets` would put every other player's wagers on
  their screen.
- **`protect` is filtered inside the engine**, on both `postedToday` and zero
  territories in the *input* state. The golden file only pins what crosses the
  engine boundary, so moving that filter into a caller would let a regression
  replay green forever. The veto gates on posting, not approval — otherwise
  players have a concrete reason to withhold a 👍 from someone whose veto they
  fear.
- **An approved action is derived, never stored.** The store holds raw posts and
  reactions; `dailyApprovals` computes it at read time. Storing approvals makes
  `reaction_removed` a state machine.
- **So is the day's rule.** `rule_reactions` holds RAW numeral reactions and the
  tally derives the winner at midnight. It is a separate table from `reactions`
  because that one cannot represent a vote: no emoji column, one row per player
  per message, and `INSERT OR IGNORE` first-timestamp-wins — votes are
  latest-wins. **The cutoff predicate is two-part**: a row counts only if it is
  present when the tick's transaction reads AND `reacted_at <= tickInstant`, or
  a delayed tick counts votes cast after midnight.
- **Rule *selection* is frozen in `ctx.rules`; rule *behavior* is engine code.**
  A rerun replays the frozen id, never a re-derived tally — deleting the votes
  afterwards cannot change the replay. Behavior drift is `engineVersion`'s
  concern, exactly like every other engine change; there is no second
  versioning scheme.
- **An unmapped numeral is dropped at ingest, never stored.** `nine` on a
  three-candidate day must not become a player's "latest" reaction and silently
  void their valid earlier vote.

Check the spec's **"Rejected review findings"** section before acting on a change
that seems obviously right — it may already have been considered and declined.

## Conventions and traps

- **Never edit a shipped migration** in `src/store/schema.ts`; append a new one.
- **`node:sqlite` is loaded via `createRequire`, not a static import.** Vite's
  builtin detection strips the `node:` prefix and the module exists under no
  other name, so a static import breaks every store test. Rows come back with a
  `null` prototype — spread them. The `ExperimentalWarning` is expected.
- **Bolt's `App` is always built with `deferInitialization: true`.** Without it
  the constructor calls `auth.test` and every test that builds an app becomes a
  network test.
- Only `src/slack/app.ts` imports Bolt and only `src/slack/post.ts` imports the
  Web API client. Keep the rest of `src/slack/` pure — that is what keeps the
  suite offline. Block Kit types are declared structurally rather than imported
  for the same reason.
- **`factionId` never comes from a request.** `sessionFactionFor` is the only
  way a request acquires one, and it reads nothing but the session cookie — no
  body, no query string, no other cookie.
- **Login tokens are stored hashed.** The raw value exists in the DM, the URL
  and the cookie — never in the database and never in a log line.
- **The player page contains only the viewer's projection.** No other faction's
  deploys, attacks or `protect` pick is serialised into the HTML at all. Not
  hidden with CSS — absent. `src/web/board.test.ts` parses it back out and
  asserts it.
- **`src/map/shapes.ts` and `src/map/adjacency.ts` are generated.** Edit
  `scripts/build-shapes.ts` and re-run `npm run build:shapes`; never hand-edit
  the data. Land borders are DERIVED from the drawn topology's shared arcs, so
  the rules and the picture cannot disagree — a hand-authored list beside
  generated geometry drifted into 116 mismatched pairs, including a `gauteng`
  that visibly bordered Botswana and could not attack it. `SEA_LINKS` in
  `world.ts` is the only adjacency still written by hand.
- **A season freezes its map into every `states` row**, so regenerating
  adjacency does NOT reach a running season. `npm run map:resync -- --confirm`
  rewrites the frozen `neighbors` on every saved day, leaving `regions` and each
  `bonus` as dealt; bonuses were computed from the old adjacency and recomputing
  them mid-season would move scoring under the players.
- **`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are both on.**
  Expect `!` and `?? 0` at territory and faction lookups; pass optional fields by
  spreading a conditional object, never as an explicit `undefined`.
- **The golden file pins engine behavior via a fixed order script**, not sim
  policies — tuning a policy must not break the engine's regression test.
- Jobs take `now: Date` as a dependency rather than reading a clock.
- Never call `process.exit()` with the store open; it skips the `finally` and
  leaves a WAL file behind.

## Not built

What is left before a competitive season:

- **A dial for multi-front attack.** The 2026-08-12 run
  (`docs/superpowers/reviews/2026-08-12-balance-run-snowballing.md`) added
  `Swarm`, the first policy to attack on more than one front per tick, and it
  wins **71.4%** against the authoritative five — 4.3× baseline, breaking no
  rule and drawing no cap rejections. The spec's "no dominant strategy"
  property was evidenced against a policy set that all voluntarily attacked
  once per tick. A human finds this on day two. Candidate dials are listed in
  that doc; none has been measured.

- **Snowballing: answered, and it is the deal.** Same run. On symmetric seats
  the day-3 leader converts 36.5%–42.0% against a 16.7% baseline regardless of
  policy, so the 39% is real rather than a weak-roster artifact — but
  scattering the starting holdings drops it by ~14–16 points, while giving
  every seat multi-front capability moves it by 3. The contiguous deal
  (`ec692fd`), not combat and **not** troop movement, is the lever. Whether to
  pull it is a design call.

  Partly narrowed since. `58cbfa6` stops the deal opening a season with a
  region already held whole — it did so on 80–90% of boards, and live season-1
  dealt +4/+2/+2 against a base of 5 — which moves the authoritative six from
  **39.0% to 37.4%**. Real but small: a day-1 fairness fix, not a snowballing
  fix, and the 14–16 points still sit in the contiguous deal itself. The
  2026-08-12 run's 39.0% now describes the pre-`58cbfa6` deal.

## Docs

| File | What it is |
|---|---|
| `docs/superpowers/specs/2026-08-09-riskety-rekt-design.md` | The spec. Every rule, and why it is that rule. |
| `HANDOFF.md` | Current state and the full list of rules a newcomer gets wrong |
| `docs/superpowers/reviews/2026-08-09-balance-run.md` | Superseded — the original policy/economy run |
| `docs/superpowers/reviews/2026-08-10-balance-run-world.md` | Superseded — describes the game before the contiguous deal (`ec692fd`) |
| `docs/superpowers/reviews/2026-08-11-balance-run-modules.md` | **Current for the module comparison** (verified behavior-identical). Its attribution of the balance drift to troop movement is WRONG — corrected by the 2026-08-12 run |
| `docs/superpowers/reviews/2026-08-12-balance-run-snowballing.md` | **Current.** Strengthened roster (`Swarm`, `Ghost`); multi-front attack is dominant at 71.4%; the day-3 snowball is the contiguous deal |
| `docs/superpowers/reviews/2026-08-11-balance-run-rules.md` | Superseded — the three-rule catalogue, which failed on Blitz (+4.03). Kept for its finding that forced-daily does NOT upper-bound the voted regime |
| `docs/superpowers/reviews/2026-08-11-balance-run-rules-expanded.md` | **Current.** Thirteen rules on a three-slot ballot: PASSES, max movement 1.13 points |
| `docs/superpowers/reviews/2026-08-10-balance-run-14day.md` | Superseded — the 21-vs-14 day measurement behind `SEASON_LENGTH` |
| `docs/map-rendering.md` | The pane stack, what the shape build generates, and the rendering traps that cost a day |
| `docs/superpowers/plans/` | Each carries a "Spec deltas" section recording where reality corrected the design |
