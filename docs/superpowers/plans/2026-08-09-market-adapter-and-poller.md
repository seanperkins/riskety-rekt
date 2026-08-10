# Riskety Rekt — Market Adapter & Settlement Poller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the engine real prediction markets — fetch Kalshi candidates, pick a daily slate, snapshot its prices to SQLite at 08:00, and poll settlements every 30 minutes — so that by the end the tick has both halves of `DailyContext.slate` and `DailyContext.settlements` available locally without ever touching the network.

**Architecture:** A `MarketAdapter` fronts Kalshi and is the only code that speaks HTTP. It is split into a network layer (`client.ts`, pagination and timeouts) and a pure parse/validate layer (`parse.ts`) so that every hostile-input test runs offline. Slate selection is pure. A small SQLite store persists the slate and settlements. Two idempotent CLI jobs — `publish-slate` and `poll-settlements` — compose those pieces and are driven by systemd timers.

**Tech Stack:** TypeScript 5.x (strict), Vitest, Node 24. `node:sqlite` (`DatabaseSync`) for persistence — built in, so the project stays at zero runtime dependencies. Global `fetch`. No new packages.

**Spec:** `docs/superpowers/specs/2026-08-09-riskety-rekt-design.md`

**This is Plan 2 of 4.** Plan 1 (engine + sim) is complete. Plans 3 and 4 cover Slack ingress + recap and the Next.js web app + renderer + deployment.

## Global Constraints

- `src/engine/**` stays untouched by this plan. Nothing in `src/engine/` may import from `src/adapters/`, `src/store/`, `src/slate/`, or `src/jobs/`. `src/engine/types.test.ts` already enforces this — do not weaken it.
- **The tick never touches the network.** Everything this plan builds writes to SQLite ahead of time. No code in this plan is called from `resolve()`.
- **Adapters own all validation at the boundary.** A `Market` that reaches the store has already been proven to have finite `priceYes` and `priceNo` strictly inside `(0, 1)`. `Math.max(0.05, Math.min(0.95, NaN))` is `NaN` — a clamp does not filter `NaN`, and a `NaN` price persisted to disk poisons every subsequent tick.
- **Never parse a numeric field with bare `Number()`.** `Number("")` is `0` and `Number(null)` is `0`. Kalshi returns prices as decimal strings and a missing quote as `""`. Use the strict `parseDecimal` from Task 2 everywhere.
- **Determinism.** Never iterate an object's keys without sorting them first. Every tie-break is explicit. Jobs take their clock as an injected argument, never `Date.now()` inline, so tests can pin time.
- All prices are numbers in `(0, 1)`. All volumes and day numbers are finite non-negative numbers.
- Test files live beside the code as `*.test.ts`. **No test may make a network call.** Tests inject a fake `fetch`; the only code that touches the real API is `scripts/sample-kalshi.ts`, which is a developer tool and has no tests.
- Times are pinned to `America/New_York`. Never construct a local-time `Date` from parts without going through `src/time.ts`.

## Findings from the live API that shaped this plan

These were measured against `api.elections.kalshi.com` on 2026-08-09 and several contradict the spec. Each is resolved in a task below and restated in **Spec deltas** at the end.

| Finding | Consequence |
|---|---|
| A single same-day close window returned **5,748 markets across 6 pages** | Pagination is mandatory, not optional |
| **757 of 1,000** same-day markets have zero volume; the median volume is **0.00** | The spec's "set the floor at the median" yields a floor of 0, which admits everything. Use the median of *non-zero* markets (≈602 observed) |
| Filtered candidates cluster into strike ladders — 2,257 markets across only **44 distinct series** | "Pick 3–5 ordered by market id" would publish five rungs of one SOL price ladder. Selection must take at most one market per series |
| Prices are decimal **strings** (`"0.3800"`), not integer cents | Strict string parsing required; `Number("")` is `0` |
| `liquidity_dollars` is `"0.0000"` on every market in list responses | Unusable as a filter. `volume_fp` is the only workable liquidity signal |
| `?status=settled` returns markets whose `status` field reads `"finalized"` | Never compare the response status to the query value |
| `?tickers=A,B` works but returns rows in arbitrary order | Map the response by ticker; never zip by index |
| Every market sampled carries `can_close_early: true` | A market can settle before its stated `closeTime`, making the outcome public while wagers are still editable — the exact exploit the per-market lock exists to close |

## File Structure

```
src/config.ts                              constants; the single place a tunable lives
src/time.ts                                America/New_York date and instant helpers
src/adapters/types.ts                      MarketAdapter + Candidate
src/adapters/kalshi/raw.ts                 shape of the Kalshi wire format
src/adapters/kalshi/parse.ts               pure: raw JSON -> Candidate | drop reason
src/adapters/kalshi/client.ts              HTTP: timeout, retry, cursor pagination
src/adapters/kalshi/index.ts               KalshiAdapter: getCandidates, getSettlements
src/adapters/kalshi/__fixtures__/          recorded real responses
src/slate/select.ts                        pure: candidates -> the day's 3-5 markets
src/store/schema.ts                        DDL + user_version migration runner
src/store/types.ts                         the store interface this plan implements
src/store/sqlite.ts                        SqliteStore
src/jobs/publish-slate.ts                  the 08:00 job
src/jobs/poll-settlements.ts               the 30-minute job
src/jobs/cli.ts                            argv entrypoint for systemd
scripts/sample-kalshi.ts                   developer tool: derive the volume floor
deploy/                                    systemd units
```

Network and parsing are separate files on purpose: every interesting failure mode is a parsing failure, and parsing tests must not need a socket.

---

### Task 1: Config and America/New_York time helpers

Every later task depends on these two files, and the time helpers are the single trickiest piece of non-game logic in the project — DST is where daily-cron systems break.

**Files:**
- Create: `src/config.ts`
- Create: `src/time.ts`
- Test: `src/config.test.ts`
- Test: `src/time.test.ts`

**Interfaces:**
- Consumes: `PRICE_FLOOR`, `PRICE_CEIL` from `src/engine/index.js`
- Produces: all constants below; `etDate(at: Date): string`, `etInstant(date: string, hour: number, minute?: number): Date`, `etDaysBetween(from: string, to: string): number`

- [ ] **Step 1: Write `src/config.ts`**

```ts
/** Season shape. Mirrors the spec's "21 days, one tick per day". */
export const SEASON_LENGTH = 21

/** Slate size target. Fewer is published if fewer candidates survive filtering. */
export const SLATE_MIN = 3
export const SLATE_MAX = 5

/** Candidate close window, in America/New_York hours on the slate's own day. */
export const WINDOW_OPEN_HOUR = 9
export const WINDOW_CLOSE_HOUR = 21

/**
 * Price band for slate eligibility. Must equal the engine's payout clamp, or a
 * market could be published at a price the engine then silently clamps away.
 * src/config.test.ts asserts the equality.
 */
export const PRICE_MIN = 0.1
export const PRICE_MAX = 0.9

/**
 * Minimum 24h-cumulative volume, in dollars, for a market to be slate-eligible.
 *
 * Set in Task 5 from a week of observed same-day Kalshi markets. The spec said
 * "set it at the median", but the observed median is 0.00 -- roughly 75% of
 * same-day markets never trade. This is the median of markets with non-zero
 * volume, rounded up to a round number. Re-derive with `npm run sample:kalshi`.
 */
export const VOLUME_FLOOR = 1000

/** Third-party text cap. A 5,000-char title wrecks the recap layout. */
export const QUESTION_MAX_CHARS = 200

export const TIMEZONE = "America/New_York"

export const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
export const HTTP_TIMEOUT_MS = 20_000
export const HTTP_RETRIES = 2
export const HTTP_RETRY_DELAY_MS = 1_000
/** Hard stop on cursor pagination. One observed window needed 6 pages. */
export const MAX_PAGES = 12
/** Kalshi caps `limit` at 1000. */
export const PAGE_LIMIT = 1000
/** Max tickers per `?tickers=` settlement query. */
export const SETTLEMENT_BATCH_SIZE = 100

/**
 * How far back the poller looks for unsettled markets. Wagers refund after 2
 * ticks, so anything older than this can never affect a live wager.
 */
export const SETTLEMENT_HORIZON_DAYS = 4
```

- [ ] **Step 2: Write the failing config test**

`src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { PRICE_CEIL, PRICE_FLOOR } from "./engine/index.js"
import { PRICE_MAX, PRICE_MIN, SLATE_MAX, SLATE_MIN, VOLUME_FLOOR } from "./config.js"

describe("config", () => {
  it("keeps the slate price band identical to the engine payout clamp", () => {
    // If these drift, a market is published at a price the engine clamps away,
    // and a player's payout silently stops matching the odds they were shown.
    expect(PRICE_MIN).toBe(PRICE_FLOOR)
    expect(PRICE_MAX).toBe(PRICE_CEIL)
  })

  it("has a sane slate size", () => {
    expect(SLATE_MIN).toBeGreaterThan(0)
    expect(SLATE_MAX).toBeGreaterThanOrEqual(SLATE_MIN)
  })

  it("has a volume floor above zero", () => {
    // The observed median same-day volume is 0.00; a zero floor admits the
    // ~75% of markets that never trade.
    expect(VOLUME_FLOOR).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Run it**

Run: `npx vitest run src/config.test.ts`
Expected: PASS (config.ts already written). If `PRICE_MIN`/`PRICE_FLOOR` mismatch, fix `config.ts`, not the engine.

- [ ] **Step 4: Write the failing time test**

`src/time.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { etDate, etDaysBetween, etInstant } from "./time.js"

describe("etDate", () => {
  it("returns the ET calendar date, not the UTC one", () => {
    // 02:30 UTC on Aug 10 is 22:30 ET on Aug 9 -- the classic off-by-one-day bug.
    expect(etDate(new Date("2026-08-10T02:30:00Z"))).toBe("2026-08-09")
  })

  it("handles midday", () => {
    expect(etDate(new Date("2026-08-10T16:00:00Z"))).toBe("2026-08-10")
  })
})

describe("etInstant", () => {
  it("resolves 09:00 during EDT to 13:00 UTC", () => {
    expect(etInstant("2026-08-10", 9).toISOString()).toBe("2026-08-10T13:00:00.000Z")
  })

  it("resolves 09:00 during EST to 14:00 UTC", () => {
    expect(etInstant("2026-01-15", 9).toISOString()).toBe("2026-01-15T14:00:00.000Z")
  })

  it("resolves 21:00 on the day DST begins", () => {
    // 2026-03-08 is the spring-forward date. 21:00 is well after the 02:00
    // transition, so the day is EDT by then.
    expect(etInstant("2026-03-08", 21).toISOString()).toBe("2026-03-09T01:00:00.000Z")
  })

  it("resolves 21:00 on the day DST ends", () => {
    // 2026-11-01 falls back at 02:00; 21:00 is EST.
    expect(etInstant("2026-11-01", 21).toISOString()).toBe("2026-11-02T02:00:00.000Z")
  })

  it("accepts minutes", () => {
    expect(etInstant("2026-08-10", 8, 30).toISOString()).toBe("2026-08-10T12:30:00.000Z")
  })
})

