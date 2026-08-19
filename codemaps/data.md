> Generated: 2026-08-19 | Token-lean format for LLM context

# Data — types, schema, constants

## Engine types (`src/engine/types.ts`)

```ts
const ENGINE_VERSION = "1.1.0"

type FactionId = TerritoryId = RegionId = MarketId = string
type ModuleId = RuleId = string                    // mechanics.ts
type WagerSide  = "yes" | "no"
type Settlement = "yes" | "no" | "unsettled"

Territory     { id, name, region, neighbors: TerritoryId[] }
Region        { id, name, bonus }
GameMap       { territories: Territory[], regions: Region[] }
Faction       { id, playerName, color }
Market        { id, question, priceYes, priceNo, closeTime }   // closeTime: ISO instant
PendingWager  { wagerId, factionId, marketId, side, stake, price, placedOnDay }
ApprovedAction{ eventId, playerId, postedAt, approvedAt }

DailyContext  { slate, approvals,
                tickInstant: string,   // the tick's frozen ISO instant — time enters HERE
                modules: string[],     // enabled module ids, from the season row
                rules: string[],       // day-scoped voted rules; [] until the catalogue ships
                postedToday: FactionId[],
                settlements: Record<MarketId, Settlement> }

Deploy { territory, count }   Attack { from, to, count }
Move   { from, to, count }    // reinforcement between OWNED adjacent territories;
                               // arrives BEFORE combat, defends the destination same night
WagerOrder { marketId, side, stake, price? }   // price = placement price (stale-price fix)
Order  { factionId, deploys[], attacks[], moves?[], wagers[], protect: TerritoryId | null }

GameState { seasonId, day, map, factions, ownership, garrisons, reserves,
            moduleState: Record<string, unknown>,   // each module's slot; replaces `pending`
            log: TickEvent[], engineVersion }
```

`moduleState` values are opaque JSON — module code (incl. its exported helpers)
is the only interpreter; `saveState` asserts a JSON round-trip. `markets` holds
`{ pending: PendingWager[] }`.

### TickEvent union

```ts
{ t: "income";      faction, amount }
{ t: "irl";         faction, actions, bonus }
{ t: "grant";       source, faction, amount }      // module/rule without its own variant
{ t: "deploy";      faction, territory, count }
{ t: "move";        faction, from, to, count }
{ t: "fieldBattle"; a, b, aContinues, bContinues, aLost, bLost }
{ t: "protected";   territory, byCount }
{ t: "attack";      from, to, attacker, committed, survivors, captured,
                    lost, defenderLost, fee? }     // lost = target-combat only;
                                                   // defenderLost once per territory
{ t: "wagerSettle"; wagerId, faction?, marketId?, outcome, payout, stake }
  // faction/marketId OPTIONAL — pre-1.1.0 rows lack them; outcome "unsettled" +
  // payout === stake is a REFUND, not a win
{ t: "rejected";    faction, field, reason, ref? } // ref names the dropped item
```

Consumers are exhaustiveness-guarded: `src/web/render.ts` switch has
`assertNever`; the recap has a `RECAP_HANDLED ∪ RECAP_IGNORED` coverage test
(`deploy` deliberately unrendered).

## SQLite schema (`src/store/schema.ts`)

`MIGRATIONS: string[]`, append-only, one per `user_version` step. **Never edit
a shipped migration.** Eight ship (indices 0–7):

