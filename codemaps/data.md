> Generated: 2026-08-10 | Token-lean format for LLM context

# Data — types, schema, constants

## Engine types (`src/engine/types.ts`)

```ts
type FactionId = TerritoryId = ContinentId = MarketId = string
type WagerSide  = "yes" | "no"
type Settlement = "yes" | "no" | "unsettled"

Territory     { id, name, continent, neighbors: TerritoryId[] }
Continent     { id, name, bonus: number }
GameMap       { territories: Territory[], continents: Continent[] }
Faction       { id, playerName, color }
Market        { id, question, priceYes, priceNo, closeTime: string }
PendingWager  { wagerId, factionId, marketId, side, stake, price, placedOnDay }
ApprovedAction{ eventId, playerId, postedAt, approvedAt }   // ISO instants

DailyContext  { slate: Market[], approvals: ApprovedAction[],
                postedToday: FactionId[], settlements: Record<MarketId, Settlement> }

Deploy        { territory, count }
Attack        { from, to, count }
WagerOrder    { marketId, side, stake }
Order         { factionId, deploys[], attacks[], wagers[], protect: TerritoryId | null }

GameState     { seasonId, day, map, factions, ownership: Record<TerritoryId, FactionId>,
                garrisons: Record<TerritoryId, number>, reserves: Record<FactionId, number>,
                pending: PendingWager[], log: TickEvent[], engineVersion }
```

`postedToday` is separate from `approvals` because the two mechanics gate
differently: +1 soldier needs two distinct *other* reactors, the elimination veto
needs only that the player showed up. Post *times* are deliberately absent —
Early Bird keys on an approved action's `postedAt`.

### TickEvent union

```ts
{ t: "income";      faction, amount }
{ t: "irl";         faction, actions, bonus }
{ t: "deploy";      faction, territory, count }
{ t: "fieldBattle"; a, b, aContinues, bContinues }
{ t: "protected";   territory, byCount }
{ t: "attack";      from, to, attacker, committed, survivors, captured }
{ t: "wagerSettle"; wagerId, outcome: Settlement, payout }
{ t: "rejected";    faction, field, reason }
```

## Adapter types (`src/adapters/types.ts`)

```ts
Candidate extends Market { volume: number; series: string }   // selection-only fields
CandidateWindow { opensAfter: Date; closesBefore: Date }      // passed in, never computed
MarketAdapter {
  getCandidates(window): Promise<Candidate[]>
  getSettlements(ids): Promise<Record<MarketId, Settlement>>
}
```

## SQLite schema (`src/store/schema.ts`)

`MIGRATIONS: string[]`, append-only, one per `PRAGMA user_version` step. **Never
edit a shipped migration.** `migrate(db)` is safe on every boot; each migration
runs in its own BEGIN/COMMIT with ROLLBACK on error.

### Migration 0 — markets

| Table | Columns | Notes |
|---|---|---|
| `seasons` | `season_id` PK, `start_date`, `length_days` | `start_date` is the ET date of the day-0 deal |
| `slate_publications` | (`season_id`,`day`) PK, `published_at`, `market_count` | distinguishes "not published yet" from "published empty on purpose" |
| `slate_markets` | (`season_id`,`day`,`market_id`) PK, `question`, `price_yes`, `price_no`, `close_time` | + index `slate_markets_by_market` |
| `settlements` | `market_id` PK, `outcome CHECK IN ('yes','no')`, `observed_at` | first observation wins |

`settlements.observed_at` is load-bearing, not bookkeeping: every sampled Kalshi
market carries `can_close_early`, so an outcome can go public before the stated
close. Wagers must lock at `min(close_time, observed_at)` — Plan 4's web app owes
this.

### Migration 1 — Slack

| Table | Columns | Notes |
|---|---|---|
| `roster` | `slack_user_id` PK, `faction_id` **UNIQUE**, `display_name` | UNIQUE blocks two accounts on one faction, which would defeat the self-approval check |
| `slack_events` | `event_id` PK, `received_at` | dedupe ledger; Slack redelivers up to 3× |
| `posts` | `message_ts` PK, `faction_id`, `posted_at`, `et_date`, `deleted` | + index `posts_by_date`; both times derive from `message_ts`, never from write time |
| `reactions` | (`message_ts`,`faction_id`) PK, `reacted_at` | the PK **is** the "distinct reactors" rule; 👍 after 👍🏽 collides |

