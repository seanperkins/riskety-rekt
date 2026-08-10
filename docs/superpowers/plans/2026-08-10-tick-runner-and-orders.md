# Riskety Rekt — Tick Runner & Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the game playable. Orders reach SQLite through two write paths that lock on their own clocks, and at 21:00 a single transaction reads them, resolves them through the pure engine, saves the state, and posts the recap.

**Architecture:** One transaction owns claim → `resolve` → save, so there is no lock table and no half-state to adopt. Every component derives the day from the calendar. The tick's inputs are recorded in `tick_context` at the moment they are read, because approvals are not reconstructable after the fact.

**Tech Stack:** TypeScript 5.x (strict), Vitest, Node 24. `node:sqlite` via `createRequire`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-10-tick-runner-and-orders-design.md` — 822 lines, reviewed over three rounds plus a verification pass. **It carries the DDL, the exact predicates and the worked arithmetic; this plan does not restate them.** Read the spec section named in each task before writing that task's code.

## Global Constraints

- **`src/engine/` stays pure.** One engine change is in scope (Task 7, the `createSeason` map parameter) and no other. `src/engine/types.test.ts` enforces the import boundary and the ban on `Date.now()`, `Math.random()`, `new Date()` — do not weaken it.
- **The tick never touches the network.** Every input is a local table. `postRecap` and the gap note are the only outbound calls and both happen after the commit.
- **No test may make a network call.** Task 14 enforces it with a vitest `setupFiles` that stubs `globalThis.fetch` to throw.
- **`transaction(fn)` is the only place `BEGIN IMMEDIATE` is written** (plus the two pre-existing exemptions, `publishSlate` and `migrate`). Every other store method is statement-only. The public writers — `saveOrder`, `saveWager`, `runTick`, `runRerun`, `seasonInit` — each own one `transaction(...)`.
- **Never edit a shipped migration.** Migration 3 is new; migrations 1 and 2 are frozen.
- **`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on.** Expect `!` and `?? 0`; pass optional fields by spreading a conditional object, never as an explicit `undefined`.
- **Every timestamp is an ISO instant at millisecond precision** (`toISOString()`). The market lock is a string comparison, so mixed formats silently break it.
- Jobs take `now: Date` as an injected dependency. No clock is read inside a store method or the engine.
- Test files live beside the code as `*.test.ts`.

## File Structure

```
src/season.ts                    NEW  currentDay, faction/territory bounds checks
src/season.test.ts               NEW
src/config.ts                    MOD  SEASON_LENGTH 21->14, MIN/MAX_FACTIONS, MIN_TERRITORIES_PER_FACTION
src/store/schema.ts              MOD  migration 3; migrate -> BEGIN IMMEDIATE
src/store/types.ts               MOD  TickStore, OrderStore, StateStore interfaces
src/store/sqlite.ts              MOD  transaction() helper + the new methods
src/store/transaction.test.ts    NEW  re-entrancy, SQLITE_BUSY retry
src/adapters/kalshi/parse.ts     MOD  normalize close_time, validate market_id
src/engine/setup.ts              MOD  createSeason gains an optional map parameter
src/jobs/tick.ts                 NEW  runTick + the day-clock guard
src/jobs/tick.test.ts            NEW
src/jobs/rerun.ts                NEW  runRerun, --assemble-missing
src/jobs/rerun.test.ts           NEW
src/jobs/season-init.ts          NEW  the deal, extracted from cli.ts
src/jobs/season-init.test.ts     NEW
src/jobs/post-recap.ts           MOD  the recaps ledger and attempt handling
src/jobs/order-entry.ts          NEW  shape validation for the order/wager CLI
src/jobs/order-entry.test.ts     NEW
src/jobs/cli.ts                  MOD  tick, tick-rerun, recap, order, wager, season-init
vitest.config.ts                 MOD  setupFiles
test/no-network.ts               NEW  the fetch guard
deploy/riskety-tick.{service,timer}  NEW
```

`src/season.ts` is new rather than an addition to `src/time.ts` because it needs `SeasonRow`, and `src/time.ts` is imported by the store — a cycle otherwise.

---

### Task 1: `currentDay` and the season bounds

The day derivation every other task consumes, plus the two bounds `season-init` enforces. Nothing else can be written first.

**Files:**
- Create: `src/season.ts`, `src/season.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: `etDate`, `etDaysBetween`, `etInstant` from `src/time.js`; `SeasonRow` from `src/store/types.js`; `TICK_HOUR` from `src/slack/config.js`
- Produces: `currentDay(season, now): number`; `tickInstant(season, day): Date`; `checkDeal(factionCount, territoryCount): DealProblem | null`; `MIN_FACTIONS`, `MAX_FACTIONS`, `MIN_TERRITORIES_PER_FACTION`

Read the spec's **"The day clock"** and **"Season initialization"** sections first.

- [ ] **Step 1: Add the constants to `src/config.ts`**

```ts
/** Season shape. Mirrors the spec's "14 days, one tick per day". */
export const SEASON_LENGTH = 14

/**
 * Roster bounds. New constants -- no faction bound existed before.
 * The upper bound is the Slack group size; the lower is the original design's.
 */
export const MIN_FACTIONS = 4
export const MAX_FACTIONS = 15

/**
 * Territories per faction at the deal, lower bound.
 *
 * Five dealt territories is ten troops -- enough that losing one border does not
 * cascade, and it keeps the smallest realistic continent (4) in reach. Two or
 * three is the failure this guards: 42 territories dealt to 15 factions is 2.8
 * each, six troops, eliminated by one focused attack.
 *
 * The UPPER bound is 11 and is not a judgement call: floor(t/2) > 5 first at
 * t = 12, so 11 is exactly where income leaves the floor of 5.
 */