describe("etDaysBetween", () => {
  it("counts whole calendar days", () => {
    expect(etDaysBetween("2026-08-01", "2026-08-10")).toBe(9)
  })

  it("is zero for the same day", () => {
    expect(etDaysBetween("2026-08-10", "2026-08-10")).toBe(0)
  })

  it("is unaffected by a DST transition in the interval", () => {
    // March 1 -> March 15 spans spring-forward. A naive
    // (msB - msA) / 86_400_000 on local timestamps gives 13.958 and floors to 13.
    expect(etDaysBetween("2026-03-01", "2026-03-15")).toBe(14)
  })

  it("goes negative before the start", () => {
    expect(etDaysBetween("2026-08-10", "2026-08-08")).toBe(-2)
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run src/time.test.ts`
Expected: FAIL — `Failed to resolve import "./time.js"`

- [ ] **Step 6: Write `src/time.ts`**

```ts
import { TIMEZONE } from "./config.js"

const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

const OFFSET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  timeZoneName: "longOffset",
})

/** The America/New_York calendar date of an instant, as "YYYY-MM-DD". */
export function etDate(at: Date): string {
  return DATE_FMT.format(at)
}

/** UTC offset of America/New_York at an instant, in minutes (-240 in EDT). */
function offsetMinutes(at: Date): number {
  const name = OFFSET_FMT.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT"
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name)
  if (!m) return 0 // bare "GMT" means a zero offset
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

/**
 * The instant at which the clock in America/New_York reads `hour:minute` on the
 * given ET calendar date.
 *
 * Two passes: the offset itself depends on the instant we are solving for, so
 * the first pass uses the offset at the naive UTC guess and the second corrects
 * it. Only a date whose offset changes between the guess and the answer needs
 * the second pass, but it always converges because ET has one transition per
 * date at most.
 */
export function etInstant(date: string, hour: number, minute = 0): Date {
  const [y, mo, d] = date.split("-").map(Number)
  if (y === undefined || mo === undefined || d === undefined) {
    throw new Error(`etInstant: not a YYYY-MM-DD date: ${date}`)
  }
  const naive = Date.UTC(y, mo - 1, d, hour, minute)
  const first = naive - offsetMinutes(new Date(naive)) * 60_000
  const second = naive - offsetMinutes(new Date(first)) * 60_000
  return new Date(second)
}

/**
 * Whole calendar days from one ET date to another.
 *
 * Both dates are read as UTC midnight, so a DST transition inside the interval
 * cannot shift the count -- the whole point of counting in dates, not hours.
 */
export function etDaysBetween(from: string, to: string): number {
  const parse = (s: string) => {
    const [y, mo, d] = s.split("-").map(Number)
    if (y === undefined || mo === undefined || d === undefined) {
      throw new Error(`etDaysBetween: not a YYYY-MM-DD date: ${s}`)
    }
    return Date.UTC(y, mo - 1, d)
  }
  return Math.round((parse(to) - parse(from)) / 86_400_000)
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/time.test.ts src/config.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/config.ts src/config.test.ts src/time.ts src/time.test.ts
git commit -m "feat(config): slate constants and DST-safe America/New_York helpers"
```

---

### Task 2: Kalshi wire types and the pure parser

The parser is where every hostile input dies. It never sees a socket, so all of its tests are fast and offline.

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/adapters/kalshi/raw.ts`
- Create: `src/adapters/kalshi/parse.ts`
- Test: `src/adapters/kalshi/parse.test.ts`

**Interfaces:**
- Consumes: `Market`, `MarketId`, `Settlement` from `src/engine/index.js`; `PRICE_MIN`, `PRICE_MAX`, `QUESTION_MAX_CHARS` from `src/config.js`
- Produces:
  - `interface Candidate extends Market { volume: number; series: string }`
  - `interface MarketAdapter { getCandidates(w: CandidateWindow): Promise<Candidate[]>; getSettlements(ids: MarketId[]): Promise<Record<MarketId, Settlement>> }`
  - `interface CandidateWindow { opensAfter: Date; closesBefore: Date }`
  - `parseDecimal(v: unknown): number`
  - `capQuestion(v: unknown): string | null`
  - `seriesOf(ticker: string): string`
  - `type DropReason`
  - `toCandidate(raw: unknown, w: CandidateWindow, volumeFloor: number): { ok: true; candidate: Candidate } | { ok: false; reason: DropReason }`
  - `toSettlement(raw: unknown): Settlement`

- [ ] **Step 1: Write `src/adapters/types.ts`**

```ts
import type { Market, MarketId, Settlement } from "../engine/index.js"

/**
 * A slate-eligible market plus the two fields selection needs and the engine
 * does not: how much it has traded, and which series it belongs to.
 */
export interface Candidate extends Market {
  volume: number
  series: string
}

/**
 * The close-time window a candidate must fall inside. Passed in rather than
 * computed, so the adapter holds no clock and its tests pin time exactly.
 */
export interface CandidateWindow {
  opensAfter: Date
  closesBefore: Date
}

export interface MarketAdapter {
  getCandidates(window: CandidateWindow): Promise<Candidate[]>
  getSettlements(ids: MarketId[]): Promise<Record<MarketId, Settlement>>
}
```

- [ ] **Step 2: Write `src/adapters/kalshi/raw.ts`**

```ts
/**
 * The subset of Kalshi's market object this project reads.
 *
 * Every field is `unknown`: this is untrusted wire data, and typing it as
 * `string` would let `parse.ts` skip the checks that make it safe. Narrowing
 * happens in `parse.ts` and nowhere else.
 */
export interface RawKalshiMarket {
  ticker?: unknown
  event_ticker?: unknown
  title?: unknown
  status?: unknown
  result?: unknown
  open_time?: unknown
  close_time?: unknown
  volume_fp?: unknown
  yes_bid_dollars?: unknown
  yes_ask_dollars?: unknown
  no_bid_dollars?: unknown
  no_ask_dollars?: unknown
  /** Present on multivariate combo markets, whose titles are machine gibberish. */
  mve_collection_ticker?: unknown
}

export interface RawKalshiMarketsResponse {
  markets?: unknown
  cursor?: unknown
}
```

- [ ] **Step 3: Write the failing parser test**

`src/adapters/kalshi/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { PRICE_MAX, PRICE_MIN } from "../../config.js"
import { capQuestion, parseDecimal, seriesOf, toCandidate, toSettlement } from "./parse.js"
import type { CandidateWindow } from "../types.js"

const WINDOW: CandidateWindow = {
  opensAfter: new Date("2026-08-10T13:00:00Z"), // 09:00 ET
  closesBefore: new Date("2026-08-11T01:00:00Z"), // 21:00 ET
}

/** A real market, trimmed. Verbatim from the API on 2026-08-09. */
const GOOD = {
  ticker: "KXURYPDGAME-26AUG08TORPEN-PEN",
  event_ticker: "KXURYPDGAME-26AUG08TORPEN",
  title: "Montevideo City vs Penarol Winner?",
  status: "active",
  result: "",
  open_time: "2026-08-05T05:36:00Z",
  close_time: "2026-08-10T21:30:00Z",
  volume_fp: "38457.31",
  yes_bid_dollars: "0.3800",
  yes_ask_dollars: "0.5300",
  no_bid_dollars: "0.4700",
  no_ask_dollars: "0.6200",
}

describe("parseDecimal", () => {
  it("parses a decimal string", () => {
    expect(parseDecimal("0.3800")).toBe(0.38)
  })

  it("returns NaN for empty string", () => {
    // Number("") is 0. A missing quote must never become a free price of zero.
    expect(parseDecimal("")).toBeNaN()
  })

  it("returns NaN for null and undefined", () => {
    expect(parseDecimal(null)).toBeNaN()
    expect(parseDecimal(undefined)).toBeNaN()
  })

  it("returns NaN for non-numeric text", () => {
    expect(parseDecimal("abc")).toBeNaN()
    expect(parseDecimal("0.38abc")).toBeNaN()
  })

  it("returns NaN for whitespace", () => {
    expect(parseDecimal("   ")).toBeNaN()
  })

  it("rejects the numeric literals Number() accepts", () => {
    // Number("0x10") is 16, Number("1e3") is 1000, Number("Infinity") is Infinity.
    expect(parseDecimal("0x10")).toBeNaN()
    expect(parseDecimal("1e3")).toBeNaN()
    expect(parseDecimal("Infinity")).toBeNaN()
  })

  it("passes through finite numbers", () => {
    expect(parseDecimal(0.38)).toBe(0.38)
  })

  it("returns NaN for non-finite numbers", () => {
    expect(parseDecimal(Number.NaN)).toBeNaN()
    expect(parseDecimal(Number.POSITIVE_INFINITY)).toBeNaN()
  })
})

describe("capQuestion", () => {
  it("keeps a normal title", () => {
    expect(capQuestion("Montevideo City vs Penarol Winner?")).toBe(
      "Montevideo City vs Penarol Winner?",
    )
  })

  it("collapses whitespace", () => {
    expect(capQuestion("a\n\n  b\tc")).toBe("a b c")
  })

  it("truncates past the cap", () => {
    const out = capQuestion("x".repeat(500))
    expect(out).not.toBeNull()
    expect(out!.length).toBe(200)
  })

  it("returns null for empty or non-string", () => {
    expect(capQuestion("")).toBeNull()
    expect(capQuestion("   ")).toBeNull()
    expect(capQuestion(null)).toBeNull()
    expect(capQuestion(42)).toBeNull()
  })

  it("does not alter hostile text -- escaping belongs at the render sink", () => {
    // Encoding is per-sink (Block Kit plain_text, JSX, SVG escaping). Mangling
    // it here would give a false sense of safety at the sinks that matter.
    expect(capQuestion("</text><script>alert(1)</script>")).toBe(
      "</text><script>alert(1)</script>",
    )
    expect(capQuestion("<!channel> who wins?")).toBe("<!channel> who wins?")
  })
})

describe("seriesOf", () => {
  it("takes the segment before the first dash", () => {
    expect(seriesOf("KXSOLE-26AUG1017-B74")).toBe("KXSOLE")
  })

  it("handles a ticker with no dash", () => {
    expect(seriesOf("PLAIN")).toBe("PLAIN")
  })
})

describe("toCandidate", () => {
  it("accepts a real market and snapshots both side mids", () => {
    const r = toCandidate(GOOD, WINDOW, 1000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.candidate).toEqual({
      id: "KXURYPDGAME-26AUG08TORPEN-PEN",
      question: "Montevideo City vs Penarol Winner?",
      priceYes: 0.455, // (0.38 + 0.53) / 2
      priceNo: 0.545, // (0.47 + 0.62) / 2
      closeTime: "2026-08-10T21:30:00Z",
      volume: 38457.31,
      series: "KXURYPDGAME",
    })
  })

  it("stores priceNo explicitly rather than deriving 1 - priceYes", () => {
    const r = toCandidate(GOOD, WINDOW, 1000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Kalshi quotes each side with its own spread. Deriving would be wrong the
    // moment the two mids do not sum to exactly 1.
    expect(r.candidate.priceNo).toBe(0.545)
    expect(r.candidate.priceNo).not.toBe(1 - 0.455 + Number.EPSILON)
  })

  it("drops multivariate combo markets", () => {
    const r = toCandidate({ ...GOOD, mve_collection_ticker: "KXMVE-R" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "multivariate" })
  })

  it("drops a market closing at or after the window end", () => {
    // A market closing at exactly 21:00:00 ET is excluded -- the spec is explicit.
    const r = toCandidate({ ...GOOD, close_time: "2026-08-11T01:00:00Z" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "close-window" })
  })

  it("drops a market closing before the window opens", () => {
    const r = toCandidate({ ...GOOD, close_time: "2026-08-10T12:00:00Z" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "close-window" })
  })

  it("drops a market with an unparseable close time", () => {
    const r = toCandidate({ ...GOOD, close_time: "not a date" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "malformed" })
  })

  it("drops a market below the volume floor", () => {
    const r = toCandidate({ ...GOOD, volume_fp: "999.99" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "volume" })
  })

  it("accepts a market exactly at the volume floor", () => {
    const r = toCandidate({ ...GOOD, volume_fp: "1000" }, WINDOW, 1000)
    expect(r.ok).toBe(true)
  })

  it("drops a market with a missing quote rather than treating it as zero", () => {
    const r = toCandidate({ ...GOOD, yes_bid_dollars: "" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "malformed" })
  })

  it("drops a market whose volume is unparseable", () => {
    const r = toCandidate({ ...GOOD, volume_fp: "" }, WINDOW, 1000)
    expect(r).toEqual({ ok: false, reason: "malformed" })
  })

  it("drops a market priced outside the band on either side", () => {
    // yes mid 0.05, no mid 0.95
    const cheap = {
      ...GOOD,
      yes_bid_dollars: "0.0400",
      yes_ask_dollars: "0.0600",
      no_bid_dollars: "0.9400",
      no_ask_dollars: "0.9600",
    }
    expect(toCandidate(cheap, WINDOW, 1000)).toEqual({ ok: false, reason: "price-range" })
  })

  it("accepts a market exactly on the band edges", () => {
    const edge = {
      ...GOOD,
      yes_bid_dollars: "0.0900",
      yes_ask_dollars: "0.1100", // mid 0.10
      no_bid_dollars: "0.8900",
      no_ask_dollars: "0.9100", // mid 0.90
    }
    const r = toCandidate(edge, WINDOW, 1000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.candidate.priceYes).toBeCloseTo(PRICE_MIN, 10)
    expect(r.candidate.priceNo).toBeCloseTo(PRICE_MAX, 10)
  })

  it("drops a crossed book whose sides sum below 1", () => {
    // If the two independently-snapshotted mids sum below 1.0, the both-sides
    // hedge would pay more than the intended 10%. One-wager-per-market already
    // blocks it in the engine; this is the second lock on the same door.
    const crossed = {
      ...GOOD,
      yes_bid_dollars: "0.3000",
      yes_ask_dollars: "0.4000", // mid 0.35
      no_bid_dollars: "0.5000",
      no_ask_dollars: "0.6000", // mid 0.55, sum 0.90
    }
    expect(toCandidate(crossed, WINDOW, 1000)).toEqual({ ok: false, reason: "crossed-book" })
  })

  it("drops a market with no usable title", () => {
    expect(toCandidate({ ...GOOD, title: "" }, WINDOW, 1000)).toEqual({
      ok: false,
      reason: "malformed",
    })
  })

  it("drops a market with no ticker", () => {
    expect(toCandidate({ ...GOOD, ticker: "" }, WINDOW, 1000)).toEqual({
      ok: false,
      reason: "malformed",
    })
  })

  it("drops junk instead of throwing", () => {
    for (const junk of [null, undefined, 42, "string", [], {}]) {
      const r = toCandidate(junk, WINDOW, 1000)
      expect(r.ok).toBe(false)
    }
  })

  it("never emits a non-finite price", () => {
    // The clamp in the engine cannot filter NaN: Math.max(a, Math.min(b, NaN))
    // is NaN, and a NaN price persisted to disk poisons every later tick.
    const nan = { ...GOOD, yes_bid_dollars: "NaN", yes_ask_dollars: "NaN" }
    expect(toCandidate(nan, WINDOW, 1000)).toEqual({ ok: false, reason: "malformed" })
  })
})

describe("toSettlement", () => {
  it("maps a finalized yes", () => {
    expect(toSettlement({ status: "finalized", result: "yes" })).toBe("yes")
  })

  it("maps a finalized no", () => {
    expect(toSettlement({ status: "finalized", result: "no" })).toBe("no")
  })

  it("maps a settled status too", () => {
    expect(toSettlement({ status: "settled", result: "yes" })).toBe("yes")
  })

  it("treats an active market as unsettled even if a result leaked in", () => {
    expect(toSettlement({ status: "active", result: "yes" })).toBe("unsettled")
  })

  it("treats an empty or void result as unsettled", () => {
    // Void rolls forward and is refunded by the engine at 2 ticks.
    expect(toSettlement({ status: "finalized", result: "" })).toBe("unsettled")
    expect(toSettlement({ status: "finalized", result: "void" })).toBe("unsettled")
  })

  it("treats junk as unsettled", () => {
    for (const junk of [null, undefined, 42, "yes", []]) {
      expect(toSettlement(junk)).toBe("unsettled")
    }
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/adapters/kalshi/parse.test.ts`
Expected: FAIL — `Failed to resolve import "./parse.js"`

- [ ] **Step 5: Write `src/adapters/kalshi/parse.ts`**

```ts
import { PRICE_MAX, PRICE_MIN, QUESTION_MAX_CHARS } from "../../config.js"
import type { Settlement } from "../../engine/index.js"
import type { Candidate, CandidateWindow } from "../types.js"
import type { RawKalshiMarket } from "./raw.js"

export type DropReason =
  | "multivariate"
  | "malformed"
  | "close-window"
  | "volume"
  | "price-range"
  | "crossed-book"

export type CandidateResult =
  | { ok: true; candidate: Candidate }
  | { ok: false; reason: DropReason }

/** Only plain decimals. Deliberately narrower than Number(). */
const DECIMAL = /^-?\d+(\.\d+)?$/

/**
 * Strict numeric parse of untrusted wire data.
 *
 * `Number("")` is 0 and `Number(null)` is 0, so a missing Kalshi quote parsed
 * with `Number` becomes a free price of zero. `Number("0x10")` is 16 and
 * `Number("Infinity")` is Infinity. Everything that is not a plain finite
 * decimal returns NaN, and every caller must check.
 */
export function parseDecimal(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN
  if (typeof v !== "string") return Number.NaN
  const s = v.trim()
  if (!DECIMAL.test(s)) return Number.NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : Number.NaN
}

/**
 * Normalize and length-cap third-party question text.
 *
 * Deliberately does NOT escape anything. Each sink has its own encoding --
 * Block Kit `plain_text` for Slack, JSX for the web, entity escaping for SVG --
 * and escaping here would both double-encode and hide the real requirement.
 */
export function capQuestion(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = v.replace(/\s+/g, " ").trim()
  if (s.length === 0) return null
  return s.length > QUESTION_MAX_CHARS ? s.slice(0, QUESTION_MAX_CHARS) : s
}

/** The series a ticker belongs to: "KXSOLE-26AUG1017-B74" -> "KXSOLE". */
export function seriesOf(ticker: string): string {
  const dash = ticker.indexOf("-")
  return dash === -1 ? ticker : ticker.slice(0, dash)
}

function midpoint(bid: unknown, ask: unknown): number {
  const b = parseDecimal(bid)
  const a = parseDecimal(ask)
  if (Number.isNaN(b) || Number.isNaN(a)) return Number.NaN
  return (b + a) / 2
}

function isIsoInstant(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v))
}

/**
 * Turn one raw Kalshi market into a slate candidate, or say why it was dropped.
 *
 * Order matters only for the drop reason reported, not for correctness: the
 * cheap structural checks run before the arithmetic so a malformed row never
 * reaches a comparison.
 */
export function toCandidate(
  raw: unknown,
  window: CandidateWindow,
  volumeFloor: number,
): CandidateResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "malformed" }
  }
  const m = raw as RawKalshiMarket

  // Combo markets have machine-generated titles like
  // "yes Manny Machado: 1+,yes Ty France: 1+" -- unusable as a daily question.
  if (typeof m.mve_collection_ticker === "string" && m.mve_collection_ticker.length > 0) {
    return { ok: false, reason: "multivariate" }
  }

  const id = typeof m.ticker === "string" ? m.ticker.trim() : ""
  const question = capQuestion(m.title)
  if (id.length === 0 || question === null) return { ok: false, reason: "malformed" }
  if (!isIsoInstant(m.close_time)) return { ok: false, reason: "malformed" }

  const volume = parseDecimal(m.volume_fp)
  const priceYes = midpoint(m.yes_bid_dollars, m.yes_ask_dollars)
  const priceNo = midpoint(m.no_bid_dollars, m.no_ask_dollars)
  if (Number.isNaN(volume) || Number.isNaN(priceYes) || Number.isNaN(priceNo)) {
    return { ok: false, reason: "malformed" }
  }

  const closeMs = Date.parse(m.close_time)
  // Strictly inside: a market closing at exactly the 21:00 order lock is excluded.
  if (closeMs <= window.opensAfter.getTime() || closeMs >= window.closesBefore.getTime()) {
    return { ok: false, reason: "close-window" }
  }

  if (volume < volumeFloor) return { ok: false, reason: "volume" }

  if (
    priceYes < PRICE_MIN ||
    priceYes > PRICE_MAX ||
    priceNo < PRICE_MIN ||
    priceNo > PRICE_MAX
  ) {
    return { ok: false, reason: "price-range" }
  }

  // Two independently snapshotted mids summing below 1.0 would make the
  // both-sides hedge pay more than the intended 10% house bonus.
  if (priceYes + priceNo < 1) return { ok: false, reason: "crossed-book" }

  return {
    ok: true,
    candidate: {
      id,
      question,
      priceYes,
      priceNo,
      closeTime: m.close_time,
      volume,
      series: seriesOf(id),
    },
  }
}

const SETTLED_STATUSES = new Set(["settled", "finalized"])

/**
 * Map a raw market to a settlement outcome.
 *
 * Anything that is not an unambiguous settled yes/no is "unsettled": an active
 * market, a void result, a timeout, junk. Unsettled rolls forward and the
 * engine refunds it after two ticks, so absorbing failure here is safe.
 *
 * Note the status check reads the *response* field. Querying `?status=settled`
 * returns markets whose own `status` reads "finalized".
 */
export function toSettlement(raw: unknown): Settlement {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "unsettled"
  const m = raw as RawKalshiMarket
  if (typeof m.status !== "string" || !SETTLED_STATUSES.has(m.status)) return "unsettled"
  if (m.result === "yes") return "yes"
  if (m.result === "no") return "no"
  return "unsettled"
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/adapters/kalshi/parse.test.ts`
Expected: PASS, 38 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/adapters/types.ts src/adapters/kalshi/raw.ts src/adapters/kalshi/parse.ts src/adapters/kalshi/parse.test.ts
git commit -m "feat(adapters): Kalshi wire types and strict boundary parser"
```

---

### Task 3: Kalshi HTTP client — timeout, retry, cursor pagination

Network mechanics only. It knows nothing about markets; it fetches JSON and follows cursors.

**Files:**
- Create: `src/adapters/kalshi/client.ts`
- Test: `src/adapters/kalshi/client.test.ts`

**Interfaces:**
- Consumes: `HTTP_TIMEOUT_MS`, `HTTP_RETRIES`, `HTTP_RETRY_DELAY_MS`, `MAX_PAGES`, `KALSHI_BASE_URL` from `src/config.js`
- Produces:
  - `type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>`
  - `interface ClientOptions { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; baseUrl?: string }`
  - `class KalshiHttpError extends Error { readonly status: number }`
  - `getJson(path: string, params: Record<string, string>, opts?: ClientOptions): Promise<unknown>`
  - `getAllMarkets(params: Record<string, string>, opts?: ClientOptions): Promise<RawKalshiMarket[]>`

- [ ] **Step 1: Write the failing client test**

`src/adapters/kalshi/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { KalshiHttpError, getAllMarkets, getJson } from "./client.js"
import type { FetchLike } from "./client.js"

const noSleep = async () => {}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("getJson", () => {
  it("builds the URL from base, path and params", async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async (input) => {
      seen.push(String(input))
      return jsonResponse({ ok: true })
    }
    await getJson("/markets", { limit: "2", status: "open" }, { fetchImpl, sleep: noSleep })
    expect(seen).toHaveLength(1)
    const url = new URL(seen[0]!)
    expect(url.pathname.endsWith("/markets")).toBe(true)
    expect(url.searchParams.get("limit")).toBe("2")
    expect(url.searchParams.get("status")).toBe("open")
  })

  it("retries a 500 and succeeds", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return calls === 1 ? jsonResponse({}, 500) : jsonResponse({ ok: true })
    }
    const out = await getJson("/markets", {}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(2)
    expect(out).toEqual({ ok: true })
  })

  it("retries a 429", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return calls < 3 ? jsonResponse({}, 429) : jsonResponse({ ok: true })
    }
    await getJson("/markets", {}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(3)
  })

  it("retries a thrown network error", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      if (calls === 1) throw new TypeError("fetch failed")
      return jsonResponse({ ok: true })
    }
    await getJson("/markets", {}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(2)
  })

  it("does NOT retry a 400 -- a bad request will stay bad", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return jsonResponse({ error: "bad" }, 400)
    }
    await expect(getJson("/markets", {}, { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(
      KalshiHttpError,
    )
    expect(calls).toBe(1)
  })

  it("gives up after the retry budget and throws", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return jsonResponse({}, 503)
    }
    await expect(getJson("/markets", {}, { fetchImpl, sleep: noSleep })).rejects.toThrow(/503/)
    expect(calls).toBe(3) // 1 attempt + HTTP_RETRIES
  })

  it("throws on a body that is not JSON", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("<html>gateway timeout</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    await expect(getJson("/markets", {}, { fetchImpl, sleep: noSleep })).rejects.toThrow()
  })

  it("passes an abort signal so a hung socket cannot stall the job", async () => {
    let sawSignal = false
    const fetchImpl: FetchLike = async (_input, init) => {
      sawSignal = init?.signal instanceof AbortSignal
      return jsonResponse({ ok: true })
    }
    await getJson("/markets", {}, { fetchImpl, sleep: noSleep })
    expect(sawSignal).toBe(true)
  })
})

