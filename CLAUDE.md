# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                  # vitest run — 368 tests, none touch the network
npm test -- src/engine/combat.test.ts     # a single file
npm test -- -t "largest surviving force"  # a single test by name
npm run test:watch
npm run typecheck                         # tsc --noEmit
npm run sim                               # 2,000-season balance run, ~2s
npm run sim -- Slacker Blitz GymRat       # custom policy roster
npm run sample:kalshi                     # re-derive VOLUME_FLOOR from live data (hits the network)
```

Nothing is compiled or bundled — `tsx` runs TypeScript directly.

Jobs and the bot need `RR_DB_PATH` and `RR_SEASON_ID`; the bot adds the four
`SLACK_*` variables. An empty string counts as unset everywhere on purpose.

```bash
export RR_DB_PATH=./riskety.db RR_SEASON_ID=season-1
npm run season:init -- 2026-09-01   # the date is the day-0 deal
npm run publish-slate               # the 08:00 job
npm run poll-settlements            # the 30-minute job
npm run roster:add -- U01ABCDEF f1 "Ada L."
npm run slack                       # long-running events bot, PORT default 3001
```

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

**The 21:00 tick never touches the network.** Slack approvals arrive
continuously by webhook and market settlements are written by a 30-minute poller,
both landing in SQLite hours earlier. A Kalshi outage at 20:59 cannot stall the
season. Keep new work on that side of the line.

**Everything is one function**: `resolve(state, orders, context) → GameState`.
Seven steps, with order validation deliberately sitting *after* steps 1–3.

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
- **Settlement is credit-only.** The stake left the reserve at escrow; "credit or
  debit" charges losers twice. Payout uses `round`, not `floor`.
- **`protect` is filtered inside the engine**, on both `postedToday` and zero
  territories in the *input* state. The golden file only pins what crosses the
  engine boundary, so moving that filter into a caller would let a regression
  replay green forever. The veto gates on posting, not approval — otherwise
  players have a concrete reason to withhold a 👍 from someone whose veto they
  fear.
- **An approved action is derived, never stored.** The store holds raw posts and
  reactions; `dailyApprovals` computes it at read time. Storing approvals makes
  `reaction_removed` a state machine.

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
- **`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are both on.**
  Expect `!` and `?? 0` at territory and faction lookups; pass optional fields by
  spreading a conditional object, never as an explicit `undefined`.
- **The golden file pins engine behavior via a fixed order script**, not sim
  policies — tuning a policy must not break the engine's regression test.
- Jobs take `now: Date` as a dependency rather than reading a clock.
- Never call `process.exit()` with the store open; it skips the `finally` and
  leaves a WAL file behind.

## Not built

The 21:00 tick runner and the web UI. Nothing outside `src/sim/` calls
`resolve()`, and `runPostRecap` has no caller. Design:
`docs/superpowers/specs/2026-08-10-tick-runner-and-orders-design.md`.

The tick runner must call `dailyApprovals(store, seasonId, day)` for **both**
`context.approvals` and `context.postedToday`, then `runPostRecap` after saving
state — in that order, so a Slack outage cannot stall a tick.

## Docs

| File | What it is |
|---|---|
| `docs/superpowers/specs/2026-08-09-riskety-rekt-design.md` | The spec. Every rule, and why it is that rule. |
| `HANDOFF.md` | Current state and the full list of rules a newcomer gets wrong |
| `docs/superpowers/reviews/2026-08-09-balance-run.md` | What 2,000 simulated seasons say about the economy |
| `docs/superpowers/plans/` | Each carries a "Spec deltas" section recording where reality corrected the design |