| # | Adds |
|---|---|
| 0 | `seasons`, `slate_publications`, `slate_markets`, `settlements` (first observation wins) |
| 1 | `roster` (faction UNIQUE), `slack_events` (dedupe), `posts`, `reactions` (PK = distinct-reactor rule) |
| 2 | `seasons.seed` column; `states`, `orders`, `order_wagers`, `tick_context`, `recaps` (attempt in PK — claim-then-post ledger); rewrites `slate_markets.close_time` to ISO |
| 3 | `login_tokens` (hashed, TTL), `sessions` |
| 4 | `market_prices` (30-min live prices), `order_wagers.price` (placement price; NULL = slate fallback) |
| 5 | `login_tokens_v2` rebuild (≤ `MAX_LIVE_TOKENS` per user instead of exactly one UNIQUE) |
| 6 | `seasons.modules` (default `'["markets","irl","veto"]'`); **DATA migration** rewriting `states.state` JSON `pending` → `moduleState.markets.pending` (pinned SQL; a real pre-migration row is loaded through it in `migration.test.ts`) |
| 7 | `rule_offers` (the day's numbered draw + shuffle seed; `message_ts` NULL between claim and post), `rule_reactions` (RAW numeral reactions, latest-wins upsert) |

### Table columns (as written, not from memory)

| Table | Columns |
|---|---|
| `seasons` | `season_id` PK, `start_date`, `length_days`, `seed` (nullable, mig 2), `modules` (mig 6, default `'["markets","irl","veto"]'`) |
| `slate_publications` | `season_id`, `day`, `published_at`, `market_count` — PK `(season_id, day)` |
| `slate_markets` | `season_id`, `day`, `market_id`, `question`, `price_yes`, `price_no`, `close_time` — PK `(season_id, day, market_id)`; index on `market_id` |
| `settlements` | `market_id` PK, `outcome` CHECK IN (yes,no), `observed_at` |
| `roster` | `slack_user_id` PK, `faction_id` UNIQUE, `display_name` |
| `slack_events` | `event_id` PK, `received_at` |
| `posts` | `message_ts` PK, `faction_id`, `posted_at`, `et_date`, `deleted` (default 0); index on `et_date` |
| `reactions` | `message_ts`, `faction_id`, `reacted_at` — PK `(message_ts, faction_id)` |
| `states` | `season_id`, `day` CHECK `>= 0`, `state` (JSON GameState), `engine_version` — PK `(season_id, day)`. No `run_at`; no lock table |
| `orders` | `season_id`, `day` CHECK `>= 1`, `faction_id`, `body` (JSON deploys/attacks/protect), `updated_at` — PK `(season_id, day, faction_id)` |
| `order_wagers` | `season_id`, `day` CHECK `>= 1`, `faction_id`, `market_id`, `side` CHECK IN (yes,no), `stake` CHECK `> 0 AND typeof = integer`, `first_staked_at`, `price` (mig 4, nullable) — PK `(season_id, day, faction_id, market_id)` |
| `tick_context` | `season_id`, `day` CHECK `>= 1`, `orders` (JSON), `context` (JSON DailyContext), `engine_version` — PK `(season_id, day)` |
| `recaps` | `season_id`, `day` CHECK `>= 1`, `kind` CHECK IN (original,correction,gap), `attempt` CHECK `>= 1`, `posted_at` — PK `(season_id, day, kind, attempt)` |
| `login_tokens` (v2, mig 5) | `token_hash` PK, `slack_user_id`, `faction_id`, `expires_at`; index on `slack_user_id` |
| `sessions` | `token_hash` PK, `faction_id`, `season_id`, `expires_at`; index on `faction_id` |
| `market_prices` | `market_id` PK, `price_yes`, `price_no`, `observed_at` |
| `rule_offers` | `season_id`, `day` CHECK `>= 1`, `rule_id`, `ordinal` CHECK `>= 1`, `seed`, `message_ts` (nullable) — PK `(season_id, day, rule_id)`; UNIQUE `(season_id, day, ordinal)`; index on `message_ts` |
| `rule_reactions` | `season_id`, `day` CHECK `>= 1`, `faction_id`, `ordinal` CHECK `>= 1`, `reacted_at` — PK `(season_id, day, faction_id, ordinal)` |

Load-bearing details: `settlements.observed_at` (markets can close early;
wagers lock at `min(close_time, observed_at)` — `saveWager`'s `stillOpen`
gate); approvals are **derived, never stored** (`dailyApprovals` at read time)
and so is the day's rule (`tallyRuleVote` over `rule_reactions`, cutoff
`reacted_at <= ctx.tickInstant` AND present at read);
`tick_context.context` carries the whole `DailyContext` as JSON — pre-change
rows are backfilled at read time from literals, never the mutable season row.
`StateMapStore.updateStateMap` is the ONLY `UPDATE` ever run against `states`
— every other write to that table is `saveState`'s INSERT.

