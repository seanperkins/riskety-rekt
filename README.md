# Riskety Rekt

A Risk-like conquest game played one tick per day, for a private group of friends.

Nobody plays it live. Each day you submit standing orders through a web app, and at
21:00 everyone's orders resolve simultaneously. Combat is fully deterministic — there
are no dice.

Reinforcements come from two places beyond territory income:

- **Real-world actions.** Post a workout photo in Slack; two friends react; you get
  soldiers. This is what makes the game an accountability device.
- **Prediction market wagers.** Stake soldiers on real Kalshi markets closing that day.
  This is what replaces dice — variance you can actually reason about.

A sample of what a day's slate looks like in practice: Bitcoin's close, the price of
gold, a film's Rotten Tomatoes score, a Uruguayan football match, and a WTI crude
settlement.

## Where to start reading

| Document | What it is |
|---|---|
| [`docs/superpowers/specs/2026-08-09-riskety-rekt-design.md`](docs/superpowers/specs/2026-08-09-riskety-rekt-design.md) | **The spec.** Every rule, and why it is that rule. |
| [`HANDOFF.md`](HANDOFF.md) | Current state, architecture, and the rules a newcomer gets wrong |
| [`codemaps/`](codemaps/) | Generated architecture maps — module graph, engine pipeline, schema, jobs, web. Regenerate with `/update-codemaps`; don't hand-edit. |
| [`docs/superpowers/reviews/2026-08-11-balance-run-modules.md`](docs/superpowers/reviews/2026-08-11-balance-run-modules.md) | What 10,000 simulated seasons say about the economy |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Implementation plans. Each carries a "Spec deltas" section recording where reality corrected the design. |

The spec is the interesting document. Most of its rules exist because a reviewer or a
simulation found the obvious alternative was exploitable — a both-sides hedge worth a
risk-free +10% a day, a 1-troop feint that voids a 100-troop assault, a slate of five
bets that are secretly the same bet.

## State

The pure rules engine (module-dispatched: markets, IRL and the veto are pluggable
mechanics, and a voted daily rule catalogue rides the same hooks), the offline
season simulator, the Kalshi market adapter, the Slack ingress, the 21:00 tick
runner, the order-entry CLI and the player web app are built and tested.
**860 tests, none of which touch the network** — `test/no-network.ts` replaces
`fetch` in every test run, so that is enforced rather than asserted.

The player app is built: sign in with `/login` in Slack, act on a real map,
orders autosave and lock at 21:00. Each morning the bot posts a rule vote; the
winner applies to that night's tick. What still blocks a *competitive* season is
snowballing — see "Not built" in `CLAUDE.md`.

```bash
npm install
npm test          # 860 tests
npm run typecheck
npm run sim       # 2,000-season balance run, ~2s
npm run sim -- Slacker Blitz GymRat    # custom policy roster

# slack — see deploy/README.md
npm run roster:add -- U01ABCDEF f1 "Ada L."
npm run roster:list
npm run slack                          # the events bot, a long-running service
```

## Architecture

```
src/engine/    pure — zero dependencies, no I/O, no clock, no randomness
src/sim/       drives thousands of synthetic seasons through the engine
src/adapters/  the only code that speaks HTTP; parsing split from networking
src/slate/     pure slate selection
src/store/     SQLite (node:sqlite, WAL) — slates, settlements, Slack ingest
src/slack/     Bolt ingress, approval derivation, and Block Kit rendering
src/jobs/      the 08:00 publish, the 30-minute poll, the recap, and their CLI
```

The engine is one function — `resolve(state, orders, context) → GameState` — and it
imports nothing outside its own folder. A test enforces that, along with a ban on
`Date.now()`, `Math.random()` and `new Date()`. Time and randomness enter as arguments.

That purity is why the simulator can exist, and the simulator is the only reason anyone
knows the economy isn't broken.

**The tick never touches the network.** Slack approvals arrive continuously by webhook
and market settlements are written by a poller, both landing in SQLite well before
21:00. A Kalshi outage at 20:59 cannot stall the season.

See [`deploy/README.md`](deploy/README.md) for running the market jobs and the Slack bot.

## License

[MIT](LICENSE) © 2026 Sean Perkins