export const MIN_TERRITORIES_PER_FACTION = 5
export const MAX_TERRITORIES_PER_FACTION = 11
```

Also update the file's opening docstring, which says "21 days".

- [ ] **Step 2: Write the failing test**

`src/season.test.ts`. `SEASON` is `{ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }`.

```ts
describe("currentDay", () => {
  it("is 0 on the start date and 1 the next day", () => {
    expect(currentDay(SEASON, new Date("2026-09-01T18:00:00Z"))).toBe(0)  // 14:00 ET
    expect(currentDay(SEASON, new Date("2026-09-02T18:00:00Z"))).toBe(1)
  })

  it("reads the ET calendar date, not the UTC one", () => {
    // 01:30Z on Sep 3 is 21:30 ET on Sep 2 -- day 1, not day 2.
    expect(currentDay(SEASON, new Date("2026-09-03T01:30:00Z"))).toBe(1)
  })

  it("is negative for a season dealt in advance", () => {
    expect(currentDay(SEASON, new Date("2026-08-20T18:00:00Z"))).toBe(-12)
  })

  it("agrees with runPublishSlate's derivation", () => {
    // publish-slate.ts:45-46 computes etDaysBetween(startDate, etDate(now)).
    // If these ever disagree the two clocks have diverged -- the exact defect
    // the calendar-derived design exists to prevent.
    const now = new Date("2026-09-05T12:00:00Z")
    expect(currentDay(SEASON, now)).toBe(etDaysBetween(SEASON.startDate, etDate(now)))
  })
})

describe("tickInstant", () => {
  it("is 21:00 ET on that season day", () => {
    // Day 3 of a Sep 1 season is Sep 4; 21:00 EDT is 01:00Z on Sep 5.
    expect(tickInstant(SEASON, 3).toISOString()).toBe("2026-09-05T01:00:00.000Z")
  })
})

describe("checkDeal", () => {
  it("accepts the original 42/6 board", () => {
    expect(checkDeal(6, 42)).toBeNull()
  })

  it("rejects 15 factions on the 42-territory default", () => {
    // floor(42/15) = 2, below the lower bound. This is the case the earlier
    // one-sided `> 11` guard did not catch.
    expect(checkDeal(15, 42)).toEqual({ kind: "too-few-territories", perFaction: 2 })
  })

  it("rejects an empty territory list", () => {
    expect(checkDeal(4, 0)).toEqual({ kind: "too-few-territories", perFaction: 0 })
  })

  it("accepts exactly at the upper bound and rejects one past it", () => {
    expect(checkDeal(4, 44)).toBeNull()               // ceil(44/4) = 11
    expect(checkDeal(4, 45)).toEqual({ kind: "too-many-territories", perFaction: 12 })
  })

  it("rejects a roster outside the faction bounds", () => {
    expect(checkDeal(3, 42)).toEqual({ kind: "roster-size", factions: 3 })
    expect(checkDeal(16, 112)).toEqual({ kind: "roster-size", factions: 16 })
  })

  it("accepts 15 factions on a 105-territory board", () => {
    expect(checkDeal(15, 105)).toBeNull()
  })
})
```

Verify the two ISO expectations by running `node -e` before trusting them; if EDT/EST changes the answer, assert what it actually produces.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/season.test.ts`
Expected: FAIL — `Cannot find module './season.js'`.

- [ ] **Step 4: Write `src/season.ts`**

```ts
import { MAX_FACTIONS, MAX_TERRITORIES_PER_FACTION, MIN_FACTIONS, MIN_TERRITORIES_PER_FACTION } from "./config.js"
import { TICK_HOUR } from "./slack/config.js"
import { etDate, etDateAdd, etDaysBetween, etInstant } from "./time.js"
import type { SeasonRow } from "./store/types.js"

export type DealProblem =
  | { kind: "roster-size"; factions: number }
  | { kind: "too-few-territories"; perFaction: number }
  | { kind: "too-many-territories"; perFaction: number }

/**
 * The season day for an instant. THE single derivation -- publish-slate,
 * dailyApprovals, the order writers and the tick all key off this.
 *
 * A second, state-derived clock ("highest saved day + 1") agrees with this one
 * only while no tick is ever missed, and shears permanently after one miss.
 */
export function currentDay(season: SeasonRow, now: Date): number {
  return etDaysBetween(season.startDate, etDate(now))
}

/** The 21:00 America/New_York instant of a season day -- the order deadline. */
export function tickInstant(season: SeasonRow, day: number): Date {
  return etInstant(etDateAdd(season.startDate, day), TICK_HOUR)
}

/**
 * Whether a deal is playable. Two-sided on purpose.
 *
 * Upper bound: income is max(5, floor(t/2)), flat at 5 for t in [1,11], so 11 is
 * exactly where a deal would start above the floor.
 * Lower bound: 2-3 territories is 4-6 troops, eliminated by one attack, with no
 * continent reachable. Income does NOT distinguish 2.8 from 7.0 -- both are 5.
 */
export function checkDeal(factionCount: number, territoryCount: number): DealProblem | null {
  if (factionCount < MIN_FACTIONS || factionCount > MAX_FACTIONS) {
    return { kind: "roster-size", factions: factionCount }
  }
  const low = Math.floor(territoryCount / factionCount)
  const high = Math.ceil(territoryCount / factionCount)
  if (low < MIN_TERRITORIES_PER_FACTION) return { kind: "too-few-territories", perFaction: low }
  if (high > MAX_TERRITORIES_PER_FACTION) return { kind: "too-many-territories", perFaction: high }
  return null
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/season.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Fix the fallout from `SEASON_LENGTH = 14`**

`src/config.ts:1` docstring, and the simulator's *second* length constant. Read the spec's **"Season length"** section — `src/sim/run.ts:18` declares `SEASON_DAYS = 21`, used at `:71`, `:74`, `:138`, and it is unrelated to `SEASON_LENGTH`. Leaving it means every future balance run silently measures 21 days.

```ts
// src/sim/run.ts — delete SEASON_DAYS, import the shared constant instead.
import { SEASON_LENGTH } from "../config.js"
```

Replace all four `SEASON_DAYS` references with `SEASON_LENGTH`. Then update `src/sim/run.test.ts:7,9`, which hardcode `21` in a test title and an assertion.

- [ ] **Step 7: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS. `src/engine/golden.test.ts` runs a hardcoded 10-day season and is unaffected; if it fails, the change reached the engine and should not have.

- [ ] **Step 8: Commit**

```bash
git add src/season.ts src/season.test.ts src/config.ts src/sim
git commit -m "feat(season): calendar day derivation and two-sided deal bounds