describe("getAllMarkets", () => {
  it("follows cursors and concatenates pages", async () => {
    const pages = [
      { markets: [{ ticker: "A" }], cursor: "c1" },
      { markets: [{ ticker: "B" }], cursor: "c2" },
      { markets: [{ ticker: "C" }], cursor: "" },
    ]
    const cursors: (string | null)[] = []
    let i = 0
    const fetchImpl: FetchLike = async (input) => {
      cursors.push(new URL(String(input)).searchParams.get("cursor"))
      return jsonResponse(pages[i++])
    }
    const out = await getAllMarkets({ status: "open" }, { fetchImpl, sleep: noSleep })
    expect(out.map((m) => m.ticker)).toEqual(["A", "B", "C"])
    expect(cursors).toEqual([null, "c1", "c2"])
  })

  it("stops at MAX_PAGES rather than looping forever on a repeating cursor", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return jsonResponse({ markets: [{ ticker: `T${calls}` }], cursor: "always-the-same" })
    }
    const out = await getAllMarkets({}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(12)
    expect(out).toHaveLength(12)
  })

  it("stops when a page returns no markets even if a cursor is present", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return jsonResponse({ markets: [], cursor: "c" })
    }
    const out = await getAllMarkets({}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(1)
    expect(out).toEqual([])
  })

  it("tolerates a page whose markets field is missing or not an array", async () => {
    const pages = [{ cursor: "c1" }, { markets: "nope", cursor: "c2" }, { markets: [{ ticker: "A" }] }]
    let i = 0
    const fetchImpl: FetchLike = async () => jsonResponse(pages[i++])
    const out = await getAllMarkets({}, { fetchImpl, sleep: noSleep })
    expect(out.map((m) => m.ticker)).toEqual(["A"])
  })

  it("drops non-object entries inside markets", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ markets: [null, 42, { ticker: "A" }, "x"] })
    const out = await getAllMarkets({}, { fetchImpl, sleep: noSleep })
    expect(out).toEqual([{ ticker: "A" }])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/adapters/kalshi/client.test.ts`
Expected: FAIL — `Failed to resolve import "./client.js"`

- [ ] **Step 3: Write `src/adapters/kalshi/client.ts`**

```ts
import {
  HTTP_RETRIES,
  HTTP_RETRY_DELAY_MS,
  HTTP_TIMEOUT_MS,
  KALSHI_BASE_URL,
  MAX_PAGES,
} from "../../config.js"
import type { RawKalshiMarket, RawKalshiMarketsResponse } from "./raw.js"

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ClientOptions {
  fetchImpl?: FetchLike
  /** Injected so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>
  baseUrl?: string
}

export class KalshiHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "KalshiHttpError"
    this.status = status
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 5xx and 429 are worth another try; 4xx will stay broken. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * GET a JSON document, with a hard timeout and a bounded retry budget.
 *
 * The timeout matters more than it looks: a hung TLS handshake with no
 * AbortSignal would leave the 08:00 job running until systemd killed it, and
 * the day would silently get no slate.
 */
export async function getJson(
  path: string,
  params: Record<string, string>,
  opts: ClientOptions = {},
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const url = new URL((opts.baseUrl ?? KALSHI_BASE_URL) + path)
  for (const key of Object.keys(params).sort()) {
    url.searchParams.set(key, params[key]!)
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt++) {
    if (attempt > 0) await sleep(HTTP_RETRY_DELAY_MS)
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
      if (!res.ok) {
        const err = new KalshiHttpError(res.status, `Kalshi ${path} returned ${res.status}`)
        if (!isRetryable(res.status)) throw err
        lastError = err
        continue
      }
      return await res.json()
    } catch (err) {
      // A non-retryable HTTP error must escape immediately.
      if (err instanceof KalshiHttpError && !isRetryable(err.status)) throw err
      lastError = err
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Kalshi ${path} failed: ${String(lastError)}`)
}

/**
 * Fetch every page of /markets for a query.
 *
 * Pagination is not optional: one observed same-day close window held 5,748
 * markets across 6 pages of 1,000. MAX_PAGES is a backstop against a cursor
 * that never advances.
 */
export async function getAllMarkets(
  params: Record<string, string>,
  opts: ClientOptions = {},
): Promise<RawKalshiMarket[]> {
  const out: RawKalshiMarket[] = []
  let cursor = ""
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = cursor ? { ...params, cursor } : params
    const body = (await getJson("/markets", query, opts)) as RawKalshiMarketsResponse
    const markets = Array.isArray(body?.markets) ? body.markets : []
    for (const m of markets) {
      if (typeof m === "object" && m !== null && !Array.isArray(m)) {
        out.push(m as RawKalshiMarket)
      }
    }
    const next = typeof body?.cursor === "string" ? body.cursor : ""
    // An empty page ends the walk even when a cursor is returned -- Kalshi
    // hands back a cursor on the final page and following it loops.
    if (next === "" || markets.length === 0) break
    cursor = next
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapters/kalshi/client.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/adapters/kalshi/client.ts src/adapters/kalshi/client.test.ts
git commit -m "feat(adapters): Kalshi HTTP client with timeout, retry and pagination"
```

---

### Task 4: KalshiAdapter

Joins the client to the parser and satisfies `MarketAdapter`.

**Files:**
- Create: `src/adapters/kalshi/index.ts`
- Test: `src/adapters/kalshi/index.test.ts`

**Interfaces:**
- Consumes: `getAllMarkets`, `getJson`, `ClientOptions` (Task 3); `toCandidate`, `toSettlement`, `DropReason` (Task 2); `VOLUME_FLOOR`, `PAGE_LIMIT`, `SETTLEMENT_BATCH_SIZE` (Task 1)
- Produces:
  - `interface KalshiAdapterOptions extends ClientOptions { volumeFloor?: number; onDrop?: (reason: DropReason, id: string) => void }`
  - `createKalshiAdapter(opts?: KalshiAdapterOptions): MarketAdapter`

- [ ] **Step 1: Write the failing adapter test**

`src/adapters/kalshi/index.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createKalshiAdapter } from "./index.js"
import type { FetchLike } from "./client.js"
import type { CandidateWindow } from "../types.js"
import type { DropReason } from "./parse.js"

const WINDOW: CandidateWindow = {
  opensAfter: new Date("2026-08-10T13:00:00Z"),
  closesBefore: new Date("2026-08-11T01:00:00Z"),
}

const noSleep = async () => {}

function market(over: Record<string, unknown> = {}) {
  return {
    ticker: "KXTEST-26AUG10-A",
    title: "Will it rain?",
    status: "active",
    result: "",
    open_time: "2026-08-05T05:36:00Z",
    close_time: "2026-08-10T21:30:00Z",
    volume_fp: "38457.31",
    yes_bid_dollars: "0.3800",
    yes_ask_dollars: "0.5300",
    no_bid_dollars: "0.4700",
    no_ask_dollars: "0.6200",
    ...over,
  }
}

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

describe("getCandidates", () => {
  it("queries the close window as unix seconds", async () => {
    let url = ""
    const fetchImpl: FetchLike = async (input) => {
      url = String(input)
      return respond({ markets: [] })
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    await a.getCandidates(WINDOW)
    const q = new URL(url).searchParams
    expect(q.get("min_close_ts")).toBe("1786366800") // 2026-08-10T13:00:00Z
    expect(q.get("max_close_ts")).toBe("1786410000") // 2026-08-11T01:00:00Z
    expect(q.get("status")).toBe("open")
  })

  it("returns parsed candidates and drops the rest", async () => {
    const fetchImpl: FetchLike = async () =>
      respond({
        markets: [
          market({ ticker: "KXA-1" }),
          market({ ticker: "KXB-1", volume_fp: "1.00" }), // below floor
          market({ ticker: "KXC-1", yes_bid_dollars: "" }), // malformed
          market({ ticker: "KXD-1", mve_collection_ticker: "X" }), // combo
        ],
      })
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep, volumeFloor: 1000 })
    const out = await a.getCandidates(WINDOW)
    expect(out.map((c) => c.id)).toEqual(["KXA-1"])
  })

  it("reports drop reasons to the callback for the job log", async () => {
    const drops: [DropReason, string][] = []
    const fetchImpl: FetchLike = async () =>
      respond({ markets: [market({ ticker: "KXB-1", volume_fp: "1.00" })] })
    const a = createKalshiAdapter({
      fetchImpl,
      sleep: noSleep,
      volumeFloor: 1000,
      onDrop: (reason, id) => drops.push([reason, id]),
    })
    await a.getCandidates(WINDOW)
    expect(drops).toEqual([["volume", "KXB-1"]])
  })

  it("returns candidates sorted by id so the caller starts deterministic", async () => {
    const fetchImpl: FetchLike = async () =>
      respond({
        markets: [market({ ticker: "KXZ-1" }), market({ ticker: "KXA-1" }), market({ ticker: "KXM-1" })],
      })
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep, volumeFloor: 1000 })
    const out = await a.getCandidates(WINDOW)
    expect(out.map((c) => c.id)).toEqual(["KXA-1", "KXM-1", "KXZ-1"])
  })
})

describe("getSettlements", () => {
  it("returns unsettled for an empty id list without calling the network", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return respond({ markets: [] })
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    expect(await a.getSettlements([])).toEqual({})
    expect(calls).toBe(0)
  })

  it("maps outcomes by ticker, not by position", async () => {
    // Kalshi returns ?tickers= results in arbitrary order. Zipping by index
    // would assign B's outcome to A.
    const fetchImpl: FetchLike = async () =>
      respond({
        markets: [
          { ticker: "B", status: "finalized", result: "no" },
          { ticker: "A", status: "finalized", result: "yes" },
        ],
      })
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    expect(await a.getSettlements(["A", "B"])).toEqual({ A: "yes", B: "no" })
  })

  it("reports unsettled for a market the API omitted", async () => {
    const fetchImpl: FetchLike = async () =>
      respond({ markets: [{ ticker: "A", status: "finalized", result: "yes" }] })
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    expect(await a.getSettlements(["A", "MISSING"])).toEqual({ A: "yes", MISSING: "unsettled" })
  })

  it("absorbs a network failure as unsettled rather than throwing", async () => {
    // The spec is explicit: adapter timeouts and errors map to "unsettled" so a
    // Kalshi outage is absorbed by the two-tick refund rule.
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed")
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    expect(await a.getSettlements(["A", "B"])).toEqual({ A: "unsettled", B: "unsettled" })
  })

  it("batches large id lists and merges the results", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `T${String(i).padStart(3, "0")}`)
    const batches: number[] = []
    const fetchImpl: FetchLike = async (input) => {
      const tickers = new URL(String(input)).searchParams.get("tickers")!.split(",")
      batches.push(tickers.length)
      return respond({
        markets: tickers.map((t) => ({ ticker: t, status: "finalized", result: "yes" })),
      })
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    const out = await a.getSettlements(ids)
    expect(batches).toEqual([100, 100, 50])
    expect(Object.keys(out)).toHaveLength(250)
    expect(out.T249).toBe("yes")
  })

  it("keeps good batches when one batch fails", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `T${String(i).padStart(3, "0")}`)
    let call = 0
    const fetchImpl: FetchLike = async (input) => {
      call++
      if (call === 1) throw new TypeError("fetch failed")
      const tickers = new URL(String(input)).searchParams.get("tickers")!.split(",")
      return respond({
        markets: tickers.map((t) => ({ ticker: t, status: "finalized", result: "no" })),
      })
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    const out = await a.getSettlements(ids)
    expect(out.T000).toBe("unsettled")
    expect(out.T100).toBe("no")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/adapters/kalshi/index.test.ts`
Expected: FAIL — `Failed to resolve import "./index.js"` (or no export `createKalshiAdapter`)

- [ ] **Step 3: Write `src/adapters/kalshi/index.ts`**

```ts
import { PAGE_LIMIT, SETTLEMENT_BATCH_SIZE, VOLUME_FLOOR } from "../../config.js"
import type { MarketId, Settlement } from "../../engine/index.js"
import type { Candidate, CandidateWindow, MarketAdapter } from "../types.js"
import { getAllMarkets, type ClientOptions } from "./client.js"
import { toCandidate, toSettlement, type DropReason } from "./parse.js"
import type { RawKalshiMarket } from "./raw.js"

export interface KalshiAdapterOptions extends ClientOptions {
  volumeFloor?: number
  /** Called for every rejected market so the job can log why the slate is thin. */
  onDrop?: (reason: DropReason, id: string) => void
}

const unixSeconds = (d: Date) => String(Math.floor(d.getTime() / 1000))

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function idOf(raw: RawKalshiMarket): string {
  return typeof raw.ticker === "string" ? raw.ticker : "<no ticker>"
}

export function createKalshiAdapter(opts: KalshiAdapterOptions = {}): MarketAdapter {
  const volumeFloor = opts.volumeFloor ?? VOLUME_FLOOR
  const onDrop = opts.onDrop ?? (() => {})

  return {
    async getCandidates(window: CandidateWindow): Promise<Candidate[]> {
      const raw = await getAllMarkets(
        {
          limit: String(PAGE_LIMIT),
          status: "open",
          min_close_ts: unixSeconds(window.opensAfter),
          max_close_ts: unixSeconds(window.closesBefore),
        },
        opts,
      )

      const out: Candidate[] = []
      for (const m of raw) {
        const r = toCandidate(m, window, volumeFloor)
        if (r.ok) out.push(r.candidate)
        else onDrop(r.reason, idOf(m))
      }
      // Sorted so every downstream step begins from a fixed order.
      out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return out
    },

    async getSettlements(ids: MarketId[]): Promise<Record<MarketId, Settlement>> {
      if (ids.length === 0) return {}

      // Default every requested id to unsettled, then overwrite what we learn.
      // A market the API omits, a batch that times out, and a void result all
      // land here identically -- and the engine refunds after two ticks.
      const out: Record<MarketId, Settlement> = {}
      for (const id of [...ids].sort()) out[id] = "unsettled"

      for (const batch of chunk([...ids].sort(), SETTLEMENT_BATCH_SIZE)) {
        let raw: RawKalshiMarket[]
        try {
          raw = await getAllMarkets({ tickers: batch.join(","), limit: String(PAGE_LIMIT) }, opts)
        } catch {
          continue // this batch stays unsettled; other batches still count
        }
        for (const m of raw) {
          const id = idOf(m)
          // Keyed by ticker: ?tickers= responses come back in arbitrary order.
          if (id in out) out[id] = toSettlement(m)
        }
      }
      return out
    },
  }
}

export type { DropReason }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapters/kalshi/index.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/adapters/kalshi/index.ts src/adapters/kalshi/index.test.ts
git commit -m "feat(adapters): KalshiAdapter for candidates and settlements"
```

---

### Task 5: Derive the volume floor from real Kalshi data

The spec says to sample a week and take the median. The measured median is 0.00, so this task both takes the sample and corrects the rule. This is the only task that touches the network, and it is a developer tool, not shipped code.

**Files:**
- Create: `scripts/sample-kalshi.ts`
- Create: `src/adapters/kalshi/__fixtures__/README.md`
- Create: `src/adapters/kalshi/__fixtures__/candidates-page.json`
- Modify: `src/config.ts` (the `VOLUME_FLOOR` value and its comment)
- Modify: `package.json` (add the `sample:kalshi` script)

**Interfaces:**
- Consumes: `getAllMarkets` (Task 3), `toCandidate`, `seriesOf` (Task 2), `etDate`, `etInstant`, `etDaysBetween` (Task 1)
- Produces: no importable API. Prints a report and writes fixtures.

- [ ] **Step 1: Add the npm script**

In `package.json`, add to `scripts`:

```json
"sample:kalshi": "tsx scripts/sample-kalshi.ts"
```

- [ ] **Step 2: Write `scripts/sample-kalshi.ts`**

```ts
/**
 * Developer tool. Samples real Kalshi same-day markets to derive VOLUME_FLOOR,
 * and records one page of live responses as a test fixture.
 *
 * Sampling is retrospective: for each of the last N ET days it asks for markets
 * that CLOSED inside that day's 09:00-21:00 window. Those are exactly the
 * markets the 08:00 job would have been choosing between.
 *
 *   npm run sample:kalshi          # 7 days
 *   npm run sample:kalshi -- 14    # 14 days
 *
 * The spec said to set the floor at the median of same-day markets. Do not do
 * that: roughly three quarters of them never trade, so the median is 0.00 and a
 * zero floor admits every untraded strike in every ladder. This reports the
 * median of markets with non-zero volume instead, and prints how many distinct
 * series survive at each candidate floor -- that second number is the one that
 * matters, because the slate takes at most one market per series.
 */
import { writeFileSync } from "node:fs"
import { WINDOW_CLOSE_HOUR, WINDOW_OPEN_HOUR } from "../src/config.js"
import { etDate, etInstant } from "../src/time.js"
import { getAllMarkets } from "../src/adapters/kalshi/client.js"
import { seriesOf, toCandidate } from "../src/adapters/kalshi/parse.js"
import type { RawKalshiMarket } from "../src/adapters/kalshi/raw.js"

const days = Number(process.argv[2] ?? "7")
const unix = (d: Date) => String(Math.floor(d.getTime() / 1000))
const quantile = (sorted: number[], q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(Math.floor(sorted.length * q), sorted.length - 1)]!

const allVolumes: number[] = []
let firstPage: RawKalshiMarket[] = []
const perDay: { date: string; raw: number; byFloor: Map<number, number> }[] = []
const FLOORS = [0, 100, 250, 500, 1000, 2500, 5000]

for (let back = 1; back <= days; back++) {
  const date = etDate(new Date(Date.now() - back * 86_400_000))
  const opensAfter = etInstant(date, WINDOW_OPEN_HOUR)
  const closesBefore = etInstant(date, WINDOW_CLOSE_HOUR)

  const raw = await getAllMarkets({
    limit: "1000",
    status: "settled",
    min_close_ts: unix(opensAfter),
    max_close_ts: unix(closesBefore),
  })
  if (firstPage.length === 0) firstPage = raw.slice(0, 40)

  const byFloor = new Map<number, number>()
  for (const floor of FLOORS) {
    const series = new Set<string>()
    for (const m of raw) {
      const r = toCandidate(m, { opensAfter, closesBefore }, floor)
      if (r.ok) series.add(seriesOf(r.candidate.id))
    }
    byFloor.set(floor, series.size)
  }
  for (const m of raw) {
    const v = Number(m.volume_fp)
    if (Number.isFinite(v)) allVolumes.push(v)
  }
  perDay.push({ date, raw: raw.length, byFloor })
  console.log(`${date}  ${String(raw.length).padStart(5)} markets`)
}

const sorted = [...allVolumes].sort((a, b) => a - b)
const nonZero = sorted.filter((v) => v > 0)

console.log(`\nsampled ${sorted.length} markets over ${days} days`)
console.log(`  zero-volume:        ${sorted.length - nonZero.length} (${
  ((1 - nonZero.length / Math.max(sorted.length, 1)) * 100).toFixed(1)
}%)`)
console.log(`  median (all):       ${quantile(sorted, 0.5).toFixed(2)}   <- the spec's rule`)
console.log(`  median (non-zero):  ${quantile(nonZero, 0.5).toFixed(2)}   <- use this`)
console.log(`  p75 (non-zero):     ${quantile(nonZero, 0.75).toFixed(2)}`)

console.log(`\ndistinct series surviving, per day, by floor:`)
console.log(`  floor  ${perDay.map((d) => d.date.slice(5)).join("  ")}   min`)
for (const floor of FLOORS) {
  const counts = perDay.map((d) => d.byFloor.get(floor) ?? 0)
  const cells = counts.map((c) => String(c).padStart(5)).join("  ")
  console.log(`  ${String(floor).padStart(5)}  ${cells}   ${Math.min(...counts)}`)
}
console.log(`\nPick the highest floor whose worst day still clears SLATE_MAX (5) series.`)

writeFileSync(
  new URL("../src/adapters/kalshi/__fixtures__/candidates-page.json", import.meta.url),
  `${JSON.stringify({ markets: firstPage }, null, 2)}\n`,
)
console.log(`\nwrote __fixtures__/candidates-page.json (${firstPage.length} markets)`)
```

- [ ] **Step 3: Run the sampler against the live API**

Run: `npm run sample:kalshi`
Expected: a per-day table, a volume summary, and a written fixture file. Runs about 30–60 seconds.

If the API is unreachable, stop and report it — do **not** invent numbers. The plan's default of `1000` came from a real one-day sample (99 markets across 24 series) and is safe to keep if a fresh sample cannot be taken; say so explicitly rather than silently leaving it.

- [ ] **Step 4: Set `VOLUME_FLOOR` from the output**

Choose the highest floor whose **worst day** still yields at least `SLATE_MAX` (5) distinct series, so a quiet day never starves the slate. Update the constant in `src/config.ts` and rewrite its comment to record the observed numbers and the sample date:

```ts
/**
 * Minimum cumulative volume, in dollars, for a market to be slate-eligible.
 *
 * Derived <DATE> from <N> same-day Kalshi markets over <DAYS> days:
 * <PCT>% never traded, so the median of all markets was 0.00 and the spec's
 * "set it at the median" would admit everything. Median of markets that did
 * trade was <MEDIAN>. At this floor the thinnest sampled day still offered
 * <SERIES> distinct series against a slate of at most 5.
 *
 * Re-derive with `npm run sample:kalshi`.
 */
export const VOLUME_FLOOR = <VALUE>
```

- [ ] **Step 5: Write the fixture README**

`src/adapters/kalshi/__fixtures__/README.md`:

```markdown
# Recorded Kalshi responses

Real API responses, trimmed, used by adapter tests so that no test needs a
socket. Regenerate with `npm run sample:kalshi`.

Do not hand-edit these to make a test pass. If a fixture no longer matches the
live API, that is the finding — the adapter needs updating, not the fixture.

`candidates-page.json` — one page of `/markets` for a same-day close window.
```

- [ ] **Step 6: Add a fixture-backed regression test**

Append to `src/adapters/kalshi/parse.test.ts`:

```ts
import { readFileSync } from "node:fs"

describe("recorded fixtures", () => {
  it("parses a real recorded page without throwing, and every survivor is well-formed", () => {
    const body = JSON.parse(
      readFileSync(new URL("./__fixtures__/candidates-page.json", import.meta.url), "utf8"),
    ) as { markets: unknown[] }
    expect(body.markets.length).toBeGreaterThan(0)

    // A window wide enough that close-time filtering does not dominate; the
    // point of this test is that real payloads never produce a bad Candidate.
    const wide: CandidateWindow = {
      opensAfter: new Date("2000-01-01T00:00:00Z"),
      closesBefore: new Date("2100-01-01T00:00:00Z"),
    }
    for (const raw of body.markets) {
      const r = toCandidate(raw, wide, 0)
      if (!r.ok) continue
      const c = r.candidate
      expect(Number.isFinite(c.priceYes)).toBe(true)
      expect(Number.isFinite(c.priceNo)).toBe(true)
      expect(c.priceYes).toBeGreaterThanOrEqual(PRICE_MIN)
      expect(c.priceYes).toBeLessThanOrEqual(PRICE_MAX)
      expect(c.priceNo).toBeGreaterThanOrEqual(PRICE_MIN)
      expect(c.priceNo).toBeLessThanOrEqual(PRICE_MAX)
      expect(c.priceYes + c.priceNo).toBeGreaterThanOrEqual(1)
      expect(c.question.length).toBeGreaterThan(0)
      expect(c.question.length).toBeLessThanOrEqual(200)
      expect(c.id.length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
npm run typecheck
git add scripts/sample-kalshi.ts src/adapters/kalshi/__fixtures__ src/config.ts src/adapters/kalshi/parse.test.ts package.json
git commit -m "feat(adapters): derive volume floor from sampled Kalshi data"
```

---

### Task 6: Slate selection

Pure. Given candidates, pick the day's markets.

**Files:**
- Create: `src/slate/select.ts`
- Test: `src/slate/select.test.ts`

**Interfaces:**
- Consumes: `Candidate` (Task 2); `SLATE_MAX` (Task 1); `Market` from `src/engine/index.js`
- Produces: `selectSlate(candidates: Candidate[], max?: number): Market[]`

- [ ] **Step 1: Write the failing selection test**

`src/slate/select.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { selectSlate } from "./select.js"
import type { Candidate } from "../adapters/types.js"

function cand(id: string, volume: number, series = id.split("-")[0]!): Candidate {
  return {
    id,
    question: `q ${id}`,
    priceYes: 0.4,
    priceNo: 0.6,
    closeTime: "2026-08-10T18:00:00Z",
    volume,
    series,
  }
}

describe("selectSlate", () => {
  it("returns at most SLATE_MAX markets", () => {
    const out = selectSlate([
      cand("A-1", 900),
      cand("B-1", 800),
      cand("C-1", 700),
      cand("D-1", 600),
      cand("E-1", 500),
      cand("F-1", 400),
    ])
    expect(out).toHaveLength(5)
  })

  it("takes the most-traded markets", () => {
    const out = selectSlate([cand("A-1", 10), cand("B-1", 5000), cand("C-1", 900)], 2)
    expect(out.map((m) => m.id).sort()).toEqual(["B-1", "C-1"])
  })

  it("takes at most one market per series", () => {
    // The real failure this prevents: a same-day window is dominated by strike
    // ladders, so a naive top-5-by-volume publishes five rungs of one SOL
    // ladder -- five bets on one number.
    const out = selectSlate([
      cand("KXSOLE-B74", 9000),
      cand("KXSOLE-B75", 8900),
      cand("KXSOLE-B76", 8800),
      cand("KXBTC-T1", 100),
      cand("KXNFL-G1", 90),
    ])
    expect(out.map((m) => m.id)).toEqual(["KXBTC-T1", "KXNFL-G1", "KXSOLE-B74"])
  })

  it("keeps the highest-volume member of a series", () => {
    const out = selectSlate([cand("KXSOLE-B74", 10), cand("KXSOLE-B75", 9000)], 5)
    expect(out.map((m) => m.id)).toEqual(["KXSOLE-B75"])
  })

  it("breaks volume ties on id ascending", () => {
    const out = selectSlate([cand("B-1", 500), cand("A-1", 500)], 1)
    expect(out.map((m) => m.id)).toEqual(["A-1"])
  })

  it("returns the slate sorted by market id", () => {
    // The spec asks for a deterministic order in the persisted slate; volume
    // ordering is a selection rule, id ordering is the storage rule.
    const out = selectSlate([cand("Z-1", 900), cand("A-1", 800), cand("M-1", 700)])
    expect(out.map((m) => m.id)).toEqual(["A-1", "M-1", "Z-1"])
  })

  it("strips the selection-only fields", () => {
    const out = selectSlate([cand("A-1", 900)])
    expect(out[0]).toEqual({
      id: "A-1",
      question: "q A-1",
      priceYes: 0.4,
      priceNo: 0.6,
      closeTime: "2026-08-10T18:00:00Z",
    })
    expect(out[0]).not.toHaveProperty("volume")
    expect(out[0]).not.toHaveProperty("series")
  })

  it("returns an empty slate for no candidates", () => {
    expect(selectSlate([])).toEqual([])
  })

  it("publishes a short slate rather than nothing when few survive", () => {
    // A 2-market day is still a playable day; an empty one is plain Risk.
    expect(selectSlate([cand("A-1", 900), cand("B-1", 800)])).toHaveLength(2)
  })

  it("does not mutate its input", () => {
    const input = [cand("B-1", 100), cand("A-1", 200)]
    const copy = structuredClone(input)
    selectSlate(input)
    expect(input).toEqual(copy)
  })

  it("is deterministic across input orderings", () => {
    const pool = [cand("A-1", 500), cand("B-1", 500), cand("C-1", 900), cand("A-2", 700, "A")]
    const forward = selectSlate(pool, 2)
    const backward = selectSlate([...pool].reverse(), 2)
    expect(forward).toEqual(backward)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/slate/select.test.ts`
Expected: FAIL — `Failed to resolve import "./select.js"`

- [ ] **Step 3: Write `src/slate/select.ts`**

```ts
import { SLATE_MAX } from "../config.js"
import type { Candidate } from "../adapters/types.js"
import type { Market } from "../engine/index.js"

/**
 * Pick the day's slate.
 *
 * Two rules beyond "take the best":
 *
 * At most one market per series. A same-day Kalshi window is dominated by
 * strike ladders -- one observed window held 2,257 eligible markets across only
 * 44 distinct series -- so ranking by volume alone publishes five rungs of one
 * crypto ladder, which is five wagers on a single number.
 *
 * Rank by volume, store by id. The spec asks for a deterministic order, and id
 * order gives that for the persisted slate; but picking the alphabetically
 * first markets would hand players the same series every single day. Volume
 * decides what is chosen, id decides how it is written down.
 */
export function selectSlate(candidates: Candidate[], max: number = SLATE_MAX): Market[] {
  const ranked = [...candidates].sort((a, b) => {
    if (b.volume !== a.volume) return b.volume - a.volume
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const seen = new Set<string>()
  const picked: Candidate[] = []
  for (const c of ranked) {
    if (picked.length >= max) break
    if (seen.has(c.series)) continue
    seen.add(c.series)
    picked.push(c)
  }

  return picked
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, question, priceYes, priceNo, closeTime }) => ({
      id,
      question,
      priceYes,
      priceNo,
      closeTime,
    }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/slate/select.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/slate/select.ts src/slate/select.test.ts
git commit -m "feat(slate): volume-ranked, one-per-series slate selection"
```

---

### Task 7: SQLite store — migrations, slate and settlements

`node:sqlite` keeps the project at zero runtime dependencies. Note two of its quirks, both handled below: rows come back with a `null` prototype, and it prints an `ExperimentalWarning` on import.

**Files:**
- Create: `src/store/schema.ts`
- Create: `src/store/types.ts`
- Create: `src/store/sqlite.ts`
- Test: `src/store/sqlite.test.ts`

**Interfaces:**
- Consumes: `Market`, `MarketId`, `Settlement` from `src/engine/index.js`
- Produces:
  - `interface SeasonRow { seasonId: string; startDate: string; lengthDays: number }`
  - `interface SlateStore { … }` (full signature list below)
  - `openStore(path: string): SlateStore`
  - `MIGRATIONS: string[]`

- [ ] **Step 1: Write `src/store/schema.ts`**

```ts
import type { DatabaseSync } from "node:sqlite"

/**
 * Ordered, append-only. Each entry advances `PRAGMA user_version` by one.
 * Never edit a shipped migration -- add a new one. Plans 3 and 4 append theirs.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE seasons (
    season_id   TEXT PRIMARY KEY,
    start_date  TEXT NOT NULL,        -- ET calendar date of the day-0 deal
    length_days INTEGER NOT NULL
  );

  -- One row per day on which the publish job ran to completion. Distinguishes
  -- "no slate was published yet" from "an empty slate was published on purpose",
  -- which is the difference between retrying and playing plain Risk.
  CREATE TABLE slate_publications (
    season_id    TEXT NOT NULL,
    day          INTEGER NOT NULL,
    published_at TEXT NOT NULL,
    market_count INTEGER NOT NULL,
    PRIMARY KEY (season_id, day)
  );

  CREATE TABLE slate_markets (
    season_id  TEXT NOT NULL,
    day        INTEGER NOT NULL,
    market_id  TEXT NOT NULL,
    question   TEXT NOT NULL,
    price_yes  REAL NOT NULL,
    price_no   REAL NOT NULL,
    close_time TEXT NOT NULL,
    PRIMARY KEY (season_id, day, market_id)
  );

  CREATE INDEX slate_markets_by_market ON slate_markets (market_id);

  -- observed_at is load-bearing, not bookkeeping: Kalshi markets carry
  -- can_close_early, so a market can settle before its stated closeTime. The
  -- web app locks a market's wagers at min(close_time, observed_at), otherwise
  -- a player edits at 20:55 and stakes a known outcome at the 08:00 price.
  CREATE TABLE settlements (
    market_id   TEXT PRIMARY KEY,
    outcome     TEXT NOT NULL CHECK (outcome IN ('yes','no')),
    observed_at TEXT NOT NULL
  );
  `,
]

/** Apply any migrations the database has not seen. Safe to call on every boot. */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN")
    try {
      db.exec(MIGRATIONS[v]!)
      // user_version does not accept a bound parameter.
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  }
}
```

- [ ] **Step 2: Write `src/store/types.ts`**

```ts
import type { Market, MarketId, Settlement } from "../engine/index.js"

export interface SeasonRow {
  seasonId: string
  startDate: string
  lengthDays: number
}

/**
 * The slice of the spec's `Store` that Plan 2 needs. Plan 4 adds loadState /
 * saveState / loadOrders / saveOrder / claimTick against the same database.
 */
export interface SlateStore {
  season(seasonId: string): SeasonRow | undefined
  upsertSeason(season: SeasonRow): void

  /**
   * Persist the day's slate. Returns false and writes nothing if a slate has
   * already been published for that day.
   *
   * Refusing the second write is the point: a rerun at 20:00 would otherwise
   * re-snapshot prices hours later, handing whoever triggered it a slate priced
   * on the afternoon's information.
   */
  publishSlate(seasonId: string, day: number, slate: Market[], publishedAt: Date): boolean
  slatePublished(seasonId: string, day: number): boolean
  loadSlate(seasonId: string, day: number): Market[]

  /** First observation wins. Returns false if an outcome was already recorded. */
  recordSettlement(marketId: MarketId, outcome: "yes" | "no", at: Date): boolean
  loadSettlements(marketIds: MarketId[]): Record<MarketId, Settlement>

  /**
   * Market ids on this season's slates that have closed, have no settlement
   * yet, and are recent enough to still matter to a live wager.
   */
  marketsAwaitingSettlement(seasonId: string, now: Date, horizonDays: number): MarketId[]

  close(): void
}
```

- [ ] **Step 3: Write the failing store test**

`src/store/sqlite.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { openStore } from "./sqlite.js"
import type { Market } from "../engine/index.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 21 }

function market(id: string, closeTime = "2026-09-05T18:00:00Z"): Market {
  return { id, question: `q ${id}`, priceYes: 0.4, priceNo: 0.6, closeTime }
}

function fresh() {
  // ":memory:" gives each test its own database and needs no cleanup.
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  return store
}

describe("seasons", () => {
  it("round-trips a season", () => {
    const s = fresh()
    expect(s.season("s1")).toEqual(SEASON)
    s.close()
  })

  it("returns undefined for an unknown season", () => {
    const s = fresh()
    expect(s.season("nope")).toBeUndefined()
    s.close()
  })
})

describe("publishSlate", () => {
  it("persists and reloads a slate with prices intact", () => {
    const s = fresh()
    const slate = [market("A"), market("B")]
    expect(s.publishSlate("s1", 3, slate, new Date("2026-09-03T12:00:00Z"))).toBe(true)
    expect(s.loadSlate("s1", 3)).toEqual(slate)
    s.close()
  })

  it("refuses a second publish and leaves the first slate untouched", () => {
    // A rerun must never re-snapshot prices at a later, better-informed hour.
    const s = fresh()
    s.publishSlate("s1", 3, [market("A")], new Date("2026-09-03T12:00:00Z"))
    const second = s.publishSlate("s1", 3, [market("B")], new Date("2026-09-03T20:00:00Z"))
    expect(second).toBe(false)
    expect(s.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A"])
    s.close()
  })

  it("records an empty slate as published", () => {
    // "Nothing survived the filters" is a decision; "the job never ran" is not.
    const s = fresh()
    expect(s.publishSlate("s1", 4, [], new Date("2026-09-04T12:00:00Z"))).toBe(true)
    expect(s.slatePublished("s1", 4)).toBe(true)
    expect(s.loadSlate("s1", 4)).toEqual([])
    s.close()
  })

  it("reports an unpublished day as not published", () => {
    const s = fresh()
    expect(s.slatePublished("s1", 9)).toBe(false)
    s.close()
  })

  it("returns the slate sorted by market id", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("Z"), market("A"), market("M")], new Date())
    expect(s.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A", "M", "Z"])
    s.close()
  })

  it("keeps days and seasons separate", () => {
    const s = fresh()
    s.upsertSeason({ seasonId: "s2", startDate: "2026-10-01", lengthDays: 21 })
    s.publishSlate("s1", 3, [market("A")], new Date())
    s.publishSlate("s1", 4, [market("B")], new Date())
    s.publishSlate("s2", 3, [market("C")], new Date())
    expect(s.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A"])
    expect(s.loadSlate("s1", 4).map((m) => m.id)).toEqual(["B"])
    expect(s.loadSlate("s2", 3).map((m) => m.id)).toEqual(["C"])
    s.close()
  })

  it("preserves a price exactly through a round trip", () => {
    const s = fresh()
    const m: Market = {
      id: "A",
      question: "q",
      priceYes: 0.455,
      priceNo: 0.545,
      closeTime: "2026-09-05T18:00:00Z",
    }
    s.publishSlate("s1", 3, [m], new Date())
    expect(s.loadSlate("s1", 3)[0]!.priceYes).toBe(0.455)
    s.close()
  })

  it("stores hostile question text verbatim", () => {
    const s = fresh()
    const nasty = "</text><script>alert(1)</script> <!channel>"
    s.publishSlate("s1", 3, [{ ...market("A"), question: nasty }], new Date())
    expect(s.loadSlate("s1", 3)[0]!.question).toBe(nasty)
    s.close()
  })
})

describe("settlements", () => {
  it("records and reads back an outcome", () => {
    const s = fresh()
    expect(s.recordSettlement("A", "yes", new Date("2026-09-03T18:00:00Z"))).toBe(true)
    expect(s.loadSettlements(["A"])).toEqual({ A: "yes" })
    s.close()
  })

  it("reports unknown markets as unsettled", () => {
    const s = fresh()
    expect(s.loadSettlements(["A", "B"])).toEqual({ A: "unsettled", B: "unsettled" })
    s.close()
  })

  it("keeps the first observation when a second disagrees", () => {
    const s = fresh()
    s.recordSettlement("A", "yes", new Date("2026-09-03T18:00:00Z"))
    expect(s.recordSettlement("A", "no", new Date("2026-09-03T19:00:00Z"))).toBe(false)
    expect(s.loadSettlements(["A"])).toEqual({ A: "yes" })
    s.close()
  })

  it("returns an empty map for an empty request", () => {
    const s = fresh()
    expect(s.loadSettlements([])).toEqual({})
    s.close()
  })

  it("handles a request larger than SQLite's parameter limit", () => {
    const s = fresh()
    s.recordSettlement("T500", "no", new Date())
    const ids = Array.from({ length: 1200 }, (_, i) => `T${i}`)
    const out = s.loadSettlements(ids)
    expect(Object.keys(out)).toHaveLength(1200)
    expect(out.T500).toBe("no")
    expect(out.T499).toBe("unsettled")
    s.close()
  })
})

describe("marketsAwaitingSettlement", () => {
  const NOW = new Date("2026-09-05T20:00:00Z")

  it("returns closed, unsettled markets", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("A", "2026-09-05T18:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual(["A"])
    s.close()
  })

  it("skips markets that have not closed yet", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("A", "2026-09-05T23:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual([])
    s.close()
  })

  it("skips markets already settled", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("A", "2026-09-05T18:00:00Z")], new Date())
    s.recordSettlement("A", "yes", NOW)
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual([])
    s.close()
  })

  it("skips markets older than the horizon", () => {
    // Past the two-tick refund the answer can no longer change anything.
    const s = fresh()
    s.publishSlate("s1", 1, [market("OLD", "2026-08-20T18:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual([])
    s.close()
  })

  it("does not return another season's markets", () => {
    const s = fresh()
    s.upsertSeason({ seasonId: "s2", startDate: "2026-10-01", lengthDays: 21 })
    s.publishSlate("s2", 3, [market("A", "2026-09-05T18:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual([])
    s.close()
  })

  it("returns each market once even when it appears on several days", () => {
    const s = fresh()
    s.publishSlate("s1", 3, [market("A", "2026-09-05T18:00:00Z")], new Date())
    s.publishSlate("s1", 4, [market("A", "2026-09-05T18:00:00Z")], new Date())
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual(["A"])
    s.close()
  })

  it("returns ids sorted", () => {
    const s = fresh()
    s.publishSlate(
      "s1",
      3,
      [market("Z", "2026-09-05T18:00:00Z"), market("A", "2026-09-05T18:00:00Z")],
      new Date(),
    )
    expect(s.marketsAwaitingSettlement("s1", NOW, 4)).toEqual(["A", "Z"])
    s.close()
  })
})

describe("migrations", () => {
  it("is safe to open the same database twice", () => {
    const s1 = openStore(":memory:")
    s1.close()
    const s2 = openStore(":memory:")
    s2.close()
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/store/sqlite.test.ts`
Expected: FAIL — `Failed to resolve import "./sqlite.js"`

- [ ] **Step 5: Write `src/store/sqlite.ts`**

```ts
import { DatabaseSync } from "node:sqlite"
import type { Market, MarketId, Settlement } from "../engine/index.js"
import { migrate } from "./schema.js"
import type { SeasonRow, SlateStore } from "./types.js"

/** SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999; stay well under it. */
const PARAM_CHUNK = 500

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function openStore(path: string): SlateStore {
  const db = new DatabaseSync(path)
  // WAL lets the web app, the Slack bot and the timer share one file. The
  // likeliest thing to block the 21:00 tick is our own second process.
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
  migrate(db)

  return {
    season(seasonId: string): SeasonRow | undefined {
      const row = db
        .prepare("SELECT season_id, start_date, length_days FROM seasons WHERE season_id = ?")
        .get(seasonId) as
        | { season_id: string; start_date: string; length_days: number }
        | undefined
      if (row === undefined) return undefined
      return {
        seasonId: row.season_id,
        startDate: row.start_date,
        lengthDays: Number(row.length_days),
      }
    },

    upsertSeason(season: SeasonRow): void {
      db.prepare(
        `INSERT INTO seasons (season_id, start_date, length_days) VALUES (?, ?, ?)
         ON CONFLICT (season_id) DO UPDATE SET start_date = excluded.start_date,
                                               length_days = excluded.length_days`,
      ).run(season.seasonId, season.startDate, season.lengthDays)
    },

    publishSlate(seasonId: string, day: number, slate: Market[], publishedAt: Date): boolean {
      // The publication row is the lock. Inserting it first means a second
      // caller collides on the primary key before writing a single market.
      db.exec("BEGIN IMMEDIATE")
      try {
        const existing = db
          .prepare("SELECT 1 FROM slate_publications WHERE season_id = ? AND day = ?")
          .get(seasonId, day)
        if (existing !== undefined) {
          db.exec("ROLLBACK")
          return false
        }
        db.prepare(
          `INSERT INTO slate_publications (season_id, day, published_at, market_count)
           VALUES (?, ?, ?, ?)`,
        ).run(seasonId, day, publishedAt.toISOString(), slate.length)

        const insert = db.prepare(
          `INSERT INTO slate_markets
             (season_id, day, market_id, question, price_yes, price_no, close_time)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const m of slate) {
          insert.run(seasonId, day, m.id, m.question, m.priceYes, m.priceNo, m.closeTime)
        }
        db.exec("COMMIT")
        return true
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      }
    },

    slatePublished(seasonId: string, day: number): boolean {
      return (
        db
          .prepare("SELECT 1 FROM slate_publications WHERE season_id = ? AND day = ?")
          .get(seasonId, day) !== undefined
      )
    },

    loadSlate(seasonId: string, day: number): Market[] {
      const rows = db
        .prepare(
          `SELECT market_id, question, price_yes, price_no, close_time
             FROM slate_markets WHERE season_id = ? AND day = ?
            ORDER BY market_id`,
        )
        .all(seasonId, day) as {
        market_id: string
        question: string
        price_yes: number
        price_no: number
        close_time: string
      }[]
      return rows.map((r) => ({
        id: r.market_id,
        question: r.question,
        priceYes: r.price_yes,
        priceNo: r.price_no,
        closeTime: r.close_time,
      }))
    },

    recordSettlement(marketId: MarketId, outcome: "yes" | "no", at: Date): boolean {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO settlements (market_id, outcome, observed_at) VALUES (?, ?, ?)`,
        )
        .run(marketId, outcome, at.toISOString())
      return Number(res.changes) > 0
    },

    loadSettlements(marketIds: MarketId[]): Record<MarketId, Settlement> {
      const out: Record<MarketId, Settlement> = {}
      for (const id of [...marketIds].sort()) out[id] = "unsettled"
      for (const batch of chunk([...marketIds].sort(), PARAM_CHUNK)) {
        if (batch.length === 0) continue
        const holes = batch.map(() => "?").join(",")
        const rows = db
          .prepare(`SELECT market_id, outcome FROM settlements WHERE market_id IN (${holes})`)
          .all(...batch) as { market_id: string; outcome: string }[]
        for (const r of rows) {
          if (r.outcome === "yes" || r.outcome === "no") out[r.market_id] = r.outcome
        }
      }
      return out
    },

    marketsAwaitingSettlement(seasonId: string, now: Date, horizonDays: number): MarketId[] {
      const cutoff = new Date(now.getTime() - horizonDays * 86_400_000).toISOString()
      const rows = db
        .prepare(
          `SELECT DISTINCT sm.market_id
             FROM slate_markets sm
             LEFT JOIN settlements s ON s.market_id = sm.market_id
            WHERE sm.season_id = ?
              AND sm.close_time <= ?
              AND sm.close_time >= ?
              AND s.market_id IS NULL
            ORDER BY sm.market_id`,
        )
        .all(seasonId, now.toISOString(), cutoff) as { market_id: string }[]
      return rows.map((r) => r.market_id)
    },

    close(): void {
      db.close()
    },
  }
}
```

Note: `close_time` is compared as an ISO-8601 string. That is a correct chronological comparison only because every value is UTC with a trailing `Z` and identical precision — Kalshi returns exactly that shape, and `Date.parse` has already validated it in the adapter.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/store/sqlite.test.ts`
Expected: PASS, 22 tests. An `ExperimentalWarning: SQLite is an experimental feature` on stderr is expected and harmless.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/store/schema.ts src/store/types.ts src/store/sqlite.ts src/store/sqlite.test.ts
git commit -m "feat(store): SQLite slate and settlement persistence in WAL mode"
```

---

### Task 8: The 08:00 publish-slate job

**Files:**
- Create: `src/jobs/publish-slate.ts`
- Test: `src/jobs/publish-slate.test.ts`

**Interfaces:**
- Consumes: `MarketAdapter`, `CandidateWindow` (Task 2); `selectSlate` (Task 6); `SlateStore` (Task 7); `etDate`, `etInstant`, `etDaysBetween` (Task 1); `WINDOW_OPEN_HOUR`, `WINDOW_CLOSE_HOUR`, `SLATE_MIN` (Task 1)
- Produces:
  - `type PublishOutcome = { status: "published"; day: number; count: number } | { status: "skipped"; day: number; reason: SkipReason }`
  - `type SkipReason = "before-season" | "after-season" | "final-day" | "already-published"`
  - `runPublishSlate(deps: PublishDeps): Promise<PublishOutcome>`
  - `interface PublishDeps { store: SlateStore; adapter: MarketAdapter; seasonId: string; now: Date; log?: (msg: string) => void }`

The job export is `runPublishSlate`, not `publishSlate` — the store already has a `publishSlate` method and the job calls it. Two same-named things in one function body is how an implementer writes an accidental recursion.

- [ ] **Step 1: Write the failing job test**

`src/jobs/publish-slate.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { runPublishSlate } from "./publish-slate.js"
import { openStore } from "../store/sqlite.js"
import type { Candidate, CandidateWindow, MarketAdapter } from "../adapters/types.js"
import type { SlateStore } from "../store/types.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 21 }

function cand(id: string, volume: number): Candidate {
  return {
    id,
    question: `q ${id}`,
    priceYes: 0.4,
    priceNo: 0.6,
    closeTime: "2026-09-04T18:00:00Z",
    volume,
    series: id.split("-")[0]!,
  }
}

function stubAdapter(
  candidates: Candidate[] | Error,
): MarketAdapter & { windows: CandidateWindow[] } {
  const windows: CandidateWindow[] = []
  return {
    windows,
    async getCandidates(w) {
      windows.push(w)
      if (candidates instanceof Error) throw candidates
      return candidates
    },
    async getSettlements() {
      return {}
    },
  }
}

function fresh(): SlateStore {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  return store
}

// 2026-09-04T12:00:00Z is 08:00 ET on Sept 4 -- day 3 of a season dealt Sept 1.
const AT_0800_DAY3 = new Date("2026-09-04T12:00:00Z")

describe("runPublishSlate", () => {
  it("publishes the day's slate", async () => {
    const store = fresh()
    const adapter = stubAdapter([cand("A-1", 900), cand("B-1", 800)])
    const out = await runPublishSlate({ store, adapter, seasonId: "s1", now: AT_0800_DAY3 })
    expect(out).toEqual({ status: "published", day: 3, count: 2 })
    expect(store.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A-1", "B-1"])
    store.close()
  })

  it("asks for a window of 09:00 to 21:00 ET on the slate's own day", async () => {
    const store = fresh()
    const adapter = stubAdapter([])
    await runPublishSlate({ store, adapter, seasonId: "s1", now: AT_0800_DAY3 })
    expect(adapter.windows).toHaveLength(1)
    expect(adapter.windows[0]!.opensAfter.toISOString()).toBe("2026-09-04T13:00:00.000Z")
    expect(adapter.windows[0]!.closesBefore.toISOString()).toBe("2026-09-05T01:00:00.000Z")
    store.close()
  })

  it("publishes an empty slate when nothing survives filtering", async () => {
    // "No market slate -> the day runs as plain Risk."
    const store = fresh()
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([]),
      seasonId: "s1",
      now: AT_0800_DAY3,
    })
    expect(out).toEqual({ status: "published", day: 3, count: 0 })
    expect(store.slatePublished("s1", 3)).toBe(true)
    store.close()
  })

  it("caps the slate at SLATE_MAX", async () => {
    const store = fresh()
    const many = Array.from({ length: 9 }, (_, i) => cand(`S${i}-1`, 1000 - i))
    const out = await runPublishSlate({ store, adapter: stubAdapter(many), seasonId: "s1", now: AT_0800_DAY3 })
    expect(out).toEqual({ status: "published", day: 3, count: 5 })
    store.close()
  })

  it("is idempotent -- a second run publishes nothing", async () => {
    const store = fresh()
    await runPublishSlate({ store, adapter: stubAdapter([cand("A-1", 900)]), seasonId: "s1", now: AT_0800_DAY3 })
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([cand("B-1", 900)]),
      seasonId: "s1",
      now: AT_0800_DAY3,
    })
    expect(out).toEqual({ status: "skipped", day: 3, reason: "already-published" })
    expect(store.loadSlate("s1", 3).map((m) => m.id)).toEqual(["A-1"])
    store.close()
  })

  it("does not call the adapter when the day is already published", async () => {
    // A double-fired timer must not spend a network round trip, and must not
    // be able to observe fresher prices at all.
    const store = fresh()
    await runPublishSlate({ store, adapter: stubAdapter([]), seasonId: "s1", now: AT_0800_DAY3 })
    const second = stubAdapter([cand("B-1", 900)])
    await runPublishSlate({ store, adapter: second, seasonId: "s1", now: AT_0800_DAY3 })
    expect(second.windows).toHaveLength(0)
    store.close()
  })

  it("publishes nothing on the final day", async () => {
    // Day-21 wagers would settle at a tick 22 that never runs.
    const store = fresh()
    const day21 = new Date("2026-09-22T12:00:00Z")
    const out = await runPublishSlate({ store, adapter: stubAdapter([cand("A-1", 900)]), seasonId: "s1", now: day21 })
    expect(out).toEqual({ status: "skipped", day: 21, reason: "final-day" })
    expect(store.slatePublished("s1", 21)).toBe(false)
    store.close()
  })

  it("publishes on day 20, the last day a wager can settle", async () => {
    const store = fresh()
    const day20 = new Date("2026-09-21T12:00:00Z")
    const out = await runPublishSlate({ store, adapter: stubAdapter([cand("A-1", 900)]), seasonId: "s1", now: day20 })
    expect(out).toEqual({ status: "published", day: 20, count: 1 })
    store.close()
  })

  it("skips a day before the season starts", async () => {
    const store = fresh()
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([]),
      seasonId: "s1",
      now: new Date("2026-09-01T12:00:00Z"), // day 0, the deal
    })
    expect(out).toEqual({ status: "skipped", day: 0, reason: "before-season" })
    store.close()
  })

  it("skips a day after the season ends", async () => {
    const store = fresh()
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([]),
      seasonId: "s1",
      now: new Date("2026-10-15T12:00:00Z"),
    })
    expect(out.status).toBe("skipped")
    if (out.status !== "skipped") return
    expect(out.reason).toBe("after-season")
    store.close()
  })

  it("propagates an adapter failure and publishes nothing", async () => {
    // Critical: a network failure must NOT record an empty slate. Recording one
    // would permanently deny the day a slate, when a systemd retry five minutes
    // later would have succeeded. Only a successful fetch that yields nothing
    // is a real empty slate.
    const store = fresh()
    const boom = new Error("kalshi unreachable")
    await expect(
      runPublishSlate({ store, adapter: stubAdapter(boom), seasonId: "s1", now: AT_0800_DAY3 }),
    ).rejects.toThrow("kalshi unreachable")
    expect(store.slatePublished("s1", 3)).toBe(false)
    store.close()
  })

  it("throws for an unknown season", async () => {
    const store = openStore(":memory:")
    await expect(
      runPublishSlate({ store, adapter: stubAdapter([]), seasonId: "nope", now: AT_0800_DAY3 }),
    ).rejects.toThrow(/nope/)
    store.close()
  })

  it("logs a warning when the slate is short of SLATE_MIN", async () => {
    const lines: string[] = []
    const store = fresh()
    await runPublishSlate({
      store,
      adapter: stubAdapter([cand("A-1", 900)]),
      seasonId: "s1",
      now: AT_0800_DAY3,
      log: (m) => lines.push(m),
    })
    expect(lines.some((l) => /only 1/.test(l))).toBe(true)
    store.close()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/jobs/publish-slate.test.ts`
Expected: FAIL — `Failed to resolve import "./publish-slate.js"`

- [ ] **Step 3: Write `src/jobs/publish-slate.ts`**

```ts
import { SLATE_MIN, WINDOW_CLOSE_HOUR, WINDOW_OPEN_HOUR } from "../config.js"
import { etDate, etDaysBetween, etInstant } from "../time.js"
import { selectSlate } from "../slate/select.js"
import type { MarketAdapter } from "../adapters/types.js"
import type { SlateStore } from "../store/types.js"

export type SkipReason = "before-season" | "after-season" | "final-day" | "already-published"

export type PublishOutcome =
  | { status: "published"; day: number; count: number }
  | { status: "skipped"; day: number; reason: SkipReason }

export interface PublishDeps {
  store: SlateStore
  adapter: MarketAdapter
  seasonId: string
  /** Injected: the job holds no clock of its own, so tests can pin the day. */
  now: Date
  log?: (msg: string) => void
}

/**
 * The 08:00 job. Fetch candidates closing today, pick the slate, snapshot its
 * prices, persist.
 *
 * On an adapter failure this throws and writes nothing. That is deliberate:
 * recording an empty slate would burn the day permanently, while throwing lets
 * a systemd retry a few minutes later still deliver a slate. An empty slate is
 * only ever written after a *successful* fetch that yielded no eligible market.
 */
export async function runPublishSlate(deps: PublishDeps): Promise<PublishOutcome> {
  const { store, adapter, seasonId, now } = deps
  const log = deps.log ?? (() => {})

  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`publishSlate: unknown season ${seasonId}`)

  const today = etDate(now)
  const day = etDaysBetween(season.startDate, today)

  if (day < 1) return { status: "skipped", day, reason: "before-season" }
  if (day > season.lengthDays) return { status: "skipped", day, reason: "after-season" }
  // Day-N wagers escrow at tick N and settle at tick N+1, so the final day's
  // would settle at a tick that never runs.
  if (day >= season.lengthDays) return { status: "skipped", day, reason: "final-day" }

  // Checked before fetching: a double-fired timer should neither spend a round
  // trip nor be in a position to see fresher prices.
  if (store.slatePublished(seasonId, day)) {
    return { status: "skipped", day, reason: "already-published" }
  }

  const window = {
    opensAfter: etInstant(today, WINDOW_OPEN_HOUR),
    closesBefore: etInstant(today, WINDOW_CLOSE_HOUR),
  }

  const candidates = await adapter.getCandidates(window)
  const slate = selectSlate(candidates)

  if (slate.length < SLATE_MIN) {
    log(
      `day ${day}: only ${slate.length} eligible market(s) from ${candidates.length} candidates` +
        ` (target ${SLATE_MIN})`,
    )
  }

  const written = store.publishSlate(seasonId, day, slate, now)
  if (!written) {
    // Lost a race with a concurrent run; the other run's slate stands.
    return { status: "skipped", day, reason: "already-published" }
  }

  log(`day ${day}: published ${slate.length} market(s): ${slate.map((m) => m.id).join(", ")}`)
  return { status: "published", day, count: slate.length }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/publish-slate.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/jobs/publish-slate.ts src/jobs/publish-slate.test.ts
git commit -m "feat(jobs): idempotent 08:00 slate publish"
```

---

### Task 9: The 30-minute settlement poller

**Files:**
- Create: `src/jobs/poll-settlements.ts`
- Test: `src/jobs/poll-settlements.test.ts`

**Interfaces:**
- Consumes: `MarketAdapter` (Task 2); `SlateStore` (Task 7); `SETTLEMENT_HORIZON_DAYS` (Task 1)
- Produces:
  - `interface PollResult { checked: number; recorded: number; stillOpen: number }`
  - `runPollSettlements(deps: PollDeps): Promise<PollResult>`
  - `interface PollDeps { store: SlateStore; adapter: MarketAdapter; seasonId: string; now: Date; log?: (msg: string) => void }`

- [ ] **Step 1: Write the failing poller test**

`src/jobs/poll-settlements.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { runPollSettlements } from "./poll-settlements.js"
import { openStore } from "../store/sqlite.js"
import type { MarketAdapter } from "../adapters/types.js"
import type { Market, MarketId, Settlement } from "../engine/index.js"
import type { SlateStore } from "../store/types.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 21 }
const NOW = new Date("2026-09-04T20:00:00Z")

function market(id: string, closeTime = "2026-09-04T18:00:00Z"): Market {
  return { id, question: `q ${id}`, priceYes: 0.4, priceNo: 0.6, closeTime }
}

function stubAdapter(
  outcomes: Record<MarketId, Settlement> | Error,
): MarketAdapter & { asked: MarketId[][] } {
  const asked: MarketId[][] = []
  return {
    asked,
    async getCandidates() {
      return []
    },
    async getSettlements(ids) {
      asked.push(ids)
      if (outcomes instanceof Error) throw outcomes
      const out: Record<MarketId, Settlement> = {}
      for (const id of ids) out[id] = outcomes[id] ?? "unsettled"
      return out
    },
  }
}

function fresh(): SlateStore {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  return store
}

describe("runPollSettlements", () => {
  it("records settled outcomes", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A"), market("B")], NOW)
    const out = await runPollSettlements({
      store,
      adapter: stubAdapter({ A: "yes", B: "no" }),
      seasonId: "s1",
      now: NOW,
    })
    expect(out).toEqual({ checked: 2, recorded: 2, stillOpen: 0 })
    expect(store.loadSettlements(["A", "B"])).toEqual({ A: "yes", B: "no" })
    store.close()
  })

  it("leaves unsettled markets unrecorded so a later poll can catch them", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A"), market("B")], NOW)
    const out = await runPollSettlements({
      store,
      adapter: stubAdapter({ A: "yes" }),
      seasonId: "s1",
      now: NOW,
    })
    expect(out).toEqual({ checked: 2, recorded: 1, stillOpen: 1 })
    expect(store.loadSettlements(["B"])).toEqual({ B: "unsettled" })
    store.close()
  })

  it("does nothing and makes no call when nothing is awaiting settlement", async () => {
    const store = fresh()
    const adapter = stubAdapter({})
    const out = await runPollSettlements({ store, adapter, seasonId: "s1", now: NOW })
    expect(out).toEqual({ checked: 0, recorded: 0, stillOpen: 0 })
    expect(adapter.asked).toEqual([])
    store.close()
  })

  it("does not re-ask about a market it already settled", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A"), market("B")], NOW)
    await runPollSettlements({ store, adapter: stubAdapter({ A: "yes" }), seasonId: "s1", now: NOW })
    const second = stubAdapter({ B: "no" })
    await runPollSettlements({ store, adapter: second, seasonId: "s1", now: NOW })
    expect(second.asked).toEqual([["B"]])
    store.close()
  })

  it("ignores markets that have not closed", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A", "2026-09-04T23:00:00Z")], NOW)
    const adapter = stubAdapter({ A: "yes" })
    const out = await runPollSettlements({ store, adapter, seasonId: "s1", now: NOW })
    expect(out.checked).toBe(0)
    expect(adapter.asked).toEqual([])
    store.close()
  })

  it("absorbs an adapter failure without throwing", async () => {
    // The poller is a background job on a 30-minute timer. A Kalshi outage must
    // not page anyone; the next run picks the market up, and if it never
    // settles the engine refunds the wager after two ticks.
    const store = fresh()
    store.publishSlate("s1", 3, [market("A")], NOW)
    const out = await runPollSettlements({
      store,
      adapter: stubAdapter(new Error("kalshi unreachable")),
      seasonId: "s1",
      now: NOW,
    })
    expect(out).toEqual({ checked: 1, recorded: 0, stillOpen: 1 })
    expect(store.loadSettlements(["A"])).toEqual({ A: "unsettled" })
    store.close()
  })

  it("logs the failure it absorbed", async () => {
    const lines: string[] = []
    const store = fresh()
    store.publishSlate("s1", 3, [market("A")], NOW)
    await runPollSettlements({
      store,
      adapter: stubAdapter(new Error("kalshi unreachable")),
      seasonId: "s1",
      now: NOW,
      log: (m) => lines.push(m),
    })
    expect(lines.some((l) => /kalshi unreachable/.test(l))).toBe(true)
    store.close()
  })

  it("keeps the first outcome if a market is somehow reported twice", async () => {
    const store = fresh()
    store.publishSlate("s1", 3, [market("A")], NOW)
    await runPollSettlements({ store, adapter: stubAdapter({ A: "yes" }), seasonId: "s1", now: NOW })
    // Force a second look by clearing nothing -- the market is settled, so the
    // poller will not ask again. Prove the store itself holds the line.
    expect(store.recordSettlement("A", "no", NOW)).toBe(false)
    expect(store.loadSettlements(["A"])).toEqual({ A: "yes" })
    store.close()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/jobs/poll-settlements.test.ts`
Expected: FAIL — `Failed to resolve import "./poll-settlements.js"`

- [ ] **Step 3: Write `src/jobs/poll-settlements.ts`**

```ts
import { SETTLEMENT_HORIZON_DAYS } from "../config.js"
import type { MarketAdapter } from "../adapters/types.js"
import type { SlateStore } from "../store/types.js"

export interface PollResult {
  checked: number
  recorded: number
  stillOpen: number
}

export interface PollDeps {
  store: SlateStore
  adapter: MarketAdapter
  seasonId: string
  now: Date
  log?: (msg: string) => void
}

/**
 * The 30-minute job. Writes resolved outcomes to the database so the 21:00 tick
 * can read settlements locally and never touch the network.
 *
 * Never throws. A Kalshi outage leaves markets unsettled, the next run retries,
 * and a wager that stays unsettled for two ticks is refunded by the engine.
 * That chain is the whole reason the tick is allowed to be offline.
 */
export async function runPollSettlements(deps: PollDeps): Promise<PollResult> {
  const { store, adapter, seasonId, now } = deps
  const log = deps.log ?? (() => {})

  const ids = store.marketsAwaitingSettlement(seasonId, now, SETTLEMENT_HORIZON_DAYS)
  if (ids.length === 0) return { checked: 0, recorded: 0, stillOpen: 0 }

  let outcomes: Record<string, string>
  try {
    outcomes = await adapter.getSettlements(ids)
  } catch (err) {
    log(`settlement poll failed, ${ids.length} market(s) left unsettled: ${String(err)}`)
    return { checked: ids.length, recorded: 0, stillOpen: ids.length }
  }

  let recorded = 0
  for (const id of ids) {
    const outcome = outcomes[id]
    if (outcome !== "yes" && outcome !== "no") continue
    if (store.recordSettlement(id, outcome, now)) recorded++
  }

  log(`settlement poll: ${recorded} of ${ids.length} market(s) settled`)
  return { checked: ids.length, recorded, stillOpen: ids.length - recorded }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/poll-settlements.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/jobs/poll-settlements.ts src/jobs/poll-settlements.test.ts
git commit -m "feat(jobs): 30-minute settlement poller"
```

---

### Task 10: CLI entrypoint, systemd units, and documentation

Wires the jobs to argv and to timers, and leaves the next plan a usable handoff.

**Files:**
- Create: `src/jobs/cli.ts`
- Create: `deploy/riskety-publish-slate.service`
- Create: `deploy/riskety-publish-slate.timer`
- Create: `deploy/riskety-poll-settlements.service`
- Create: `deploy/riskety-poll-settlements.timer`
- Create: `deploy/README.md`
- Modify: `package.json` (add `publish-slate`, `poll-settlements`, `season:init` scripts)
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: `publishSlate` (Task 8), `pollSettlements` (Task 9), `openStore` (Task 7), `createKalshiAdapter` (Task 4)
- Produces: no importable API.

- [ ] **Step 1: Write `src/jobs/cli.ts`**

```ts
/**
 * Entrypoint for the systemd timers.
 *
 *   tsx src/jobs/cli.ts publish-slate
 *   tsx src/jobs/cli.ts poll-settlements
 *   tsx src/jobs/cli.ts season-init <start-date> [length]
 *
 * Configuration comes from the environment:
 *   RR_DB_PATH    path to the SQLite file  (required)
 *   RR_SEASON_ID  the active season id     (required)
 *
 * Exit codes: 0 success or a deliberate skip, 1 failure worth a systemd retry.
 */
import { SEASON_LENGTH } from "../config.js"
import { createKalshiAdapter } from "../adapters/kalshi/index.js"
import { openStore } from "../store/sqlite.js"
import { runPublishSlate } from "./publish-slate.js"
import { runPollSettlements } from "./poll-settlements.js"

class UsageError extends Error {}

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === "") throw new UsageError(`${name} is not set`)
  return v
}

const command = process.argv[2]
const log = (msg: string) => console.log(msg)

/**
 * Never call process.exit() with the database open: it terminates immediately
 * and skips the finally block, leaving the WAL file behind on every bad
 * invocation. Set the code, fall through, close, then exit.
 */
let exitCode = 0
let store: ReturnType<typeof openStore> | undefined

try {
  store = openStore(required("RR_DB_PATH"))

  if (command === "season-init") {
    const startDate = process.argv[3]
    if (startDate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw new UsageError("usage: season-init <YYYY-MM-DD> [length]")
    }
    const seasonId = required("RR_SEASON_ID")
    const lengthDays = Number(process.argv[4] ?? SEASON_LENGTH)
    store.upsertSeason({ seasonId, startDate, lengthDays })
    log(`season ${seasonId}: day 0 dealt ${startDate}, ${lengthDays} ticks`)
  } else if (command === "publish-slate") {
    const out = await runPublishSlate({
      store,
      adapter: createKalshiAdapter(),
      seasonId: required("RR_SEASON_ID"),
      now: new Date(),
      log,
    })
    if (out.status === "skipped") log(`skipped day ${out.day}: ${out.reason}`)
  } else if (command === "poll-settlements") {
    const out = await runPollSettlements({
      store,
      adapter: createKalshiAdapter(),
      seasonId: required("RR_SEASON_ID"),
      now: new Date(),
      log,
    })
    if (out.checked === 0) log("nothing awaiting settlement")
  } else {
    throw new UsageError(
      `unknown command: ${String(command)}\nexpected one of: publish-slate, poll-settlements, season-init`,
    )
  }
} catch (err) {
  // Exit 1 so systemd's Restart=on-failure can retry. The publish job in
  // particular is worth retrying: an early failure still leaves hours before
  // the 21:00 lock.
  console.error(err instanceof UsageError ? err.message : err instanceof Error ? err.stack : String(err))
  exitCode = 1
} finally {
  store?.close()
}

process.exit(exitCode)
```

- [ ] **Step 2: Add the npm scripts**

In `package.json`, add to `scripts`:

```json
"publish-slate": "tsx src/jobs/cli.ts publish-slate",
"poll-settlements": "tsx src/jobs/cli.ts poll-settlements",
"season:init": "tsx src/jobs/cli.ts season-init"
```

- [ ] **Step 3: Smoke-test the CLI end to end against the live API**

```bash
export RR_DB_PATH=/tmp/riskety-smoke.db
export RR_SEASON_ID=smoke
rm -f /tmp/riskety-smoke.db*
# Deal "day 0" three days ago so today is day 3 of the season.
npm run season:init -- "$(date -v-3d +%Y-%m-%d)"
npm run publish-slate
npm run poll-settlements
npm run publish-slate    # must report: skipped day 3: already-published
```

Expected: the first publish prints 0–5 market ids; the poller reports either nothing awaiting settlement or a count; the second publish is skipped. If the first publish yields zero markets, re-check `VOLUME_FLOOR` against the Task 5 sample before moving on — a floor set too high is the likeliest cause.

Then clean up: `rm -f /tmp/riskety-smoke.db*`

- [ ] **Step 4: Write the systemd units**

`deploy/riskety-publish-slate.service`:

```ini
[Unit]
Description=Riskety Rekt — publish the daily market slate
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=riskety
WorkingDirectory=/srv/riskety-rekt
EnvironmentFile=/etc/riskety-rekt/env
ExecStart=/usr/bin/npm run publish-slate
# An early failure still leaves 13 hours before the 21:00 lock, so retry.
Restart=on-failure
RestartSec=300
```

`deploy/riskety-publish-slate.timer`:

```ini
[Unit]
Description=Riskety Rekt — 08:00 slate publish

[Timer]
OnCalendar=*-*-* 08:00:00
# OnCalendar fires exactly once on DST-transition days when the timezone is
# named explicitly. Do not replace this with an interval timer.
Persistent=true

[Install]
WantedBy=timers.target
```

`deploy/riskety-poll-settlements.service`:

```ini
[Unit]
Description=Riskety Rekt — poll market settlements
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=riskety
WorkingDirectory=/srv/riskety-rekt
EnvironmentFile=/etc/riskety-rekt/env
ExecStart=/usr/bin/npm run poll-settlements
```

`deploy/riskety-poll-settlements.timer`:

```ini
[Unit]
Description=Riskety Rekt — 30-minute settlement poll

[Timer]
OnCalendar=*:00/30
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 5: Write `deploy/README.md`**

```markdown
# Deployment — market jobs

Two timers, both on a single DigitalOcean droplet alongside the SQLite file.

## Environment

`/etc/riskety-rekt/env`, mode 0600, owned by root, outside the repo tree:

```
TZ=America/New_York
RR_DB_PATH=/srv/riskety-rekt/data/riskety.db
RR_SEASON_ID=season-1
```

`TZ` matters. systemd `OnCalendar` resolves against the system timezone, and
`08:00:00` must mean 08:00 in New York or the slate is snapshotted at the wrong
hour half the year.

Kalshi's public market-data endpoints need no credentials, so these jobs hold
no secrets. That changes in Plan 3, which adds the Slack signing secret.

## Install

```bash
sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now riskety-publish-slate.timer riskety-poll-settlements.timer
systemctl list-timers 'riskety-*'
```

## Start a season

```bash
sudo -u riskety RR_DB_PATH=... RR_SEASON_ID=season-1 npm run season:init -- 2026-09-01
```

The date is the **day-0 deal date**. Tick 1 runs the following day.

## Operating notes

- Both jobs are idempotent. Running them by hand is safe.
- `publish-slate` refuses to overwrite a published slate. This is deliberate —
  a rerun at 20:00 would re-snapshot prices on the afternoon's information.
- A failed publish records nothing, so the `RestartSec=300` retry can still
  deliver a slate. Only a successful fetch that yields no eligible market
  writes an empty slate, and that day runs as plain Risk.
- `journalctl -u riskety-publish-slate.service -n 50`
```

- [ ] **Step 6: Update `HANDOFF.md`**

Change the header line to read `**State:** engine + simulator + market adapter complete, no server yet`.

Replace the `**Plan 2 — Market adapter + settlement poller.**` paragraph under **What's next** with:

```markdown
**Plan 2 — Market adapter + settlement poller. Done.** Kalshi client, slate
selection, SQLite persistence and the 30-minute poller all exist and are tested
offline against recorded fixtures. See the plan's "Spec deltas" section — five
spec rules were corrected against live API data, most importantly that the
volume floor cannot be the median (three quarters of same-day markets never
trade) and that slate selection must take at most one market per series.
```

Add to **Gotchas**:

```markdown
- **`node:sqlite` prints an `ExperimentalWarning`.** Expected. It is the reason
  the project still has zero runtime dependencies; rows come back with a `null`
  prototype, so spread them rather than calling `Object.prototype` methods.
- **Wagers must lock at `min(closeTime, settlement observed_at)`**, not at
  `closeTime` alone. Kalshi markets carry `can_close_early`, so an outcome can
  become public before the stated close. The `settlements.observed_at` column
  exists for this; Plan 4's web app has to use it.
```

- [ ] **Step 7: Run the full suite, typecheck, and commit**

```bash
npm test
npm run typecheck
git add src/jobs/cli.ts deploy package.json HANDOFF.md
git commit -m "feat(jobs): CLI entrypoint, systemd timers, deployment docs"
```

---

## Spec deltas

Corrections this plan makes to `docs/superpowers/specs/2026-08-09-riskety-rekt-design.md`, each measured against the live API rather than reasoned about. Fold these back into the spec when the plan is complete.

1. **The volume floor is not the median.** The spec says "sample a week of Kalshi same-day markets and set it at the median." The observed median is `0.00` — 757 of 1,000 sampled same-day markets had never traded — so that rule admits every untraded strike. Corrected to the median of markets with non-zero volume, validated by counting how many distinct series survive.

2. **Slate selection must diversify by series.** "Pick 3–5, ordered deterministically by market id" is not sufficient: one observed window held 2,257 eligible markets across only 44 series, dominated by strike ladders (300 rungs of one SOL market). A top-N by id or by volume publishes five bets on one number. Selection now takes at most one market per series, ranks by volume descending with id as the tie-break, and stores the result sorted by id.

3. **`getCandidates()` takes an explicit window.** The spec's signature has no arguments. The adapter would then need a clock, which makes its tests time-dependent. The caller computes the 09:00–21:00 ET window and passes it in.

4. **Wagers must lock at `min(closeTime, settlementObservedAt)`.** Every sampled market carries `can_close_early: true`, so Kalshi may settle a market before its stated close — making the outcome public while the spec would still allow wager edits. This is the same exploit the per-market lock exists to close, arriving by a different door. The store records `settlements.observed_at`; **Plan 4's web app must use it.**

5. **Prices are decimal strings, not cents.** `Number("")` is `0`, so a missing quote parsed loosely becomes a free price of zero — a variant of the `NaN` trap the spec already warns about. All numeric wire fields go through a strict regex parser.

6. **Pagination is mandatory.** One same-day close window returned 5,748 markets across 6 pages.

7. **`liquidity_dollars` is unusable.** It reads `"0.0000"` on every market in list responses. `volume_fp` is the only workable liquidity signal.

8. **`?status=settled` returns `status: "finalized"`.** Never compare the response status against the query value.

9. **`?tickers=` returns rows in arbitrary order.** Results are mapped by ticker; zipping by index would assign one market's outcome to another.

## What this plan does not build

Named so the next reader does not go looking:

- **No tick runner.** Nothing here calls `resolve()`. Wiring the 21:00 tick, `claimTick`, and `loadState`/`saveState` is Plan 4.
- **No Slack.** Approvals and the recap are Plan 3.
- **No web app.** Order submission, the public projection, and enforcing the per-market wager lock in the UI are Plan 4.
- **No Manifold adapter.** Kalshi only, as the spec requires for production; recorded Kalshi fixtures cover what Manifold was going to provide for development.