**Approvals are never stored.** An `ApprovedAction` is derived at read time by
`dailyApprovals`. Storing them would make `reaction_removed` a state machine that
must retract an approval which may or may not have existed; deriving makes
removal one `DELETE`.

## Store interfaces (`src/store/types.ts`)

Implemented by `openStore(path)` in `src/store/sqlite.ts` → `SlateStore & RosterStore & ApprovalStore`.

| Interface | Methods |
|---|---|
| `SlateStore` | `season`, `upsertSeason`, `publishSlate`, `slatePublished`, `loadSlate`, `recordSettlement`, `loadSettlements`, `marketsAwaitingSettlement`, `close` |
| `RosterStore` | `addRosterMember`, `roster`, `factionForSlackUser`, `slackUserForFaction` |
| `ApprovalStore` | `markEventSeen`, `recordPost`, `deletePost`, `recordApproval`, `removeApproval`, `postsOn`, `postFor`, `approversOf` |

`publishSlate` returns `false` and writes nothing on a second call for the same
day — a 20:00 rerun would otherwise re-snapshot prices on the afternoon's
information. `markEventSeen` returns `false` on a redelivery. Every Slack write
is idempotent.

`node:sqlite` is loaded via `createRequire`, **not** a static import: Vite builds
its builtin list with `builtinModules.filter(id => !id.includes(":"))` and Node
lists the module only as `node:sqlite`, so a static import resolves to bare
`sqlite` and every store test fails to load. Rows come back with a `null`
prototype — spread them rather than calling `Object.prototype` methods. The
`ExperimentalWarning` on stderr is expected.

Connection setup: `journal_mode = WAL`, `busy_timeout = 5000`,
`foreign_keys = ON`. `PARAM_CHUNK = 500` keeps bound params under SQLite's 999.

## Constants (`src/config.ts`)

| Name | Value | Note |
|---|---|---|
| `SEASON_LENGTH` | 21 | |
| `SLATE_MIN` / `SLATE_MAX` | 3 / 5 | below MIN logs, does not fail |
| `WINDOW_OPEN_HOUR` / `WINDOW_CLOSE_HOUR` | 9 / 21 | ET, on the slate's own day |
| `PRICE_MIN` / `PRICE_MAX` | 0.1 / 0.9 | must equal the engine clamp; asserted in `config.test.ts` |
| `VOLUME_FLOOR` | 500 | p75 of markets that traded; 66.6% of same-day markets never trade, so the spec's "median" would have been 0 |
| `QUESTION_MAX_CHARS` | 200 | |
| `TIMEZONE` | `America/New_York` | |
| `KALSHI_BASE_URL` | `https://api.elections.kalshi.com/trade-api/v2` | |
| `HTTP_TIMEOUT_MS` / `HTTP_RETRIES` / `HTTP_RETRY_DELAY_MS` | 20000 / 2 / 1000 | |
| `MAX_PAGES` / `PAGE_LIMIT` | 40 / 1000 | was 12 until a run returned exactly 12,000 markets seven days running |
| `SETTLEMENT_BATCH_SIZE` | 100 | max tickers per `?tickers=` query |
| `SETTLEMENT_HORIZON_DAYS` | 4 | > `REFUND_AFTER_TICKS`, so nothing older can affect a live wager |

`src/slack/config.ts`: `APPROVAL_EMOJI = {"+1"}`, `EMOJI_ALIASES`
(`thumbsup`, `thumbsup_all`, `+1` → `+1`), `TICK_HOUR = 21`,
`MAX_RECAP_BLOCKS = 48`, `MAX_SECTION_CHARS = 2900`, `MAX_SECTION_LINES = 20`,
`RECAP_NAME_MAX_CHARS = 40`.

## Time helpers (`src/time.ts`)

| Function | Contract |
|---|---|
| `etDate(at)` | instant → `YYYY-MM-DD` in ET |
| `etInstant(date, hour, minute=0)` | ET wall clock → `Date`; two-pass offset solve for DST |
| `etDaysBetween(from, to)` | whole calendar days; both read as UTC midnight |
| `etDateAdd(date, days)` | inverse of the above |
| `slackTsToIso(ts)` | `"1723237200.000200"` → ISO; **throws** on a malformed ts rather than landing it at the epoch |

Counting in dates rather than hours is what keeps a DST transition from shifting
a day boundary or a refund window.