SEASON_LENGTH drops to 14 and the simulator's separate SEASON_DAYS is deleted in
favour of it -- leaving both would have measured 21 days in every future balance
run. checkDeal is two-sided: the upper bound is where income leaves the floor,
the lower is where one attack eliminates a faction."
```

---

### Task 2: Migration 3 and the transaction helper

The schema and the one primitive every later task builds on. Read the spec's **"Storage"** and **"Transaction composition"** sections; the DDL is given there in full and should be copied, not reinvented.

**Files:**
- Modify: `src/store/schema.ts`, `src/store/sqlite.ts`, `src/store/types.ts`
- Create: `src/store/transaction.test.ts`

**Interfaces:**
- Produces: `transaction<T>(fn: () => T): T` on the store; the five new tables and `seasons.seed`

- [ ] **Step 1: Append migration 3 to `MIGRATIONS`**

Copy the DDL from the spec's "Storage" section verbatim — `ALTER TABLE seasons ADD COLUMN seed INTEGER`, then `states`, `orders`, `order_wagers`, `tick_context`, `recaps`. Keep the comments; they carry the reasoning for `first_staked_at`'s precision, the `attempt` column and the `typeof(stake)` check.

Append a backfill as the last statement of the same migration:

```sql
-- close_time was stored verbatim as Kalshi sent it, and the market lock is a
-- string comparison -- a date-only value sorts after every same-day instant and
-- reads as open forever. Normalize what is already on disk.
UPDATE slate_markets
   SET close_time = strftime('%Y-%m-%dT%H:%M:%fZ', close_time)
 WHERE close_time NOT LIKE '____-__-__T__:__:__.___Z';
```

Verify that `strftime` produces exactly `toISOString()`'s shape for the formats Kalshi emits before relying on it; if it does not, do the backfill in TypeScript inside the migration runner instead and say so in a comment.

- [ ] **Step 2: Change `migrate` to `BEGIN IMMEDIATE`**

`src/store/schema.ts:110` opens a deferred `BEGIN` after reading `PRAGMA user_version`. Under WAL, a deferred transaction that has read and then tries to upgrade returns `SQLITE_BUSY_SNAPSHOT` **immediately, without invoking the busy handler**, so `busy_timeout` does not help. Migrations 1 and 2 shipped before three processes shared the file; migration 3 will not.

```ts
db.exec("BEGIN IMMEDIATE")
```

- [ ] **Step 3: Write the failing transaction test**

```ts
// src/store/transaction.test.ts
describe("transaction", () => {
  it("commits on success and returns the value", () => {
    const store = openStore(":memory:")
    const out = store.transaction(() => {
      store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
      return 42
    })
    expect(out).toBe(42)
    expect(store.season("s1")).toBeDefined()
    store.close()
  })

  it("rolls back everything on a throw", () => {
    const store = openStore(":memory:")
    expect(() =>
      store.transaction(() => {
        store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
        throw new Error("boom")
      }),
    ).toThrow("boom")
    // The whole point of the single-transaction tick: a crash leaves nothing.
    expect(store.season("s1")).toBeUndefined()
    store.close()
  })

  it("refuses to nest", () => {
    // SQLite has no nested transactions; a silent inner BEGIN would raise
    // "cannot start a transaction within a transaction" at an arbitrary depth.
    const store = openStore(":memory:")
    expect(() => store.transaction(() => store.transaction(() => 1))).toThrow(/nest/i)
    store.close()
  })
})
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run src/store/transaction.test.ts`
Expected: FAIL — `store.transaction is not a function`.

- [ ] **Step 5: Implement it**

```ts
// src/store/sqlite.ts
const BUSY_RETRIES = 3
const BUSY_BACKOFF_MS = [50, 200, 500]

let inTransaction = false

// ... inside the returned object:
    transaction<T>(fn: () => T): T {
      // SQLite has no nested transactions. Throwing here beats a confusing
      // "cannot start a transaction within a transaction" from an inner BEGIN.
      if (inTransaction) throw new Error("transaction: cannot nest transactions")
      for (let attempt = 0; ; attempt++) {
        db.exec("BEGIN IMMEDIATE")
        inTransaction = true
        try {
          const out = fn()
          db.exec("COMMIT")
          return out
        } catch (err) {
          db.exec("ROLLBACK")
          const busy = /SQLITE_BUSY/.test(String(err))
          if (!busy || attempt >= BUSY_RETRIES - 1) throw err
          sleepSync(BUSY_BACKOFF_MS[attempt]!)
        } finally {
          inTransaction = false
        }
      }
    },
```

`sleepSync` must not be `await` — `transaction` is synchronous because `DatabaseSync` is. Use `Atomics.wait` on a `SharedArrayBuffer`:

```ts
const sleepBuf = new Int32Array(new SharedArrayBuffer(4))
const sleepSync = (ms: number) => void Atomics.wait(sleepBuf, 0, 0, ms)
```

- [ ] **Step 6: Run the store suite**

Run: `npx vitest run src/store && npm run typecheck`
Expected: PASS, including every pre-existing store test — migration 3 runs against each fresh `:memory:` database.

- [ ] **Step 7: Commit**

```bash
git add src/store
git commit -m "feat(store): migration 3, the transaction helper, and BEGIN IMMEDIATE for migrate