## Store (`src/store/types.ts`, implemented by `openStore(path)` in `sqlite.ts`)

| Interface | Highlights |
|---|---|
| `SeasonStore` | `season`, `upsertSeason`, `insertSeason(season, seed)` (insert-only + seed, throws if season exists), `setSeasonModules` |
| `SlateStore` | `publishSlate` (idempotent), `slatePublished`, `loadSlate`, `marketQuestions` (season-wide, DISTINCT), `recordPrices` (latest wins), `recordSettlement` (first wins), `loadSettlements`, `marketsAwaitingSettlement` |
| `RosterStore` / `ApprovalStore` | roster CRUD; `markEventSeen`, `recordPost`, `deletePost`, `recordApproval` (INSERT OR IGNORE — first ts wins), `removeApproval`, `postsOn`, `postFor`, `approversOf` |
| `OrderStore` | `saveOrder`, `saveWager` (each owns one transaction: `SaveRejection` = day-out-of-range \| past-deadline \| already-resolved \| market-locked \| not-on-slate \| bad-stake \| markets-off), `orderFor`, `wagersFor`, `assembleOrders` (Order[], sorted by faction id) |
| `StateStore` | `stateExists`, `saveState` (JSON round-trip assert), `loadState` (`parseState` validates; requires `moduleState`), `latestSavedDay` (`undefined`, not 0, when none), `saveTickContext`, `loadTickContext`, `deleteStatesFrom` |
| `StateMapStore` | `updateStateMap(seasonId, day, map)` — rewrites a saved state's frozen `GameMap`; throws if the row is missing; the sole `UPDATE` on `states` |
| `AuthStore` | `mintLoginToken` (evicts past `MAX_LIVE_TOKENS`), `consumeLoginToken` (delete+insert, one transaction), `sessionFaction`, `revokeSessions` |
| `RecapLedger` | `claimRecap(seasonId, day, kind, attempt, at)` (attempt-keyed, claim before post), `latestRecapAttempt` |
| `RuleVoteStore` | `claimRuleOffers` (validates ids against the closed catalogue BEFORE insert), `ruleOffersFor`, `recordOfferMessage`, `offerForMessage` (the ingest's offer gate), `recordRuleReaction` (upsert — latest ts wins, the OPPOSITE of `recordApproval`), `removeRuleReaction`, `ruleReactionsFor` |
| `Transactional` | `transaction(fn)` — the ONLY `BEGIN` owner (`migrate` is the documented exemption) |

`node:sqlite` loads via `createRequire` (Vite strips the `node:` prefix). Rows
have a null prototype — spread them. WAL, `busy_timeout = 5000`.

## Constants

`src/config.ts`: `SEASON_LENGTH = 14`, `MIN_FACTIONS/MAX_FACTIONS = 4/15`,
`MIN_TERRITORIES_PER_FACTION/MAX = 5/11` (upper bound is where the income
floor `max(5, floor(t/2))` starts to bind, at t = 12), `REGION_MIN/MAX = 4/9`,
`MIN_REGIONS = 4`, `MAX_ATTEMPTS = 20` (map-selection restart cap),
`SLATE_MIN/MAX = 3/5`, `RULES_PER_OFFER = 3`,
`WINDOW_OPEN_HOUR/CLOSE_HOUR = 9/21` (close **strictly inside the day**, 0 < 21 < 24, in
`config.test.ts` — claim seniority depends on it), `MIN_MARKET_HOURS = 4`,
`PRICE_MIN/MAX = 0.1/0.9` (pinned equal to the engine clamp), `VOLUME_FLOOR = 500`,
`QUESTION_MAX_CHARS = 200` (third-party text cap), `MARKET_QUESTION_MAX = 60`
(display-width fence for the daily markets table), `DISPLAY_NAME_MAX_CHARS = 32`,
`TIMEZONE = "America/New_York"`, Kalshi HTTP knobs (`KALSHI_BASE_URL`,
`HTTP_TIMEOUT_MS = 20_000`, `HTTP_RETRIES = 2`, `HTTP_RETRY_DELAY_MS = 1_000`,
`MAX_PAGES = 40`, `PAGE_LIMIT = 1000`, `SETTLEMENT_BATCH_SIZE = 100`),
`SETTLEMENT_HORIZON_DAYS = 4`.

`src/slack/config.ts`: `APPROVAL_EMOJI = Set{"+1"}` + `EMOJI_ALIASES` (no
`TICK_HOUR` — the boundary is a day offset in `tickInstant`), `NUMERAL_EMOJI`
(one..nine → ordinals 1-9, the rule-vote ballot), `MAX_RECAP_BLOCKS = 48`,
`MAX_SECTION_CHARS = 2_900`, `MAX_SECTION_LINES = 20`, `RECAP_NAME_MAX_CHARS = 40`,
`RECAP_MARKET_MAX_CHARS = 90`.

`src/engine/mechanics.ts`: `MAX_DEPARTURE_COST = 2`.
`src/auth/token.ts`: `MAX_LIVE_TOKENS = 5`.

## Map data (`src/map/`)

| File | Generated? | Exports |
|---|---|---|
| `world.ts` | Hand-authored | `Spec { id, name, region, lat, lon }` — no `borders` field; `SEA_LINKS: readonly [string,string][]` (hand-authored strait crossings, the only hand-authored adjacency); `WORLD: GameMap` (`build()` output); `SPECS: readonly Spec[]` |
| `adjacency.ts` | **GENERATED** — `npm run build:shapes` | `LAND_BORDERS: Record<TerritoryId, TerritoryId[]>` (264 territories, 525 land borders); `SEAM_BORDERS: readonly [TerritoryId,TerritoryId][]` (8 pairs recovered by a 0.1° seam rule, not shared topology) |
| `shapes.ts` | **GENERATED** — `npm run build:shapes` | `SHAPES` (coastlines, [lon,lat] degrees, RDP-simplified 0.15°), `LABELS` (garrison label points), `SHAPES_FINE` (same at 0.04°), `LABEL_BOXES` (largest inscribed label rect per territory), `REGION_OUTLINES` (dissolved region boundaries). 264 territories, 16,515 points. Outer rings only — no holes (costs Lesotho's cutout) |
| `coords.ts` | Derived at import time from `SPECS` | `LatLon { lat, lon }`; `COORDS: Record<TerritoryId, LatLon>` — deliberately NOT on `Territory`: engine has no geometry, `GameState.map` would serialise centroids into every `states` row, and the golden file would churn |

`scripts/build-shapes.ts` emits **both** `shapes.ts` and `adjacency.ts` from
one Natural Earth topology, so land borders are DERIVED from the drawn shapes
rather than hand-authored — `world.ts`'s `build()` joins `LAND_BORDERS` to the
hand-authored `SEA_LINKS` and de-duplicates (a pair can be both, e.g. Ceuta↔
Andalusia is a real land border AND lists the Strait of Gibraltar). `bonus` is
always 0 in `WORLD`; `selectSubMap` computes it per sub-map, since a region's
defensibility depends on which neighbouring regions were selected.

**A season freezes its `GameMap` into every `states` row at deal time.**
Regenerating `adjacency.ts` does not reach a running season — the frozen
`neighbors` on each saved day must be rewritten explicitly via
`StateMapStore.updateStateMap`, which is what `npm run map:resync` does.

## Time (`src/time.ts`, `src/season.ts`)

`etDate`, `etInstant` (two-pass DST solve), `etDaysBetween`, `etDateAdd`,
`slackTsToIso` (throws on malformed). `currentDay(season, now)` and
`tickInstant(season, day)` are THE day clock — calendar-derived, never
state-derived. `checkDeal` bounds roster × territories.
