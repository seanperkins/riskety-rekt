> Generated: 2026-08-10 | Token-lean format for LLM context
> STALE (2026-08-11): predates the pluggable-mechanics module system — the
> pipeline is now grant/claims/allocate/locks/validate/combat/advance, pending
> lives in moduleState.markets, and mechanics are src/engine/modules/. Trust
> CLAUDE.md and the code until /update-codemaps regenerates this file.

# Architecture

Risk-like conquest game, one tick per day at 21:00 ET. TypeScript, ESM, Node 22+
(`node:sqlite`), no bundler. `tsx` runs everything; nothing is compiled.

| | |
|---|---|
| Runtime deps | `@slack/bolt`, `@slack/web-api` (only `src/slack/app.ts` and `src/slack/post.ts` import them) |
| Dev deps | `typescript`, `tsx`, `vitest`, `fast-check`, `@types/node` |
| Tests | 33 files, 368 tests, `vitest run`, **zero network** |
| Strictness | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` |
| Storage | SQLite via `node:sqlite`, WAL, one file, `PRAGMA user_version` migrations |

## Module graph

```
src/config.ts ──────────── constants (season, slate, prices, HTTP)
src/time.ts ────────────── ET date/instant helpers, Slack ts → ISO

src/engine/     PURE. imports nothing outside itself. no I/O, clock, randomness
     ▲
     │ types only
     ├── src/sim/        synthetic seasons; the only consumer that calls resolve()
     ├── src/slate/      selectSlate(candidates) → Market[]
     ├── src/adapters/   Candidate/MarketAdapter; kalshi/ is the only HTTP code
     ├── src/store/      SQLite: slates, settlements, roster, posts, reactions
     ├── src/slack/      Bolt ingress, approval derivation, Block Kit renderers
     └── src/jobs/       publish-slate, poll-settlements, post-recap, CLI
```

Dependency rules, enforced by `src/engine/types.test.ts`:

- `src/engine/**` may import only from `src/engine/`.
- No `Date.now()`, `Math.random()`, `new Date()` anywhere in the engine.
- Time and randomness enter as arguments: `createSeason` takes a pre-shuffled
  territory list; the tick takes a `DailyContext`.

Purity is why `src/sim` can run 2,000 seasons in ~2s, and the sim is the only
evidence the economy is not broken.

## Data flow — one game day

```
08:00  publish-slate ──► Kalshi /markets ──► selectSlate ──► slate_markets
                                                        └──► Slack #channel (optional)

all day  Slack events ──► handlers ──► posts / reactions / slack_events (dedupe)

:00/:30  poll-settlements ──► Kalshi /markets?tickers ──► settlements (first write wins)

21:00  TICK (NOT BUILT — Plan 4)
       loadState + loadOrders + loadSlate
       dailyApprovals(store, seasonId, day) → { approvals, postedToday }
       loadSettlements(slate ids)
       resolve(state, orders, context) ──► saveState ──► runPostRecap
```

**The tick never touches the network.** Both external systems are cached to
SQLite hours earlier, so a Kalshi or Slack outage at 20:59 cannot stall a season.
The recap runs *after* the state save, so a Slack failure cannot double-run a tick.

## Simulator (`src/sim/`)

| Symbol | File | Note |
|---|---|---|
| `makeRng(seed)` | `policies.ts` | xorshift32; seasons replay exactly |
| `POLICIES` | `policies.ts` | Turtle, Blitz, Consolidator, Hunter, Gambler, Slacker, GymRat, Arbitrageur |
| `runSeason(names, seed)` | `run.ts` | 21 days, synthetic 1-market slate, coin weighted to `priceYes` |
| `runMany(names, seasons)` | `run.ts` | → `Report { seasons, wins, day3LeaderWinRate, meanFinalTerritories }` |
| `SEASON_DAYS = 21` | `run.ts` | |

Default CLI roster: `Turtle, Blitz, GymRat, Slacker, Gambler, Arbitrageur`, 2,000 seasons.
Season winner tiebreak: territories → `garrisons + reserves` → continent bonuses → id.
Escrowed `pending` is deliberately excluded from the troop tiebreak.

`Arbitrageur` probes the four known exploits; if its win rate moves off ~0.1%,
something regressed.

## Commands

```bash
npm test          # vitest run — 368 tests
npm run typecheck # tsc --noEmit
npm run sim [-- Policy ...]
npm run sample:kalshi              # re-derive VOLUME_FLOOR from live data
npm run season:init -- YYYY-MM-DD [length]
npm run publish-slate | poll-settlements
npm run roster:add -- U01ABCDEF f1 "Ada L." | npm run roster:list
npm run slack                      # long-running events bot, PORT default 3001
```

Required env: `RR_DB_PATH`, `RR_SEASON_ID`. Slack adds `SLACK_SIGNING_SECRET`,
`SLACK_BOT_TOKEN`, `SLACK_TEAM_ID`, `SLACK_CHANNEL_ID` — empty string counts as absent.

## Not built

The 21:00 tick runner and the web UI (Plan 4). Nothing in the repo calls
`resolve()` outside `src/sim/`. `runPostRecap` exists but has no caller.
Design: `docs/superpowers/specs/2026-08-10-tick-runner-and-orders-design.md`.

Store methods Plan 4 must add against the same database: `loadState`, `saveState`,
`loadOrders`, `saveOrder`, `claimTick`.

See `codemaps/engine.md`, `codemaps/data.md`, `codemaps/integrations.md`,
`codemaps/jobs.md`.