transaction() is the only place BEGIN IMMEDIATE is written from here on, retries
SQLITE_BUSY, and refuses to nest. migrate moves off a deferred BEGIN because
SQLITE_BUSY_SNAPSHOT bypasses busy_timeout under WAL, and migration 3 is the
first to run with three processes on the file."
```

---

### Task 3: Normalize `close_time` and validate `market_id` at ingest

Two ingest hardenings the market lock depends on. Read the spec's **"Two clocks"** section for why the string comparison is load-bearing.

**Files:**
- Modify: `src/adapters/kalshi/parse.ts`, `src/adapters/kalshi/parse.test.ts`

- [ ] **Step 1: Write the failing tests**

The file already has a `GOOD` raw-market literal (`parse.test.ts:13`) and a
`WINDOW` constant (`:7`), and calls `toCandidate(raw, WINDOW, 1000)` — three
arguments, the third being the volume floor. Spread `GOOD` for each case.

```ts
it("normalizes close_time to a millisecond ISO instant", () => {
  // The market lock compares strings. A date-only close_time sorts AFTER every
  // same-day instant, so the market reads as open forever.
  const r = toCandidate({ ...GOOD, close_time: "2026-08-10T20:00:00+00:00" }, WINDOW, 1000)
  expect(r.ok && r.market.closeTime).toBe("2026-08-10T20:00:00.000Z")
})

it("rejects a ticker with shell metacharacters", () => {
  // The ticker is third-party text that reaches slate_markets, the Slack slate,
  // and an operator's clipboard. It gets its OWN drop reason so a systematic
  // rejection is visible rather than hidden inside "malformed".
  for (const bad of ["KX;rm -rf /", "KX`id`", "KX$(id)", "KX&&ls", "KX A"]) {
    expect(toCandidate({ ...GOOD, ticker: bad }, WINDOW, 1000)).toEqual({
      ok: false, reason: "bad-ticker",
    })
  }
})

it("accepts a normal Kalshi ticker", () => {
  expect(toCandidate({ ...GOOD, ticker: "KXBTCD-26AUG10-B1" }, WINDOW, 1000).ok).toBe(true)
})
```

Pick the `close_time` values from inside `WINDOW`'s 09:00–21:00 ET band, or the
candidate is dropped as `close-window` before the normalization is reached — the
existing tests at `:145` and `:150` show both sides of that boundary.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/adapters/kalshi/parse.test.ts`
Expected: FAIL on both — `closeTime` is the raw string, and the hostile tickers parse.

- [ ] **Step 3: Implement**

In `parse.ts`, add the pattern and a new drop reason:

```ts
/**
 * Kalshi tickers observed in fixtures are uppercase alphanumerics with dashes.
 * Validated because the id reaches slate_markets, the Slack slate, and an
 * operator's shell. A rejected ticker gets its OWN drop reason so a systematic
 * rejection is visible rather than hidden inside "malformed".
 */
const TICKER = /^[A-Za-z0-9._-]{1,64}$/
```

Then in `toCandidate`, after the existing `id` extraction, `if (!TICKER.test(id)) return { ok: false, reason: "bad-ticker" }`, and normalize the close time with `new Date(closeTime).toISOString()` once it has passed `isIsoInstant`.

Add `"bad-ticker"` to the `DropReason` union.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/adapters && npm run typecheck`
Expected: PASS. If a recorded fixture's ticker now fails, read it — that is either a too-strict pattern or a genuinely odd ticker, and the fixture is the evidence.

- [ ] **Step 5: Commit**

```bash
git add src/adapters
git commit -m "feat(adapters): normalize close_time and validate the ticker at ingest

The per-market wager lock is a string comparison, so a date-only close_time
sorts after every same-day instant and reads as open forever. The ticker is
validated because it reaches slate_markets, the Slack slate and a shell."
```

---

### Task 4: `saveOrder` and `saveWager`

The two write paths, each owning one transaction. Read the spec's **"Two clocks"** section — the three gates and the `COALESCE` predicate are given there exactly.

**Files:**
- Modify: `src/store/types.ts`, `src/store/sqlite.ts`
- Create: `src/store/orders.test.ts`

**Interfaces:**
- Produces: `saveOrder(seasonId, day, factionId, body, now): SaveResult`; `saveWager(seasonId, day, factionId, wager, now): SaveResult`; `SaveResult = { ok: true } | { ok: false; reason: SaveRejection }`
- `SaveRejection = "day-out-of-range" | "past-deadline" | "already-resolved" | "market-locked" | "not-on-slate" | "bad-stake"`

A returned rejection rather than a throw: these are expected outcomes on a normal evening, and the CLI needs to distinguish them from a system failure by exit code.

- [ ] **Step 1: Write the failing tests**

Cover, at minimum, one test per row of the spec's Testing item 1. The two that matter most:

```ts
it("accepts a wager on an open, unsettled market", () => {
  // The NULL case. SQLite's min() returns NULL when observed_at is absent, so a
  // bare MIN(close_time, observed_at) <= now evaluates NULL and two of the three
  // natural implementations then read a CLOSED market as open.
  const store = seeded()   // slate published for day 3, market closes 20:00 ET
  expect(store.saveWager("s1", 3, "f1", W, at(14, 0))).toEqual({ ok: true })
})

it("rejects a wager on a market that settled early", () => {
  // close_time is still ahead, but the outcome is public.
  const store = seeded()
  store.recordSettlement("KX-1", "yes", at(12, 0))
  expect(store.saveWager("s1", 3, "f1", W, at(12, 30))).toEqual({
    ok: false, reason: "market-locked",
  })
})

