> Generated: 2026-08-11 | Token-lean format for LLM context

# Data — types, schema, constants

## Engine types (`src/engine/types.ts`)

```ts
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

DailyContext  { slate, approvals, postedToday, settlements,
                tickInstant: string,   // the tick's frozen ISO instant — time enters HERE
                modules: string[],     // enabled module ids, from the season row
                rules: string[] }      // day-scoped voted rules; [] until the catalogue ships

Deploy { territory, count }   Attack { from, to, count }   Move { from, to, count }
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
{ t: "wagerSettle"; wagerId, outcome, payout, stake }
{ t: "rejected";    faction, field, reason, ref? } // ref names the dropped item
```

Consumers are exhaustiveness-guarded: `src/web/render.ts` switch has
`assertNever`; the recap has a `RECAP_HANDLED ∪ RECAP_IGNORED` coverage test
(`deploy` deliberately unrendered).

## SQLite schema (`src/store/schema.ts`)

`MIGRATIONS: string[]`, append-only, one per `user_version` step. **Never edit
a shipped migration.** Seven ship (indices 0–6):

| # | Adds |
|---|---|
| 0 | `seasons`, `slate_publications`, `slate_markets`, `settlements` (first observation wins) |
| 1 | `roster` (faction UNIQUE), `slack_events` (dedupe), `posts`, `reactions` (PK = distinct-reactor rule) |
| 2 | `states`, `orders`, `order_wagers`, `tick_context`, `recaps` (attempt in PK — claim-then-post ledger); rewrites `slate_markets.close_time` to ISO |
| 3 | `login_tokens` (hashed, TTL) |
| 4 | `market_prices` (30-min live prices), `order_wagers.price` (placement price; NULL = slate fallback) |
| 5 | `login_tokens_v2` rebuild (≤ `MAX_LIVE_TOKENS` per user instead of exactly one) |
| 6 | `seasons.modules` (default `'["markets","irl","veto"]'`); **DATA migration** rewriting `states.state` JSON `pending` → `moduleState.markets.pending` (pinned SQL; a real pre-migration row is loaded through it in `migration.test.ts`) |

Load-bearing details: `settlements.observed_at` (markets can close early;
wagers lock at `min(close_time, observed_at)` — `saveWager`'s `stillOpen`
gate); approvals are **derived, never stored** (`dailyApprovals` at read time);
`tick_context.context` carries the whole `DailyContext` as JSON — pre-change
rows are backfilled at read time from literals, never the mutable season row.

## Store (`src/store/types.ts`, implemented by `openStore(path)` in `sqlite.ts`)

| Interface | Highlights |
|---|---|
| `SeasonStore` | `season`, `upsertSeason`, `insertSeason` (insert-only + seed), `setSeasonModules` |
| `SlateStore` | `publishSlate` (idempotent), `loadSlate`, `recordSettlement`, `loadSettlements`, `marketsAwaitingSettlement`, `recordPrices`, `pricesFor` |
| `RosterStore` / `ApprovalStore` | roster CRUD; `recordPost`, `recordApproval` (INSERT OR IGNORE — first ts wins), `removeApproval`, `postFor`, `approversOf` |
| `OrderStore` | `saveOrder`, `saveWager` (orderGate: day range, deadline, resolved, market-locked; + `markets-off`), `orderFor`, `wagersFor`, `assembleOrders` |
| `StateStore` | `saveState` (JSON round-trip assert), `loadState` (`parseState` validates; requires `moduleState`), `latestSavedDay`, `stateExists`, `saveTickContext`, `loadTickContext`, `deleteStatesFrom` |
| `AuthStore` / `RecapLedger` | hashed login tokens; `claimRecap` (attempt-keyed) |
| `Transactional` | `transaction(fn)` — the ONLY `BEGIN` owner (`migrate` is the documented exemption) |

`node:sqlite` loads via `createRequire` (Vite strips the `node:` prefix). Rows
have a null prototype — spread them. WAL, `busy_timeout = 5000`.

## Constants

`src/config.ts`: `SEASON_LENGTH = 14`, `SLATE_MIN/MAX = 3/5`,
`WINDOW_OPEN_HOUR/CLOSE_HOUR = 9/21` (close **pinned equal to `TICK_HOUR`** in
`config.test.ts` — claim seniority depends on it), `PRICE_MIN/MAX = 0.1/0.9`
(pinned equal to the engine clamp), `VOLUME_FLOOR = 500`,
`QUESTION_MAX_CHARS = 200`, Kalshi HTTP knobs, `SETTLEMENT_HORIZON_DAYS = 4`.

`src/slack/config.ts`: `APPROVAL_EMOJI = {"+1"}` + aliases, `TICK_HOUR = 21`,
recap block/section caps. `src/engine/mechanics.ts`: `MAX_DEPARTURE_COST = 2`.

## Time (`src/time.ts`, `src/season.ts`)

`etDate`, `etInstant` (two-pass DST solve), `etDaysBetween`, `etDateAdd`,
`slackTsToIso` (throws on malformed). `currentDay(season, now)` and
`tickInstant(season, day)` are THE day clock — calendar-derived, never
state-derived. `checkDeal` bounds roster × territories.
