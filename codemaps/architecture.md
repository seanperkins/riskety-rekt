> Generated: 2026-08-11 | Token-lean format for LLM context

# Architecture

Risk-like conquest game, one tick per day at midnight ET (job runs 00:05). TypeScript, ESM, Node 22+
(`node:sqlite`), no bundler. `tsx` runs everything; nothing is compiled. The
client-side exception: Leaflet, served statically from `node_modules` by an
explicit two-file allow-list — it never touches the server, the store, or tests.

| | |
|---|---|
| Runtime deps | `@slack/bolt`, `@slack/web-api` (only `src/slack/app.ts` / `post.ts` import them), `leaflet` (browser only) |
| Dev deps | `typescript`, `tsx`, `vitest`, `fast-check`, `@types/node` |
| Tests | 72 files, 759 tests, `vitest run`, **zero network** (`test/no-network.ts` replaces `fetch`) |
| Strictness | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` |
| Storage | SQLite via `node:sqlite`, WAL, one file, `PRAGMA user_version` migrations (7 shipped, append-only) |

## Module graph

```
src/config.ts ──── constants (season, slate, prices, HTTP)
src/time.ts ────── ET date/instant helpers, Slack ts → ISO
src/season.ts ──── currentDay, tickInstant, checkDeal (THE day clock — calendar-derived)

src/engine/       PURE. imports nothing outside itself. no I/O, clock, randomness
  └── modules/    markets, irl, veto — Mechanic hooks (see engine.md)
     ▲
     ├── src/sim/       synthetic seasons; drives resolve() thousands of times
     ├── src/slate/     selectSlate(candidates) → Market[]
     ├── src/adapters/  Candidate/MarketAdapter; kalshi/ is the only HTTP code
     ├── src/map/       WORLD (264 territories), selectSubMap, clusteredOrder, shapes (generated)
     ├── src/store/     SQLite: everything below, one openStore(path)
     ├── src/slack/     Bolt ingress, approval derivation, /login, Block Kit renderers
     ├── src/jobs/      season-init, publish-slate, pollers, tick, rerun, recap, modules-set, CLI
     ├── src/web/       the player app: board, wagers, day replay, sessions
     └── src/auth/      login tokens (hashed at rest)
```

Dependency rules, enforced by `src/engine/types.test.ts` (recursive scan):

- `src/engine/**` (incl. `modules/`) imports only relative paths resolving
  inside `src/engine/` — bare specifiers rejected before resolution.
- No `Date.now()`, `Math.random()`, `new Date(` anywhere in the engine.
- Time and randomness enter as arguments: `createSeason` takes a pre-shuffled
  territory list; the tick takes a `DailyContext` carrying `tickInstant`.

Purity is why `src/sim` can run thousands of seasons, and the sim is the only
evidence the economy is not broken.

## Data flow — one game day

```
08:00   publish-slate ──► Kalshi /markets ──► selectSlate ──► slate_markets
                                                         └──► Slack #channel (optional)
all day  Slack events ──► handlers ──► posts / reactions / slack_events (dedupe)
         /login ──► login_tokens (hashed) ──► web session cookie
         web /api/plan + CLI order/wager ──► orders / order_wagers (priced at save)
:00/:30  poll-settlements ──► settlements (first write wins)
         poll-prices ──► market_prices (live prices; slate stays frozen)
00:05   TICK — resolves calendarDay-1 in one transaction: guards →
        assemble orders/context →
        resolve(state, orders, context) → saveState → saveTickContext
        then (outside the transaction) postRecap via the recaps ledger
```

**The tick never touches the network.** Both external systems are cached to
SQLite hours earlier; a Kalshi or Slack outage at 23:59 cannot stall the season.
The recap runs after the state save, so a Slack failure cannot double-run a tick.

**Every component derives the day from the calendar** via `currentDay` in
`src/season.ts`. A state-derived clock shears permanently after one missed tick.

**Modules**: a season's mechanics (`markets`, `irl`, `veto`) live in
`seasons.modules`, are frozen into each day's `tick_context`, and gate every
surface — pollers skip (exit 0), `/wagers` 404s, order fields reject — when off.
Mid-season changes go through `modules:set`, refused while escrow > 0.

## Simulator (`src/sim/`)

| Symbol | File | Note |
|---|---|---|
| `POLICIES` | `policies.ts` | Turtle, Blitz, Consolidator, Hunter, Gambler, Slacker, GymRat, Swarm, Ghost, Arbitrageur |
| `runSeason(names, seed, {modules?, rules?, voteRules?, deal?})` | `run.ts` | 14 days, selected world sub-map, synthetic 1-market slate |
| `runMany(names, seasons, {deal?})` | `run.ts` | → `Report { seasons, seats, wins, day3LeaderWinRate, eliminationRate, vetoes*, … }` |
| `seatsFor(names)` | `run.ts` | repeated policies get `Blitz#1`/`Blitz#2` seat ids |
| `simInstant(day, hour)` | `run.ts` | synthetic calendar; close (18:00) strictly before tick (21:00) — load-bearing for claim seniority. Deliberately NOT realigned to midnight: the value is opaque to the engine and only the ordering matters, so changing it would perturb the balance baseline for nothing |

Winner tiebreak: territories → garrisons + reserves (escrow excluded) → region
bonuses → id. `Arbitrageur` probes the known exploits; its win rate leaving ~0%
means a regression.

`Swarm` is the only policy that attacks on more than one front per tick, and it
dominates (71.4%) — the dial for that is open work. `Ghost` posts nothing and
plays nothing, and is the only source of coverage for the veto's post gate,
which drops a refused offer silently and so is counted from the orders BEFORE
`resolve`. `deal: "shuffled"` is the pre-`ec692fd` scattered-holdings arm, kept
so the contiguous deal's effect on snowballing stays checkable; the arms are
NOT rng-paired. Current balance record:
`docs/superpowers/reviews/2026-08-12-balance-run-snowballing.md`.

## Commands

See CLAUDE.md (authoritative). Env: `RR_DB_PATH`, `RR_SEASON_ID`; Slack adds the
four `SLACK_*` vars; `""` counts as unset. Exit codes are three-valued: 0
success/deliberate skip, 1 system failure (systemd retries), 2 operator mistake
or rejected write. Tick refusals exit 0 — the condition never clears with time.

## Not built

The rule catalogue + voting (second half of
`docs/superpowers/specs/2026-08-10-pluggable-mechanics-design.md`): `Rule` with
`needs`, three traced rules, `rule_offers`/`rule_reactions`, the Slack vote
branch, the per-rule bounded-swing gate.

See `codemaps/engine.md`, `data.md`, `jobs.md`, `integrations.md`, `web.md`.