it("rejects an order after the 21:00 deadline even with no state row", () => {
  // The clock is the deadline; the state row is the race guard. An earlier draft
  // used a lock row alone, which silently extended editing whenever a tick ran late.
  const store = seeded()
  expect(store.saveOrder("s1", 3, "f1", BODY, at(21, 1))).toEqual({
    ok: false, reason: "past-deadline",
  })
})

it("rejects an order once the day has resolved", () => {
  const store = seeded()
  store.transaction(() => store.saveState(stateFor(3)))
  expect(store.saveOrder("s1", 3, "f1", BODY, at(20, 0))).toEqual({
    ok: false, reason: "already-resolved",
  })
})

it("rejects a day outside [1, lengthDays]", () => {
  const store = seeded()
  for (const d of [0, -3, 15]) {
    expect(store.saveOrder("s1", d, "f1", BODY, at(20, 0)).ok).toBe(false)
  }
})

it("replaces a re-staked market and preserves first_staked_at", () => {
  const store = seeded()
  store.saveWager("s1", 3, "f1", { marketId: "KX-1", side: "yes", stake: 5 }, at(9, 0))
  store.saveWager("s1", 3, "f1", { marketId: "KX-1", side: "no", stake: 7 }, at(10, 0))
  const rows = store.wagersFor("s1", 3, "f1")
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ side: "no", stake: 7 })
  expect(rows[0]!.firstStakedAt).toBe(at(9, 0).toISOString())
})

it("rejects a non-integer stake", () => {
  // CHECK (stake > 0) does not enforce integrality -- INTEGER is an affinity, so
  // 1.5 binds and stores as 1.5.
  const store = seeded()
  expect(store.saveWager("s1", 3, "f1", { marketId: "KX-1", side: "yes", stake: 1.5 }, at(9, 0)))
    .toEqual({ ok: false, reason: "bad-stake" })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/store/orders.test.ts`
Expected: FAIL — the methods do not exist.

- [ ] **Step 3: Implement both writers**

Each is one `transaction(...)`. The market-lock predicate, copied from the spec:

```sql
SELECT 1
  FROM slate_markets sm
  LEFT JOIN settlements s ON s.market_id = sm.market_id
 WHERE sm.season_id = ? AND sm.day = ? AND sm.market_id = ?
   AND COALESCE(MIN(sm.close_time, s.observed_at), sm.close_time) > ?
```

A row means the market is on the day's slate **and** still open. No row means either not-on-slate or locked, so the two are distinguished by a second membership query — the caller needs to tell a player which.

`first_staked_at` is preserved with `ON CONFLICT ... DO UPDATE SET side = excluded.side, stake = excluded.stake` — do **not** include `first_staked_at` in the update list.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/store && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store
git commit -m "feat(store): saveOrder and saveWager with three gates and the market lock

Each owns one transaction: the gates and the write must be atomic or a tick can
commit between them, which is the race the deleted day_locks table used to
prevent. The lock predicate is COALESCE(MIN(close_time, observed_at), close_time)
because SQLite's min() returns NULL when a market is unsettled."
```

---

### Task 5: Order assembly

Turning two tables into the engine's `Order[]`. Read the spec's **"Order assembly"** section; all four rules there have a named failure mode.

**Files:**
- Modify: `src/store/types.ts`, `src/store/sqlite.ts`
- Create: `src/store/assembly.test.ts`

**Interfaces:**
- Produces: `assembleOrders(seasonId, day): Order[]`

- [ ] **Step 1: Write the failing tests**

```ts
it("synthesizes an Order for a faction that wagered but never submitted a body", () => {
  // The two CLI commands are independent; those wagers must not vanish.
  const store = seeded()
  store.saveWager("s1", 3, "f2", { marketId: "KX-1", side: "yes", stake: 4 }, at(9, 0))
  const orders = store.assembleOrders("s1", 3)
  expect(orders).toEqual([
    { factionId: "f2", deploys: [], attacks: [], protect: null,
      wagers: [{ marketId: "KX-1", side: "yes", stake: 4 }] },
  ])
  store.close()
})

it("excludes a malformed stake from the assembled order", () => {
  // A 1.5 stake passes CHECK (stake > 0) via type affinity but fails isCount in
  // the engine, which would publish a "bad stake" rejection naming the faction
  // and market in the recap. Filter at assembly.
  const store = seeded()
  store.rawInsertWager("s1", 3, "f1", "KX-1", "yes", 1.5, at(9, 0))
  expect(store.assembleOrders("s1", 3)[0]?.wagers ?? []).toEqual([])
  store.close()
})

it("orders wagers by first_staked_at then market_id", () => {
  // The reserve check is sequential-greedy, so this decides which bet survives a
  // short reserve. Ordering by updated_at would hand the player that lever.
  ...
})
```

`rawInsertWager` is a test-only helper that bypasses `saveWager`'s validation; add it to the store or write the row with a direct `db.prepare` in the test's setup.

- [ ] **Step 2–4: Run, implement, run**

The query joins `orders` to `order_wagers`, filters `stake > 0 AND typeof(stake) = 'integer'`, orders by `first_staked_at, market_id`, and full-outer-joins in effect — SQLite has no `FULL OUTER JOIN` before 3.39, so do two queries and merge by faction id in TypeScript rather than relying on the SQLite version.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(store): assemble Order[] from orders and order_wagers"
```

---

### Task 6: State and tick-context persistence

**Files:**
- Modify: `src/store/types.ts`, `src/store/sqlite.ts`
- Create: `src/store/state.test.ts`

**Interfaces:**
- Produces: `saveState(state)`, `loadState(seasonId, day)`, `latestSavedDay(seasonId)`, `saveTickContext(seasonId, day, orders, context, engineVersion)`, `loadTickContext(seasonId, day)`, `deleteStatesFrom(seasonId, day)`

- [ ] **Step 1: Write the failing tests**

Cover: `saveState` is an INSERT and throws on a second call for the same day; `loadState` schema-checks rather than trusting the JSON; `latestSavedDay` is `undefined` for a season with no states (not `0` — Task 9 depends on distinguishing "no deal" from "day 0 dealt"); a round-tripped `GameState` is deep-equal; `deleteStatesFrom` removes only from the named day forward.

- [ ] **Step 2–4: Run, implement, run**

`loadState` parses the JSON and validates the top-level shape (`seasonId`, `day`, `map.territories` non-empty, `ownership` and `garrisons` present, `reserves` all non-negative integers). The engine assumes nothing about its arguments and re-validates, but a corrupt row should fail at load with a clear message rather than deep inside `resolve`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(store): state and tick-context persistence, INSERT-only saveState"
```

---

### Task 7: `createSeason` takes a map

The one engine change. Read the spec's **"`createSeason` needs a map argument"** section.

**Files:**
- Modify: `src/engine/setup.ts`, `src/engine/setup.test.ts`

**Interfaces:**
- Produces: `createSeason(seasonId, factions, territoryIds, map?: GameMap)`

- [ ] **Step 1: Write the failing test**

```ts
it("stores the map it was given, not RISK_MAP", () => {
  const tiny: GameMap = {
    territories: [
      { id: "a", name: "A", continent: "x", neighbors: ["b"] },
      { id: "b", name: "B", continent: "x", neighbors: ["a"] },
    ],
    continents: [{ id: "x", name: "X", bonus: 1 }],
  }
  const s = createSeason("s1", factions.slice(0, 2), ["a", "b"], tiny)
  expect(s.map.territories.map((t) => t.id).sort()).toEqual(["a", "b"])
})

it("throws when the territory list is not the map's territory set", () => {
  // Length equality is not enough. An undealt territory still appears in
  // state.map, so validateOrder builds adjacency including it, an attack passes
  // validation, and combat reads `garrisons[to] ?? 0` -- a FREE CAPTURE by any
  // 1-troop attack. Silent corruption, not a crash.
  expect(() => createSeason("s1", factions, ids.slice(0, 41))).toThrow(/territor/i)
})

it("defaults to RISK_MAP", () => {
  expect(createSeason("s1", factions, ids).map.territories).toHaveLength(42)
})
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — the 4-argument call does not typecheck and the set check does not exist.

- [ ] **Step 3: Implement**

An **optional trailing parameter**, so all 51 existing 3-argument call sites across 11 files keep compiling. (A line-based grep of `createSeason(` reports 52 occurrences across 12 files: one is the declaration, and `src/engine/setup.test.ts:47` carries two calls on one line.)

```ts
export function createSeason(
  seasonId: string,
  factions: Faction[],
  shuffledTerritoryIds: TerritoryId[],
  map: GameMap = RISK_MAP,
): GameState {
  const mapIds = new Set(map.territories.map((t) => t.id))
  const dealt = new Set(shuffledTerritoryIds)
  if (mapIds.size !== dealt.size || [...dealt].some((id) => !mapIds.has(id))) {
    throw new Error(
      `createSeason: the dealt territories must be exactly the map's territory set ` +
        `(map ${mapIds.size}, dealt ${dealt.size})`,
    )
  }
  // ... existing body, with `map` in place of RISK_MAP
```

- [ ] **Step 4: Run the whole engine suite**

Run: `npm test && npm run typecheck`
Expected: PASS with no changes to any existing call site. If a test fails on the set check, it was passing a partial territory list — read it before "fixing" it, because that test may have been relying on the bug.

- [ ] **Step 5: Commit**

```bash
git add src/engine
git commit -m "feat(engine): createSeason accepts a map and validates the dealt set

The territory list was already an argument but the map was hardcoded, so a
non-default board produced a state whose adjacency came from the 42-territory
map -- and an undealt territory is a free capture, not a throw. Optional trailing
parameter, so all 51 existing call sites keep compiling."
```

---

### Task 8: `season-init` deals day 0

**Files:**
- Create: `src/jobs/season-init.ts`, `src/jobs/season-init.test.ts`
- Modify: `src/jobs/cli.ts`, `src/store/types.ts`, `src/store/sqlite.ts`

Read the spec's **"Season initialization"** section.

**Interfaces:**
- Produces: `runSeasonInit(deps): InitOutcome`; `insertSeason(row)` on the store (insert-only, unlike `upsertSeason`)

- [ ] **Step 1: Write the failing tests**

Cover: the same seed produces the same board; the roster drives the faction list and colors come from the palette by sorted faction id; every `checkDeal` rejection surfaces with its reason; a second init refuses; **the refusal happens before any write** (assert the `seasons` row is absent afterwards); and the whole deal is one transaction (a forced failure inserting day 0 leaves no season row).

The last one matters most: `upsertSeason` silently overwrites `start_date` and `length_days` on conflict, which would shift every calendar-keyed day under a live season.

- [ ] **Step 2–4: Run, implement, run**

The shuffle is a seeded Fisher–Yates — reuse `makeRng` from `src/sim/policies.ts` rather than writing a second PRNG, and store the seed in `seasons.seed`. Argument parsing changes: today `season-init <date> [length]` reads `Number(process.argv[4] ?? SEASON_LENGTH)`, so `--seed 4711` would land in `argv[4]` and yield `NaN`. Parse flags properly and reject `NaN`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(jobs): season-init deals day 0 from the roster with a recorded seed"
```

---

### Task 9: The tick

The centre of the plan. Read the spec's **"The tick"**, **"Why there is no lock table"**, **"Why `tick_context` still exists"** and **"The day clock"** sections in full before writing anything.

**Files:**
- Create: `src/jobs/tick.ts`, `src/jobs/tick.test.ts`

**Interfaces:**
- Consumes: `currentDay`, `tickInstant`, `checkDeal` (Task 1); `assembleOrders` (Task 5); `loadState`, `saveState`, `latestSavedDay`, `saveTickContext` (Task 6); `dailyApprovals` from `src/slack/approvals.js`; `resolve` from `src/engine/index.js`
- Produces: `runTick(deps): TickOutcome`

```ts
export type TickOutcome =
  | { status: "resolved"; day: number; next: GameState; previous: GameState }
  | { status: "skipped"; day: number; reason: "before-season" | "after-season" | "already-run" | "before-cutoff" }
  | { status: "refused"; reason: "missing-days"; from: number; to: number }
  | { status: "refused"; reason: "no-deal" }
```

A discriminated union, because the recap is reachable **only** on `"resolved"`. An earlier draft called `postRecap(next, …)` unconditionally, where `next` exists only on that branch.

- [ ] **Step 1: Write the failing guard tests**

One per row of the spec's day-clock table, plus the two refusals. The spec has a worked table of ten boundaries — use it as the test matrix.

```ts
it("refuses when a day was missed, including the FINAL day", () => {
  // lengthDays 14, day 14 missed, operator looks on day 15.
  // min(15-1, 14) = 14 and latestSaved 13 < 14 -> refuse.
  // A plainer `latestSaved + 1 < calendarDay` placed after the after-season skip
  // exits 0 here, losing the winner and confiscating day-13 wagers that can
  // never settle.
  const d = seeded({ latestSavedDay: 13 })
  expect(runTick({ ...d, now: at(15, 21, 30) })).toEqual({
    status: "refused", reason: "missing-days", from: 14, to: 14,
  })
})

it("skips after-season once every day has ticked", () => {
  const d = seeded({ latestSavedDay: 14 })
  expect(runTick({ ...d, now: at(15, 21, 30) })).toMatchObject({
    status: "skipped", reason: "after-season",
  })
})

it("skips a sequential double-fire", () => { ... })          // latestSaved 5, day 5
it("skips before the season starts", () => { ... })          // calendarDay -5
it("skips before the 21:00 cutoff", () => { ... })           // day 5, 14:00
it("refuses a season with no day-0 state", () => { ... })    // no states rows at all
it("resolves the aligned case", () => { ... })
```

The `no-deal` check runs **first**: `latestSavedDay` is undefined until it passes, and defaulting it to 0 would let a season with a `seasons` row and an empty `states` table reach the transaction and fail loading `states[0]` — a stack trace where a named refusal was intended.

- [ ] **Step 2: Write the failing behaviour tests**

```ts
it("records the assembled orders and context alongside the state", () => { ... })

it("snapshots settlements for prior pending markets, not just today's slate", () => {
  // resolve settles ALL matured pending wagers at step 1, including wagers on
  // markets absent from today's slate. Snapshotting the slate alone marks those
  // unsettled and refunds them.
  ...
})

it("leaves nothing behind when resolve throws", () => {
  const d = seeded({ latestSavedDay: 4, resolveImpl: () => { throw new Error("boom") } })
  expect(() => runTick({ ...d, now: at(5, 21, 30) })).toThrow("boom")
  expect(d.store.loadState("s1", 5)).toBeUndefined()
  expect(d.store.loadTickContext("s1", 5)).toBeUndefined()
})

it("returns already-run for a second call after a saved state, without a recap", () => { ... })
```

Inject `resolve` as a dependency so the throwing case is testable without breaking the engine.

- [ ] **Step 3: Run to verify they fail**

Expected: FAIL — `Cannot find module './tick.js'`.

- [ ] **Step 4: Implement `runTick`**

Follow the spec's pseudocode exactly. The guard order is load-bearing and the `min(calendarDay - 1, lengthDays)` clamp is the reason the final-day case works.

- [ ] **Step 5: Run and typecheck**

Run: `npx vitest run src/jobs/tick.test.ts && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/jobs/tick.ts src/jobs/tick.test.ts
git commit -m "feat(jobs): the 21:00 tick in one transaction

Claim, resolve and save share one BEGIN IMMEDIATE, so a concurrent second run
sees the state row and returns already-run rather than duplicating the resolve,
and a crash rolls back to nothing. The day-clock guard is calendar-derived and
ordered so a missed FINAL day is not masked by the after-season skip."
```

---

### Task 10: The recap ledger

**Files:**
- Modify: `src/jobs/post-recap.ts`, `src/jobs/post-recap.test.ts`, `src/store/sqlite.ts`

Read the spec's **"Failure and recovery"** section for the `attempt` semantics.

- [ ] **Step 1: Write the failing tests**

Cover: a second `postRecap` for the same `(day, kind, attempt)` posts nothing; a post that throws *after* the ledger insert leaves the row present, so a plain retry skips and `--force` inserts a new attempt and posts; a second `correction` for the same day posts (the `attempt` column is what allows it); and the non-`--force` path pins `attempt` to a fixed value, or the suppression never fires.

That last point is subtle: "skip when a row exists for that `(day, kind, attempt)`" is trivially false for a fresh attempt, so the default path must use a fixed attempt number (1) and `--force` must use `max(attempt) + 1`.

- [ ] **Step 2–4: Run, implement, run**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(jobs): recap idempotency ledger with an attempt column"
```

---

### Task 11: `tick:rerun` and `--assemble-missing`

**Files:**
- Create: `src/jobs/rerun.ts`, `src/jobs/rerun.test.ts`

Read the spec's **"Failure and recovery"** section. The whole rerun is one transaction, its day range is `<day> .. min(calendarDay - 1, lengthDays)`, and `--assemble-missing` needs its own forward guard.

- [ ] **Step 1: Write the failing tests**

Cover: replays produce identical states **after mutating the world** (add a settlement, `deletePost`, `removeApproval` between the original tick and the replay — this is the test the pre-`tick_context` design could not have passed); the range covers every day through `min(calendarDay - 1, lengthDays)`; without `--confirm` nothing is deleted; day 0, a negative day, a non-integer and a day past `lengthDays` are refused; a recorded `engine_version` differing from the running one logs and **proceeds**; and `--assemble-missing` refuses `day === calendarDay` before 21:00.

- [ ] **Step 2–4: Run, implement, run**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(jobs): tick:rerun with a stated day range and --assemble-missing"
```

---

### Task 12: The order-entry CLI

**Files:**
- Create: `src/jobs/order-entry.ts`, `src/jobs/order-entry.test.ts`
- Modify: `src/jobs/cli.ts`, `package.json`

Read the spec's **"Order entry"** section — the body comes from a file or stdin, never a shell argument, and the array caps have stated numbers.

- [ ] **Step 1: Write the failing tests**

Cover: a valid body parses; an unknown field is rejected; `deploys`/`attacks` beyond the map's territory count are rejected; `wagers` beyond `SLATE_MAX` are rejected; a non-integer count is rejected; and a lock rejection from the store maps to a distinct exit code from a system failure.

- [ ] **Step 2–4: Run, implement, run**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(jobs): order and wager entry from a file or stdin"
```

---

### Task 13: Commit the balance run

**Files:**
- Create: `docs/superpowers/reviews/2026-08-10-balance-run-14day.md`

The spec's season-length decision rests on a measurement, and a reviewer cannot check a number that exists only in a chat log.

- [ ] **Step 1: Run both, on the authoritative roster**

```bash
npm run sim -- Blitz Consolidator Hunter Slacker GymRat Gambler   # now 14 days
```

`docs/superpowers/reviews/2026-08-09-balance-run.md:12` labels that roster authoritative and `:112` marks the CLI default superseded. Then re-run at 21 days by temporarily setting `SEASON_LENGTH = 21`, and revert.

- [ ] **Step 2: Write the document**

Record both runs verbatim with the roster named, the ±0.89 pp (1σ) standard error, the note that the runs are **paired** (identical seeds, and the 14-day season is a prefix of the 21-day one through day 13, so the day-3 leader is the same faction per seed), and the judgement that +3.3 points against a 16.7% baseline is short of "usually".

Expected, from the measurement already taken: 19.5% at 21 days and 22.8% at 14, spread 9.1–20.8% and 9.8–20.4%.

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: balance run at 14 days on the authoritative roster"
```

---

### Task 14: Deployment, the network guard, and the doc sweep

**Files:**
- Create: `deploy/riskety-tick.service`, `deploy/riskety-tick.timer`, `test/no-network.ts`
- Modify: `vitest.config.ts`, `deploy/README.md`, `deploy/riskety-poll-settlements.service`, `README.md`, `HANDOFF.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-08-09-riskety-rekt-design.md`

Read the spec's **"Deployment"** and **"Surfaces this change touches"** sections. The surfaces table is the checklist for this task.

- [ ] **Step 1: Enforce the no-network rule**

```ts
// test/no-network.ts
globalThis.fetch = (() => {
  throw new Error("no test may make a network call")
}) as typeof fetch
```

Add `setupFiles: ["test/no-network.ts"]` to `vitest.config.ts`. Run the suite: any test that now fails was making a real request, which is exactly what this catches.

- [ ] **Step 2: Write the tick unit**

`OnCalendar=*-*-* 21:00:30` — the `:30` offset keeps the tick off the settlement poller's exact firing instant (`*:00/30`), whose write loop would otherwise be able to tear the settlement snapshot that `tick_context` makes permanently authoritative. `Restart=on-failure`, `RestartSec=60`, `StartLimitBurst=5`, `StartLimitIntervalSec=1800`. Rely on the system `TZ` like the existing units — do not add an inline zone.

- [ ] **Step 3: Make the poller's write loop transactional**

`src/jobs/poll-settlements.ts:43-47` writes each outcome in its own autocommit. Wrap the loop in `store.transaction(...)` so the tick cannot observe a partial poll.

- [ ] **Step 4: Work the surfaces table**

Every row of the spec's "Surfaces this change touches" table, including the six stale `21`-day references and the stale `claimTick` line in the canonical design spec, and `CLAUDE.md`'s "Not built" section.

- [ ] **Step 5: Full verification**

```bash
npm test
npm run typecheck
npm run sim
RR_DB_PATH=/tmp/rr-e2e.db RR_SEASON_ID=s1 npm run season:init -- 2026-09-01 --seed 4711
RR_DB_PATH=/tmp/rr-e2e.db RR_SEASON_ID=s1 npm run order -- f1 --file /tmp/order.json
RR_DB_PATH=/tmp/rr-e2e.db RR_SEASON_ID=s1 npm run tick
rm -f /tmp/rr-e2e.db*
```

The tick will skip `before-cutoff` unless run after 21:00 ET; that is correct behaviour, not a failure. To exercise the resolved path, deal a season whose day 1 is in the past.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(deploy): tick timer, enforced no-network tests, and the doc sweep"
```

---

## What this plan does not build

- **The pluggable-mechanics refactor.** Its own spec and plan. It changes `GameState` (`pending` → `moduleState`), which regenerates the golden file, and reorders spend claims, which changes combat outcomes and needs a fresh balance run.
- **The wager economy's stale-price exploit.** Late placement at the frozen 08:00 price is roughly +94% EV; the fix is periodic price snapshots. Its own spec. **This blocks a competitive season**, and the tick runner does not change that.
- **The map.** A board of ~15 variable-size continents. Its own spec. `season-init` will refuse a 15-member roster on the 42-territory default via `checkDeal`, which is the correct behaviour and also means a full-headcount season cannot be dealt until the map exists.
- **The web app, the projection and the renderer.** Until they exist, order entry is CLI-only, and **the operator can read every faction's deploys, attacks and protect picks** straight out of SQLite. A competitive season does not start on the CLI path.
