# Pluggable Mechanics — Module System Core: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn markets, IRL and the veto into modules a season enables, restructure the
tick pipeline around a seniority-ordered allocation phase, and migrate `GameState.pending`
into module-owned state — the module-system half of
`docs/superpowers/specs/2026-08-10-pluggable-mechanics-design.md` (Status: Reviewed,
unanimous APPROVED 2026-08-11).

**Scope note:** The spec's rule catalogue + voting (Rule interface, `rule_offers`/
`rule_reactions`, the Slack vote branch, the bounded-swing gate) is a SECOND plan, written
after this one lands — its code consumes interfaces this plan creates. This plan alone
produces working, testable software: the same game as today, now module-dispatched, plus
season configurations with modules off.

**Architecture:** A pure `Mechanic` hook interface dispatched at fixed pipeline points.
The seven steps become: grant (once) → claims (shape validation) → allocate (parsed
`lockedAt` seniority) → locks → movement validation (merge-then-validate, dial fee in cap)
→ combat → advance. `GameState.pending` becomes `moduleState.markets.pending`; persisted
states migrate via pinned SQL; old frozen contexts backfill from literals.

**Tech Stack:** TypeScript via tsx (no build), vitest + fast-check, `node:sqlite`.

## Global Constraints

- `src/engine/` is pure: no I/O, no clock, no `Math.random`, no `Date.now()`, no `new Date(` — enforced by `src/engine/types.test.ts`. `Date.parse` is permitted (and used for `lockedAt`).
- Input state is never mutated; every hook is a pure function of its arguments.
- Never edit a shipped migration in `src/store/schema.ts`; append. Six ship today (indices 0–5); the new one is appended (index 6 at time of writing — go by "append", not the number).
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on: expect `!`/`?? 0` at lookups; pass optional fields by spreading a conditional object, never explicit `undefined`.
- `node:sqlite` loads via `createRequire`; rows come back with a null prototype — spread them.
- Exit codes: 0 success or deliberate skip; 1 system failure; 2 operator mistake / rejected write.
- Jobs take `now: Date` as a dependency. Never `process.exit()` with the store open.
- The golden file (`src/engine/__golden__/season-1.json`) pins engine behavior via a fixed order script — regenerate deliberately and read the diff (Task 10).
- Commit after every green test cycle; `npm test` and `npm run typecheck` must pass at every commit.

## Spec deltas (decided here, recorded per repo convention)

1. **`SpendClaim` does not extend `Contribution`; its `event` is optional.** A deploy claim
   logs a `deploy` event when honored; a wager claim logs nothing when honored (today's
   escrow is silent — the pending list is the record; golden parity requires keeping that).
   TS cannot widen a required field to optional in a subtype, so `SpendClaim` is its own
   interface with `event?: TickEvent`.
2. **Core's tie-break id is the empty string** (`""`), so core deploy claims sort before
   any module's claims at an equal instant. Unreachable in production (the slate publisher
   guarantees strictly-earlier closes); pinned by the synthetic-mechanic test in Task 6.
3. **`resolveCombat` gains parameters** (`locked`, `dials`, movement list) instead of
   computing veto parity itself — the parity moves into the veto module, and the engine
   logs `LockResult` events. Behavior across the engine boundary is unchanged for the
   default module set (golden file proves it, Task 10).

---

### Task 1: The Mechanic contract (`src/engine/mechanics.ts`)

**Files:**
- Create: `src/engine/mechanics.ts`
- Test: `src/engine/mechanics.test.ts`

**Interfaces:**
- Consumes: `FactionId`, `TerritoryId`, `TickEvent`, `GameState`, `Order`, `DailyContext` from `./types.js` (Task 5 extends these; until then this file compiles against today's types by keeping `DailyContext` usage out of signatures it doesn't need — see code).
- Produces (later tasks rely on these exact names):
  `type ModuleId = string`, `type ModuleStateValue = unknown` (JSON-checked at save),
  `interface Contribution { faction: FactionId; amount: number; event: TickEvent }`,
  `interface SpendClaim { faction: FactionId; amount: number; lockedAt: string; ref: string; event?: TickEvent }`,
  `interface LockResult { territory: TerritoryId; event?: TickEvent }`,
  `interface CombatDials { attackDepartureCost: number }`,
  `interface Mechanic { id, grant?, spend?, validate?, lock?, combatDials?, advance?, escrowed? }` (signatures below),
  `parseInstant(s: string): number` (throws on unparseable),
  `interface OwnedClaim extends SpendClaim { mechanicId: string; index: number }`,
  `sortClaims(claims: OwnedClaim[]): OwnedClaim[]`,
  `checkContribution(c: {faction; amount}, factions: Set<string>): void` (throws on bad).

- [ ] **Step 1: Write the failing tests**

```ts
// src/engine/mechanics.test.ts
import { describe, expect, it } from "vitest"
import { checkContribution, parseInstant, sortClaims } from "./mechanics.js"
import type { OwnedClaim } from "./mechanics.js"

const claim = (o: Partial<OwnedClaim>): OwnedClaim => ({
  faction: "f1", amount: 1, lockedAt: "2026-09-01T18:00:00.000Z",
  ref: "x", mechanicId: "markets", index: 0, ...o,
})

describe("parseInstant", () => {
  it("parses a full ISO instant to epoch ms", () => {
    expect(parseInstant("2026-09-01T18:00:00.000Z")).toBe(Date.parse("2026-09-01T18:00:00.000Z"))
  })
  it("throws loudly on a non-instant — the T18:00 fixture class", () => {
    expect(() => parseInstant("T18:00")).toThrow(/lockedAt/)
  })
})

describe("sortClaims", () => {
  it("orders by parsed instant ascending, never string order", () => {
    // String order would put "2026-…" before "T18:00"-style junk; parseInstant
    // already refuses junk, so test the temporal property directly.
    const early = claim({ ref: "wager", lockedAt: "2026-09-01T16:00:00.000Z" })
    const late = claim({ ref: "deploy", mechanicId: "", lockedAt: "2026-09-01T21:00:00.000Z" })
    expect(sortClaims([late, early]).map((c) => c.ref)).toEqual(["wager", "deploy"])
  })
  it("breaks equal instants on mechanicId then index — core ('') first", () => {
    const t = "2026-09-01T21:00:00.000Z"
    const a = claim({ ref: "core", mechanicId: "", index: 1, lockedAt: t })
    const b = claim({ ref: "mkt0", mechanicId: "markets", index: 0, lockedAt: t })
    const c = claim({ ref: "mkt1", mechanicId: "markets", index: 1, lockedAt: t })
    expect(sortClaims([c, b, a]).map((x) => x.ref)).toEqual(["core", "mkt0", "mkt1"])
  })
})

describe("checkContribution", () => {
  const factions = new Set(["f1"])
  it("accepts a non-negative integer amount for a known faction", () => {
    expect(() => checkContribution({ faction: "f1", amount: 0 }, factions)).not.toThrow()
  })
  it("throws on negative, fractional, and unknown-faction returns", () => {
    expect(() => checkContribution({ faction: "f1", amount: -1 }, factions)).toThrow()
    expect(() => checkContribution({ faction: "f1", amount: 1.5 }, factions)).toThrow()
    expect(() => checkContribution({ faction: "ghost", amount: 1 }, factions)).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -- src/engine/mechanics.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/engine/mechanics.ts
import { cmp } from "./sort.js"
import type {
  DailyContext, FactionId, GameState, Order, TerritoryId, TickEvent,
} from "./types.js"

export type ModuleId = string
/** JSON-serializable; the store asserts a round-trip on save (Task 11 store test). */
export type ModuleStateValue = unknown

export interface Contribution {
  faction: FactionId
  amount: number      // engine-validated: non-negative integer
  event: TickEvent    // logged verbatim
}

/**
 * A claim against a faction's reserve, honored in ascending PARSED lockedAt.
 * `event` is logged only when the claim is honored, and only if present —
 * deploys log, wager escrow is silent (spec delta 1).
 */
export interface SpendClaim {
  faction: FactionId
  amount: number
  lockedAt: string
  /** Identifies the order item this claim funds, for the rejection log. */
  ref: string
  event?: TickEvent
}

export interface LockResult {
  territory: TerritoryId
  event?: TickEvent
}

export interface CombatDials {
  /** Extra troops lost per attack MOVEMENT at departure. Clamped 0–2. */
  attackDepartureCost: number
}
export const MAX_DEPARTURE_COST = 2

export interface Mechanic {
  id: ModuleId
  grant?(state: GameState, ctx: DailyContext): Contribution[]
  spend?(state: GameState, orders: Order[], ctx: DailyContext): SpendClaim[]
  validate?(state: GameState, order: Order, ctx: DailyContext): TickEvent[]
  lock?(state: GameState, orders: Order[], ctx: DailyContext): LockResult[]
  combatDials?(state: GameState, ctx: DailyContext): Partial<CombatDials>
  advance?(state: GameState, orders: Order[], ctx: DailyContext,
           honored: SpendClaim[]): ModuleStateValue
  escrowed?(own: ModuleStateValue): number
}

/** Engine-internal: a claim tagged with the mechanic that returned it (core = ""). */
export interface OwnedClaim extends SpendClaim {
  mechanicId: string
  index: number
}

export function parseInstant(s: string): number {
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) throw new Error(`lockedAt does not parse as an instant: ${JSON.stringify(s)}`)
  return ms
}

export function sortClaims(claims: OwnedClaim[]): OwnedClaim[] {
  return [...claims].sort(
    (a, b) =>
      parseInstant(a.lockedAt) - parseInstant(b.lockedAt) ||
      cmp(a.mechanicId, b.mechanicId) ||
      a.index - b.index,
  )
}

export function checkContribution(
  c: { faction: FactionId; amount: number },
  factions: ReadonlySet<string>,
): void {
  if (!Number.isSafeInteger(c.amount) || c.amount < 0) {
    throw new Error(`mechanic returned a bad amount ${c.amount} for ${c.faction}`)
  }
  if (!factions.has(c.faction)) {
    throw new Error(`mechanic returned a claim for unknown faction ${c.faction}`)
  }
}
```

- [ ] **Step 4: Run** — `npm test -- src/engine/mechanics.test.ts` → PASS. `npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git add src/engine/mechanics.ts src/engine/mechanics.test.ts && git commit -m "feat(engine): the Mechanic hook contract, claim ordering and validation"`

---

### Task 2: Registry validation (`src/engine/registry.ts`)

**Files:**
- Create: `src/engine/registry.ts`
- Test: `src/engine/registry.test.ts`

**Interfaces:**
- Consumes: `Mechanic` from Task 1.
- Produces: `validateModules(enabled: string[], registry: Map<string, Mechanic>): Mechanic[]`
  — returns the enabled mechanics **sorted by id**; throws (operator error, exit-2 class)
  on: unknown id, duplicate id, `veto` enabled without `irl` (hardcoded — no `requires`
  field per spec), and any mechanic with `advance` but no `escrowed`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/engine/registry.test.ts
import { describe, expect, it } from "vitest"
import { validateModules } from "./registry.js"
import type { Mechanic } from "./mechanics.js"

const m = (id: string, extra: Partial<Mechanic> = {}): Mechanic => ({ id, ...extra })
const reg = (...ms: Mechanic[]) => new Map(ms.map((x) => [x.id, x]))
const base = () => reg(m("markets", { advance: () => ({}), escrowed: () => 0 }), m("irl"), m("veto"))

describe("validateModules", () => {
  it("returns enabled mechanics sorted by id", () => {
    expect(validateModules(["veto", "irl", "markets"], base()).map((x) => x.id))
      .toEqual(["irl", "markets", "veto"])
  })
  it("refuses an unknown id and a duplicate id", () => {
    expect(() => validateModules(["ghost"], base())).toThrow(/unknown/)
    expect(() => validateModules(["irl", "irl"], base())).toThrow(/duplicate/)
  })
  it("refuses veto without irl — the hardcoded dependency", () => {
    expect(() => validateModules(["markets", "veto"], base())).toThrow(/veto.*irl/)
  })
  it("refuses advance without escrowed", () => {
    const bad = reg(m("stateful", { advance: () => ({}) }))
    expect(() => validateModules(["stateful"], bad)).toThrow(/escrowed/)
  })
})
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```ts
// src/engine/registry.ts
import { cmp } from "./sort.js"
import type { Mechanic } from "./mechanics.js"

export function validateModules(enabled: string[], registry: Map<string, Mechanic>): Mechanic[] {
  const seen = new Set<string>()
  for (const id of enabled) {
    if (seen.has(id)) throw new Error(`duplicate module id: ${id}`)
    seen.add(id)
    if (!registry.has(id)) throw new Error(`unknown module id: ${id}`)
  }
  if (seen.has("veto") && !seen.has("irl")) {
    throw new Error("veto requires irl: with IRL off the veto would fire ungated or vanish")
  }
  const out = enabled.map((id) => registry.get(id)!).sort((a, b) => cmp(a.id, b.id))
  for (const x of out) {
    if (x.advance && !x.escrowed) {
      throw new Error(`${x.id} has advance but no escrowed — the conservation test cannot see its soldiers`)
    }
  }
  return out
}
```

- [ ] **Step 4: Run both test files + typecheck** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(engine): season-init registry validation, veto->irl hardcoded"`

---

### Task 3: Extend the purity scan to module subdirectories

**Files:**
- Modify: `src/engine/types.test.ts` (the scan at lines 7–8, the `./`-prefix assertion at line 19)
- Create: `src/engine/modules/.gitkeep` (the directory must exist for the scan)

The shipped test does `readdirSync("src/engine")` (non-recursive) and asserts every import
specifier `startsWith("./")`. Two changes, both required (spec, "The hook interface"):
recurse into `src/engine/modules/` (and later `src/engine/rules/`), and rewrite the
boundary check — a subdirectory file legitimately imports `../types.js`, which fails the
`./` prefix, while naive resolution alone would ACCEPT a bare package specifier
(`join("src/engine/modules", "lodash")` is under `src/engine/`). So: **reject any
specifier not beginning `./` or `../` first; resolve only the relative ones** and assert
the result stays under `src/engine/`.

- [ ] **Step 1: Write the failing test change.** In `src/engine/types.test.ts`, replace the flat `readdirSync` with a recursive walk and replace the prefix assertion:

```ts
import { readdirSync } from "node:fs"
import { posix } from "node:path"

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  )
// use walk("src/engine") where the file list was built

// boundary check, per import specifier `spec` found in file `f`:
expect(spec.startsWith("./") || spec.startsWith("../"), `${f} imports ${spec}`).toBe(true)
const resolved = posix.normalize(posix.join(posix.dirname(f), spec))
expect(resolved.startsWith("src/engine/"), `${f} imports outside the engine: ${resolved}`).toBe(true)
```

Keep the existing `/Date\.now|Math\.random|new Date\(/` pattern ban unchanged — it now
covers every walked file.

- [ ] **Step 2: Run** — `npm test -- src/engine/types.test.ts` → PASS (empty `modules/` dir; existing files all use `./`). Temporarily add `import "lodash"` to a scratch engine file to see it FAIL, then remove it — that is the regression the rewrite must catch.
- [ ] **Step 3: Commit** — `git commit -m "test(engine): purity scan recurses into modules/, import boundary resolves relative specifiers"`

---

### Task 4: The three season-one modules

**Files:**
- Create: `src/engine/modules/markets.ts`, `src/engine/modules/irl.ts`, `src/engine/modules/veto.ts`, `src/engine/modules/index.ts`
- Test: `src/engine/modules/markets.test.ts`, `src/engine/modules/veto.test.ts`

**Interfaces:**
- Consumes: `Mechanic`, `SpendClaim`, `LockResult` (Task 1); `settleAll`, `escrow`, `payout` from `../wagers.js`; `irlGrants` from `../irl.js`; `territoriesOf` from `../setup.js`.
- Produces:
  `marketsModule: Mechanic` (id `"markets"`; hooks: grant, spend, validate, advance, escrowed),
  `irlModule: Mechanic` (id `"irl"`; grant),
  `vetoModule: Mechanic` (id `"veto"`; lock, validate),
  `MODULE_REGISTRY: Map<string, Mechanic>` (index.ts),
  `marketsStateOf(state: GameState): { pending: PendingWager[] }` (validating parser, throws on bad shape),
  `marketIdsOf(state: GameState): Set<MarketId>`,
  `pendingWagersOf(state: GameState): readonly PendingWager[]`.
  These build against Task 5's `GameState.moduleState`/`DailyContext.tickInstant`, so
  **Task 4 lands in the same commit series as Task 5 but is written first** — write the
  module files and tests now; they compile once Task 5's type change lands. (Execute
  Tasks 4+5 as one unit if running task-per-subagent.)

- [ ] **Step 1: Write the module implementations**

```ts
// src/engine/modules/markets.ts
import { escrow, settleAll } from "../wagers.js"
import type {
  Mechanic, ModuleStateValue, SpendClaim,
} from "../mechanics.js"
import type { GameState, MarketId, PendingWager } from "../types.js"

/** Validating parser for this module's own slot — the only code that reads the shape. */
export function marketsStateOf(state: GameState): { pending: PendingWager[] } {
  const own = state.moduleState["markets"]
  if (own === undefined) return { pending: [] }
  const p = (own as { pending?: unknown }).pending
  if (!Array.isArray(p)) throw new Error("markets moduleState is corrupt: pending is not an array")
  return { pending: p as PendingWager[] }
}

export function marketIdsOf(state: GameState): Set<MarketId> {
  return new Set(marketsStateOf(state).pending.map((w) => w.marketId))
}

export function pendingWagersOf(state: GameState): readonly PendingWager[] {
  return marketsStateOf(state).pending
}

export const marketsModule: Mechanic = {
  id: "markets",

  // Step 1 — settlement payouts. Credit-only; the stake left at escrow.
  grant(state, ctx) {
    const settled = settleAll(marketsStateOf(state).pending, ctx.settlements, state.day + 1)
    return settled.events.flatMap((e) => {
      if (e.t !== "wagerSettle" || e.payout === 0) return []
      const w = marketsStateOf(state).pending.find((p) => p.wagerId === e.wagerId)!
      return [{ faction: w.factionId, amount: e.payout, event: e }]
    })
  },

  // Step 2 — one claim per validated wager; lockedAt = the market's slate close.
  spend(state, orders, ctx) {
    const closes = new Map(ctx.slate.map((m) => [m.id, m.closeTime]))
    const claims: SpendClaim[] = []
    for (const o of orders) {
      for (const w of o.wagers) {
        claims.push({
          faction: o.factionId,
          amount: w.stake,
          lockedAt: closes.get(w.marketId)!,
          ref: `wager:${w.marketId}`,
        })
      }
    }
    return claims
  },

  // Step 7 — drop settled, keep unsettled, append this tick's honored escrow.
  advance(state, orders, ctx, honored): ModuleStateValue {
    const day = state.day + 1
    const prior = marketsStateOf(state).pending
    const settled = settleAll(prior, ctx.settlements, day)
    const pending: PendingWager[] = [...settled.keep]
    const honoredRefs = new Set(honored.map((h) => `${h.faction}|${h.ref}`))
    for (const o of orders) {
      const kept = o.wagers.filter((w) => honoredRefs.has(`${o.factionId}|wager:${w.marketId}`))
      if (kept.length === 0) continue
      pending.push(...escrow({ ...o, wagers: kept }, ctx.slate, day, pending.length))
    }
    return { pending }
  },

  escrowed(own) {
    const p = (own as { pending?: PendingWager[] })?.pending ?? []
    return p.reduce((a, w) => a + w.stake, 0)
  },
}
```

```ts
// src/engine/modules/irl.ts
import { irlGrants } from "../irl.js"
import type { Mechanic } from "../mechanics.js"

export const irlModule: Mechanic = {
  id: "irl",
  grant(_state, ctx) {
    return [...irlGrants(ctx.approvals)]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([faction, g]) => ({
        faction,
        amount: g.actions + g.bonus,
        event: { t: "irl" as const, faction, actions: g.actions, bonus: g.bonus },
      }))
  },
}
```

```ts
// src/engine/modules/veto.ts
import { territoriesOf } from "../setup.js"
import type { LockResult, Mechanic } from "../mechanics.js"
import type { TerritoryId } from "../types.js"

export const vetoModule: Mechanic = {
  id: "veto",

  // Parity over eliminated posters — moved verbatim from combat.ts 6a. Both
  // halves of the gate are load-bearing: eliminated (no free veto for the
  // living) and POSTED, never approved (an approval gate weaponizes the 👍).
  lock(state, orders, ctx): LockResult[] {
    const posted = new Set(ctx.postedToday)
    const picks: Record<TerritoryId, number> = {}
    for (const o of [...orders].sort((a, b) => (a.factionId < b.factionId ? -1 : 1))) {
      if (o.protect && posted.has(o.factionId) && territoriesOf(state, o.factionId).length === 0) {
        picks[o.protect] = (picks[o.protect] ?? 0) + 1
      }
    }
    return Object.keys(picks).sort()
      .filter((t) => picks[t]! % 2 === 1)
      .map((t) => ({ territory: t, event: { t: "protected" as const, territory: t, byCount: picks[t]! } }))
  },

  // Protect legality — moved from core validateOrder (the protect block).
  validate(state, order) {
    if (order.protect === null) return []
    const rejections = []
    if (territoriesOf(state, order.factionId).length > 0) {
      rejections.push({ t: "rejected" as const, faction: order.factionId, field: "protect", reason: "faction is not eliminated" })
    } else if (!state.map.territories.some((t) => t.id === order.protect)) {
      rejections.push({ t: "rejected" as const, faction: order.factionId, field: "protect", reason: `unknown territory ${order.protect}` })
    }
    return rejections
  },
}
```

```ts
// src/engine/modules/index.ts
import { irlModule } from "./irl.js"
import { marketsModule } from "./markets.js"
import { vetoModule } from "./veto.js"
import type { Mechanic } from "../mechanics.js"

export { marketIdsOf, marketsStateOf, pendingWagersOf } from "./markets.js"
export const MODULE_REGISTRY: Map<string, Mechanic> = new Map(
  [marketsModule, irlModule, vetoModule].map((m) => [m.id, m]),
)
```

- [ ] **Step 2: Write the module unit tests** (compile after Task 5; assert: `marketsModule.grant` credits a winning settlement and skips losses; `spend` produces one claim per wager with the slate close as `lockedAt`; `advance` keeps unsettled wagers, drops settled ones, appends only honored escrow (a wager absent from `honored` is NOT escrowed — the round-1 blocker); `escrowed` sums stakes; `vetoModule.lock` returns odd-parity territories with `protected` events and even parity cancels; `veto.validate` rejects a protect from a living faction). Use small literal `GameState` objects with `moduleState: { markets: { pending: [...] } }`.
- [ ] **Step 3: Commit with Task 5** (they land together — see Task 5 step 6).

---

### Task 5: Core type changes + the new pipeline in `resolve.ts`

**Files:**
- Modify: `src/engine/types.ts`, `src/engine/setup.ts:59-71`, `src/engine/resolve.ts`, `src/engine/validate.ts:29-47,117-146,148-158`
- Test: every existing engine test file that mentions `pending` or builds a `DailyContext` (fixture sweep, listed in step 4)

**Interfaces:**
- Produces (exact shapes later tasks and the second plan rely on):

```ts
// types.ts — changed pieces only
export interface DailyContext {
  slate: Market[]; approvals: ApprovedAction[]; postedToday: FactionId[]
  settlements: Record<MarketId, Settlement>
  tickInstant: string          // the tick's frozen ISO instant
  modules: string[]            // enabled module ids
  rules: string[]              // day-scoped; always [] until the catalogue plan
}
export interface GameState {
  seasonId: string; day: number; map: GameMap; factions: Faction[]
  ownership: Record<TerritoryId, FactionId>; garrisons: Record<TerritoryId, number>
  reserves: Record<FactionId, number>
  moduleState: Record<string, unknown>   // replaces `pending`
  log: TickEvent[]; engineVersion: string
}
export type TickEvent =
  | { t: "income"; faction: FactionId; amount: number }
  | { t: "irl"; faction: FactionId; actions: number; bonus: number }
  | { t: "grant"; source: string; faction: FactionId; amount: number }     // NEW
  | { t: "deploy"; faction: FactionId; territory: TerritoryId; count: number }
  | { t: "move"; faction: FactionId; from: TerritoryId; to: TerritoryId; count: number }
  | { t: "fieldBattle"; a: TerritoryId; b: TerritoryId; aContinues: number; bContinues: number; aLost: number; bLost: number }  // +aLost/bLost
  | { t: "protected"; territory: TerritoryId; byCount: number }
  | { t: "attack"; from: TerritoryId; to: TerritoryId; attacker: FactionId
      committed: number; survivors: number; captured: boolean
      lost: number; defenderLost: number; fee?: number }                    // +lost/defenderLost/fee
  | { t: "wagerSettle"; wagerId: string; outcome: Settlement; payout: number; stake: number }  // +stake
  | { t: "rejected"; faction: FactionId; field: string; reason: string; ref?: string }         // +ref?
```

- `resolve(state, orders, context)` keeps its signature; it now reads
  `context.modules` through `validateModules(context.modules, MODULE_REGISTRY)`.
- `validateOrder(state, order, context)` loses its reserve checks (deploys `spent + d.count > reserve`, wagers `staked + w.stake > reserve - spent`) and its attack/move CAP checks and its protect block (now `veto.validate`) — it keeps shape, ownership, adjacency, slate-membership, one-per-market. It no longer needs post-deploy garrisons.
- New export from `resolve.ts` (used by Task 6): none — allocation is internal. The pipeline:

```ts
export function resolve(state: GameState, orders: Order[], context: DailyContext): GameState {
  const day = state.day + 1
  const reserves = { ...state.reserves }
  const log: TickEvent[] = []
  const factionIds = state.factions.map((f) => f.id).sort()
  const factionSet = new Set(factionIds)
  const active = validateModules(context.modules, MODULE_REGISTRY)

  // 1 — grant, ONCE: core territory income, then every grant hook (id-sorted).
  for (const f of factionIds) {
    const amount = territoryIncome(state, f)
    if (amount === 0) continue
    reserves[f] = (reserves[f] ?? 0) + amount
    log.push({ t: "income", faction: f, amount })
  }
  for (const m of active) {
    for (const c of m.grant?.(state, context) ?? []) {
      checkContribution(c, factionSet)
      reserves[c.faction] = (reserves[c.faction] ?? 0) + c.amount
      log.push(c.event)
    }
  }

  // 2 — claims: shape/legality validation, then the claim list.
  const working: GameState = { ...state, reserves }
  const clean: Order[] = []
  for (const o of [...orders].sort((a, b) => cmp(a.factionId, b.factionId))) {
    const { clean: c, rejections } = validateOrder(working, o, context)
    for (const m of active) rejections.push(...(m.validate?.(working, c, context) ?? []))
    // module validate() may reject fields (e.g. veto's protect) — apply drops:
    const dropProtect = rejections.some((r) => r.t === "rejected" && r.field === "protect")
    clean.push(dropProtect ? { ...c, protect: null } : c)
    log.push(...rejections)
  }
  const claims: OwnedClaim[] = []
  for (const o of clean) {
    o.deploys.forEach((d, i) =>
      claims.push({
        faction: o.factionId, amount: d.count, lockedAt: context.tickInstant,
        ref: `deploy:${d.territory}`, mechanicId: "", index: i,
        event: { t: "deploy", faction: o.factionId, territory: d.territory, count: d.count },
      }))
  }
  for (const m of active) {
    ;(m.spend?.(working, clean, context) ?? []).forEach((s, i) => {
      checkContribution(s, factionSet)
      parseInstant(s.lockedAt) // refuse the tick loudly on a bad instant
      claims.push({ ...s, mechanicId: m.id, index: i })
    })
  }

  // 3 — allocate: ascending parsed lockedAt; juniors that no longer fit drop.
  const honored: OwnedClaim[] = []
  const garrisons = { ...state.garrisons }
  for (const c of sortClaims(claims)) {
    if (c.amount > (reserves[c.faction] ?? 0)) {
      log.push({ t: "rejected", faction: c.faction, field: c.mechanicId === "" ? "deploys" : "wagers", reason: "reserve short", ref: c.ref })
      continue
    }
    reserves[c.faction] = (reserves[c.faction] ?? 0) - c.amount
    honored.push(c)
    if (c.event) log.push(c.event)
    if (c.mechanicId === "") {
      const territory = c.ref.slice("deploy:".length)
      garrisons[territory] = (garrisons[territory] ?? 0) + c.amount  // deploys LAND here
    }
  }

  // 4 — locks: union of lock hooks; the engine logs each supplied event.
  const locked = new Set<TerritoryId>()
  for (const m of active) {
    for (const r of m.lock?.(working, clean, context) ?? []) {
      if (!locked.has(r.territory) && r.event) log.push(r.event)
      locked.add(r.territory)
    }
  }

  // 5+6 — movement validation and combat (Task 6 owns the internals).
  const dials = mergeDials(active, working, context)
  const combat = resolveCombat({ ...state, garrisons, reserves }, clean, locked, dials, log)

  // 7 — advance, each module seeing ITS OWN honored claims.
  const moduleState: Record<string, unknown> = {}
  for (const m of active) {
    if (!m.advance) continue
    moduleState[m.id] = m.advance(state, clean, context,
      honored.filter((h) => h.mechanicId === m.id))
  }

  for (const f of factionIds) {
    if ((reserves[f] ?? 0) < 0) throw new Error(`engine invariant violated: reserve for ${f} is ${reserves[f]}`)
  }
  return { ...state, day, ownership: combat.ownership, garrisons: combat.garrisons,
           reserves, moduleState, log, engineVersion: ENGINE_VERSION }
}
```

(`mergeDials` sums `attackDepartureCost` across hooks and clamps to `MAX_DEPARTURE_COST`;
until Task 6 lands, `resolveCombat` keeps its current cap-free behavior with the attack
CAP check temporarily performed exactly as today inside a step-5 shim — see step 3.)

- [ ] **Step 1: Write the failing pipeline tests first** (in `src/engine/resolve.test.ts`, add):

```ts
const ISO_CLOSE = "2026-09-01T18:00:00.000Z"
const TICK = "2026-09-01T21:00:00.000Z"
// every ctx literal in engine tests becomes:
// { slate, approvals, postedToday, settlements, tickInstant: TICK, modules: ["markets","irl","veto"], rules: [] }

it("allocation: a 20:59 deploy cannot drop a 16:00-locked wager", () => {
  // reserve 10; wager stake 10 on a market closing 16:00; deploy 10.
  // The wager is senior: the deploy drops with a rejected event carrying its ref,
  // and the attack that depended on the deploy is capped out (phantom-troop case).
})
it("a season with no modules resolves plain Risk with moduleState {}", () => {
  // modules: [] — income, deploys, attacks work; no wagerSettle/irl/protected
  // events; wagers and protect in orders are rejected by absence of module validate?
  // NO — with markets off the wager field is rejected upstream (web/API, Task 12);
  // the engine drops it here as "not on today's slate" (empty slate). Assert moduleState = {}.
})
it("hook determinism: byte-identical output regardless of configured order", () => {
  // resolve(s, o, {...ctx, modules: ["veto","irl","markets"]}) deep-equals
  // resolve(s, o, {...ctx, modules: ["markets","irl","veto"]})
})
it("refuses the tick on an unparseable lockedAt", () => {
  // slate close "T18:00" + a wager order → expect resolve to throw /lockedAt/
})
```

- [ ] **Step 2: Apply the type changes** (`types.ts` as in Interfaces above; `setup.ts` returns `moduleState: {}` in place of `pending: []`). `npm run typecheck` now fails across the repo — expected; fix engine-side only in this task (store/jobs/sim/web are Tasks 9–13; leave them red at HEAD? No —) **the repo must typecheck at every commit**, so this task's sweep includes the *mechanical* renames outside the engine: `s.pending` → `pendingWagersOf(s)` in `src/jobs/tick.ts:129`, `src/jobs/rerun.ts:163`, `src/sim/run.ts:150`; `parseState`/`saveState` in `src/store/sqlite.ts` accept `moduleState` (full store semantics in Task 11); every test literal gains `tickInstant/modules/rules` and `moduleState`. Grep list: `grep -rn "\.pending\b\|pending:" src --include="*.ts"` — the complete production set is `types.ts`, `setup.ts:67`, `resolve.ts:38,81,105`, `sqlite.ts:83`, `tick.ts:129`, `rerun.ts:163`, `sim/run.ts:150,171`.
- [ ] **Step 3: Rewrite `resolve.ts`** per the Interfaces block, and cut `validateOrder` down: delete the deploy reserve check (`spent + d.count > reserve` and the `spent` ledger), the wager reserve check (`staked + w.stake > reserve - spent`), the attack/move cap checks and the `postDeploy`/`committed` ledgers (a step-5 shim reproduces today's cap behavior until Task 6: run the old cap logic against post-allocation garrisons, so this task changes reserve semantics only), and the protect block (veto owns it). Keep every shape/ownership/adjacency/slate/one-per-market check verbatim.
- [ ] **Step 4: Fixture sweep** — every `closeTime: "T18:00"` becomes `ISO_CLOSE` and every `DailyContext` literal gains the three fields, in: `src/engine/invariants.test.ts:14-15`, `src/engine/golden.test.ts:39`, `src/engine/wagers.test.ts:6-7`, `src/engine/resolve.test.ts:13`, `src/sim/policies.test.ts:10`, `src/sim/run.ts:69` (production sim code: ISO close strictly before the tick) and `src/sim/run.ts:156` (the sim's context literal gains a per-day `tickInstant` strictly after every close — wrong ordering here silently measures the pre-fix game).
- [ ] **Step 5: Run the full suite** — `npm test` → the new pipeline tests PASS; golden test FAILS (expected — event additions changed the log shape). Do NOT regenerate yet; Task 10 does it deliberately. Mark it `it.skip` with a `// re-enabled in Task 10` comment if intermediate commits need green, or land Tasks 5–7 as one PR-sized series with golden regen at the end.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(engine)!: module dispatch, seniority allocation phase, moduleState replaces pending"`

---

### Task 6: Locks-before-validation, merge-then-validate, and the combat dial

**Files:**
- Modify: `src/engine/combat.ts` (whole file), `src/engine/resolve.ts` (drop the step-5 shim)
- Test: `src/engine/combat.test.ts`, `src/engine/invariants.test.ts`

**Interfaces:**
- Produces: `resolveCombat(state, orders, locked: ReadonlySet<TerritoryId>, dials: CombatDials, log: TickEvent[])` — same return shape as today (`{ ownership, garrisons, events }`). Internals:
  - **Void first**: an attack whose `to` is in `locked` is dropped before anything else, logging `{t:"rejected", faction, field:"attacks", reason:"protected", ref:`attack:${from}|${to}`}`. It consumes no cap and no fee (parity events were already logged by the engine from `LockResult`s).
  - **Merge-then-validate**: merge each faction's surviving attacks by `(from, to)` (the existing `byDirection` logic, moved before the cap), then cap-check each merged movement: moves first (fee-free, `count` only — today's moves-first priority stands), then movements in `(from, to)` order, each consuming `count + dials.attackDepartureCost` from the origin's `max(0, garrison − 1)` shared ledger. An over-cap MERGED movement is rejected whole (all-or-nothing, replacing today's per-line greedy acceptance — a deliberate behavior change, "What this breaks") with one `rejected` event naming the direction.
  - **Departure** deducts `committed + fee` per surviving movement; the fee is casualties.
  - **Events**: `attack` carries `fee` (when > 0), `lost` (this movement's share of its faction's TARGET-COMBAT casualties — field-battle deaths are `fieldBattle`'s, withdrawn survivors are alive), `defenderLost` (the territory's defender losses, logged ONCE per contested territory on the surviving arrival with the lexicographically-first `from`, zero elsewhere). Per-faction casualties from `allocateCasualties` split across that faction's legs largest-remainder by leg size (deterministic; sums exactly). `fieldBattle` carries `aLost`/`bLost` (`min(a,b)` and the loser's full size — from the existing arithmetic: loser dies wholly, winner loses `2·min − min`… compute as `aLost = a − aContinues_survivorsMeaning` — concretely: `aLost = x.committed_at_battle − x.size_after` per side, using each side's pre-battle `size`). **A movement annihilated in a field battle still emits its `attack` event** (`committed`, `survivors: 0`, `lost: 0`, its `fee`, `captured: false`) — the current `m.size > 0` filters would silently drop its fee from the log.
- Consumes: `CombatDials`, `MAX_DEPARTURE_COST` (Task 1); `locked` from resolve step 4.

- [ ] **Step 1: Write the failing tests**

```ts
// combat.test.ts additions — the review panel's worked cases, verbatim:
it("dial: fee charged inside the cap — garrison 3, cost 1", () => {
  // X garrison 3 (cap 2). X→Y 1 consumes 2 (fits); X→Z 1 would total 4 > 2 → rejected.
  // Survivor departs 1+1; X ends at 1. Assert the rejected event names X|Z.
})
it("dial: merged duplicate lines cost one fee, and over-cap merged movements reject whole", () => {
  // garrison 8, cap 7, cost 0: two X→Y 5 lines merge to X→Y 10 > 7 → REJECTED WHOLE
  // (replaces today's partial acceptance — the pinned behavior change).
  // cost 1, two X→Y 1 lines: merged X→Y 2 consumes 3; same as one X→Y 2 line.
})
it("locks void before validation: a protected attack frees cap for a valid one", () => {
  // garrison 3, cost 1, attack A→P (P locked) and A→Q: the P attack is voided with
  // reason "protected" and consumes nothing; the Q attack survives at 1+1 ≤ 2.
})
it("an annihilated movement still logs its attack event with its fee", () => {
  // mutual X→Y / Y→X equal sizes on a dial day: both die in the field battle;
  // both attack events exist with fee set, lost 0, survivors 0.
})
it("defenderLost logs once per contested territory and sums exactly", () => {
  // two factions attack T from A and B and capture: sum of defenderLost across
  // T's attack events === T's pre-battle garrison; only the lexicographically
  // first surviving arrival carries it.
})
```

- [ ] **Step 2: Run to verify failures**, then **Step 3: Implement** the `resolveCombat` rewrite: keep 6a2 (moves) verbatim; delete the 6a parity block (veto owns it — `locked` arrives as a parameter); insert the void-then-merge-then-cap sequence; thread per-side pre-battle sizes so `fieldBattle.aLost/bLost` and per-leg `lost` are computable; drop both `m.size > 0` filters in favour of emitting zero-strength events; deduct `committed + fee` at 6c. Remove the Task-5 shim from `resolve.ts` and pass `locked`/`dials` through.
- [ ] **Step 4: Rewrite the conservation invariant** (`invariants.test.ts`): `totalOf` = garrisons + reserves + Σ modules' `escrowed(moduleState[id])`; add the **two-sided** test from the spec's source table:

```ts
const created = log: income.amount + irl.(actions+bonus) + grant.amount
  + wagerSettle: (payout > 0 && outcome !== "unsettled" ? payout - stake : 0)
  + wagerSettle: (outcome === "unsettled" ? 0 : 0)   // refund = transfer, nets zero
const destroyed = log: attack.(lost + defenderLost + (fee ?? 0)) + fieldBattle.(aLost + bLost)
  + wagerSettle: (outcome !== "unsettled" && payout === 0 ? stake : 0)
expect(totalOf(next)).toBe(totalOf(before) + created - destroyed)
```

Keep the one-sided `<=` test too (it guards different regressions). Extend `arbOrder` with `moves` (`fc.array(fc.record({ from, to, count }), { maxLength: 3 })`) and run the garrison-≥-0 property **with a dial-active context** (add a test-only mechanic contributing `{attackDepartureCost: 1}` to the registry used by the test). Add the synthetic-tie mechanic test: two claims at one instant break on mechanic id (`""` core first) then index.
- [ ] **Step 5: Run** `npm test -- src/engine` → PASS (golden still skipped). **Step 6: Commit** — `git commit -m "feat(engine): locks before validation, merged-movement caps, the departure-cost dial, two-sided accounting"`

---

### Task 7: Malformed-hook-return refusal tests

**Files:**
- Test: `src/engine/resolve.test.ts`

- [ ] **Step 1: Write the tests** (spec test 16): register a test-only mechanic whose `grant` returns `amount: -1`, then `amount: 1.5`, then `faction: "ghost"`; assert `resolve` throws for each (the tick refuses rather than resolving with corrupt claims). Also: a `spend` claim with `lockedAt: "T18:00"` throws `/lockedAt/`.
- [ ] **Step 2: Run** → PASS (Task 5's `checkContribution`/`parseInstant` calls already enforce). **Step 3: Commit** — `git commit -m "test(engine): malformed hook returns refuse the tick"`

---

### Task 8: Module isolation matrix

**Files:**
- Test: `src/engine/modules/matrix.test.ts` (create)

- [ ] **Step 1: Write the tests** (spec tests 1–2): resolve a small scripted day under `modules: []` (plain Risk, `moduleState` = `{}`, no module events), `["markets"]` only (wagers escrow/settle; no irl/protected events), `["irl"]` only, `["irl","veto"]` (protect works; a `["veto"]`-only registry call throws from Task 2). Assert the exact event-type sets per configuration.
- [ ] **Step 2: Run** → PASS. **Step 3: Commit** — `git commit -m "test(engine): each module in isolation, and none"`

---

### Task 9: Config coupling pin

**Files:**
- Modify: `src/config.test.ts`
- Test: same file

- [ ] **Step 1: Write the failing-if-drifted assertion**: import `WINDOW_CLOSE_HOUR` from `./config.js` (`src/config.ts:62`) and `TICK_HOUR` from `./slack/config.js` (`src/slack/config.ts:20` — a different module; name both symbols) and assert equality with a comment: a slate market closing at/after the tick would let a late wager outrank nothing — it reopens the deploy-inflation exploit for late-closing markets.
- [ ] **Step 2: Run + commit** — `git commit -m "test(config): pin WINDOW_CLOSE_HOUR to TICK_HOUR"`

---

### Task 10: Golden file — extend, regenerate, read the diff

**Files:**
- Modify: `src/engine/golden.test.ts` (the order script and the regen path)
- Regenerate: `src/engine/__golden__/season-1.json`

- [ ] **Step 1: Extend the scripted season to eliminate a faction** and have it post + protect on a later day — the tick-runner review found the current golden season never exercises protections (0 `protected` events in the file), so it cannot catch a veto regression. Add scripted attacks that wipe one faction's two starting territories, then a `protect` pick from it.
- [ ] **Step 2: Regenerate deliberately** (the test file documents its own regen flag), then `git diff` the JSON and READ it: expect `moduleState.markets.pending` where `pending` was; `grant`-shaped additions none (no rules yet); `attack` events carrying `lost`/`defenderLost`; `fieldBattle` carrying `aLost`/`bLost`; `wagerSettle` carrying `stake`; at least one `protected` event; allocation-ordered rejections where the script over-commits. Any OTHER behavioral drift (ownership/garrison/reserve values changing on days the script didn't change) is a bug — stop and diagnose before committing.
- [ ] **Step 3: Re-enable the golden test**, run the full suite → PASS. **Step 4: Commit** — `git commit -m "test(engine): golden season exercises elimination and protection; regenerate for moduleState"`

---

### Task 11: Store — migration, parseState, JSON round-trip

**Files:**
- Modify: `src/store/schema.ts` (APPEND a new migration — never edit indices 0–5), `src/store/sqlite.ts` (`parseState` at :83, `saveState`)
- Test: `src/store/sqlite.test.ts` (or the store's existing test file)

- [ ] **Step 1: Write the failing migration test** (spec test 10): open a fresh store, force `user_version` to the pre-change value, insert a real pre-migration `states.state` row (a JSON literal with `pending: [{...one wager...}]` and no `moduleState`) and one with `pending: []`; run `migrate`; assert both rows load, `Array.isArray(state.moduleState.markets.pending)` is true (an array, not a quoted string), and `$.pending` is gone. Assert `parseState` rejects a row with NEITHER `pending` nor `moduleState`.
- [ ] **Step 2: Append the migration** — exactly the spec's pinned SQL (verified against `node:sqlite` JSON1 during review):

```sql
ALTER TABLE seasons ADD COLUMN modules TEXT NOT NULL DEFAULT '["markets","irl","veto"]';
UPDATE states SET state = json_set(
  json_remove(state, '$.pending'),
  '$.moduleState',
  json_object('markets', json_object('pending', json_extract(state, '$.pending')))
);
```

(The `rule_offers`/`rule_reactions` tables belong to the catalogue plan's migration, appended after this one.)
- [ ] **Step 3: Update `parseState`**: replace `if (!Array.isArray(s.pending)) return bad("pending is absent")` with a check that `s.moduleState` is a plain object (and delegate the markets slot's shape to `marketsStateOf` at read sites — the store treats values as opaque). Update `saveState` to assert JSON round-trip: `JSON.parse(JSON.stringify(state.moduleState))` deep-equals — a module returning non-JSON (undefined/cycles) must throw at save, not silently drop.
- [ ] **Step 4: Run store tests + full suite** → PASS. **Step 5: Commit** — `git commit -m "feat(store): seasons.modules + states pending->moduleState data migration"`

---

### Task 12: Jobs — context assembly, backfill, gating, lifetime

**Files:**
- Modify: `src/jobs/tick.ts:119-145`, `src/jobs/rerun.ts:131-166`, `src/jobs/publish-slate.ts`, `src/jobs/poll-settlements.ts`, `src/jobs/poll-prices.ts`, `src/jobs/season-init.ts:41-47`
- Create: `src/jobs/modules-cli.ts` (the operator enable/disable command; wire an npm script `modules:set`)
- Test: `src/jobs/tick.test.ts`, `src/jobs/rerun.test.ts`

**Interfaces:**
- Consumes: `tickInstant(season, day)` — already shipped at `src/season.ts:35-37` (`etInstant(etDateAdd(season.startDate, day), TICK_HOUR)`); `validateModules`, `MODULE_REGISTRY`, `marketIdsOf`, `marketsStateOf`.
- Produces: `assembleContext` behavior later reruns rely on (below); `runModulesSet(store, seasonId, modules: string[])` returning exit-code semantics (0 applied, 2 refused).

- [ ] **Step 1: Write the failing tests**
  - `tick.ts`: the context it freezes now carries `tickInstant` (from `src/season.ts`'s helper — the engine still gets time as an argument), `modules` (parsed from the season row's `modules` column), `rules: []`. The settlements id set comes from `marketIdsOf(previous)` — the job layer never touches the slot shape.
  - `rerun.ts` **backfill** (spec test 8): a frozen pre-change context (four fields only) replays — the assembler synthesizes exactly `tickInstant` (the calendar helper), `modules: ["markets","irl","veto"]` (**the literal — NEVER the season row**; mutate `season.modules` in the test and assert the replay still used all three, because rerun re-saves contexts via `saveTickContext` and a season-row read would launder the mutation into frozen history), `rules: []`. A context missing anything ELSE still refuses loudly.
  - Gating: `publish-slate`/`poll-settlements`/`poll-prices` with `markets` off → exit 0, log a deliberate-skip line, no network use.
  - `season-init`: calls `validateModules` — a config naming `veto` without `irl` exits 2.
  - Lifetime: `runModulesSet` disabling `markets` while `escrowed > 0` exits 2 with the reason; with escrow 0 it applies AND deletes the `moduleState.markets` slot (idle by the gate's own test); a disable-then-re-enable round trip resurrects nothing (totals unchanged, slot absent until the next tick writes it).
- [ ] **Step 2: Implement** each per the tests. The backfill lives in the one context-assembly function both `tick.ts` and `rerun.ts` share (today `rerun.ts:154-166`'s `assembleContext`) — synthesis only when the stored JSON lacks the field.
- [ ] **Step 3: Run** `npm test -- src/jobs` → PASS. **Step 4: Commit** — `git commit -m "feat(jobs): frozen tickInstant+modules, literal backfill for old contexts, module gating and lifetime"`

---

### Task 13: Web — the markets-off sweep and the seniority copy

**Files:**
- Modify: `src/web/server.ts:97,182,288,312`, `src/web/render.ts:310,368,404,445-476,496`, `src/web/projection-data.ts:92-93,106-107,166-167`, `src/web/client.ts` (adjacent to :1029-1031)
- Test: `src/web/board.test.ts`, `src/web/server.test.ts`, `src/web/render.test.ts`

- [ ] **Step 1: Write the failing tests** (spec test 14): with a markets-off season — the `/` projection JSON contains no `wagers` and no `slate` key (they become optional on the projection type; assert absent, not empty — `board.test.ts` already parses the projection back out); the board HTML contains no `/wagers` link (`render.ts:368` today); `/wagers` returns 404; `POST /api/plan` with a `wagers` array returns the explicit rejection reason (and `protect` likewise for veto-off); the two both-modules-on copy strings (`render.ts:310` "Approved workouts and settled wagers arrive at the tick", `:496` "Income, workouts and settled wagers are all the same…") are absent.
- [ ] **Step 2: Implement the gating** — thread `modules` into the projection/render calls from the season row; make `wagers`/`slate` optional on `Projection` via conditional spread (never explicit `undefined` — `exactOptionalPropertyTypes`).
- [ ] **Step 3: Renderer exhaustiveness** (spec test 13): add the missing `case "move"` to the event switch (it opens at `render.ts:445`; today `move` events silently vanish from the replay — that fix is the proof), a `case "grant"` (renders as income with the source label), and `default: assertNever(e)` after the last case (new helper: `const assertNever = (x: never): never => { throw new Error(\`unhandled event \${JSON.stringify(x)}\`) }`). Renderers skip zero-strength `attack` arrivals but the event remains in the data.
- [ ] **Step 4: Client copy** — ADD (nothing exists there today) one hint next to the reserve counter's `over` state (`client.ts:1029-1031`): "Over budget: your wagers are locked — deploys are what a short reserve drops." The client already treats wagers as senior when adding deploys (`spent()` counts stakes); the gap is only the stale-plan path where later wagers push an existing plan negative.
- [ ] **Step 5: Recap coverage test** (spec test 13, recap half): in `src/slack/recap.test.ts` add `const RECAP_HANDLED = ["income","irl","protected","move","fieldBattle","attack","wagerSettle","rejected"] as const; const RECAP_IGNORED = ["deploy","grant"] as const` — wait: `grant` must be HANDLED (the recap should render module grants; add an `of("grant")` section beside income in `recap.ts`). So `RECAP_IGNORED = ["deploy"]` (deliberately unrendered, with a comment) and assert `new Set([...RECAP_HANDLED, ...RECAP_IGNORED])` equals the set of `TickEvent["t"]` members (type-level: `satisfies TickEvent["t"][]` on both arrays plus a length check against a `TickEvent["t"]` union-to-tuple helper, or simply assert against a hand-listed literal that the type system checks via `satisfies`). A new variant then fails the suite.
- [ ] **Step 6: Run** `npm test -- src/web src/slack` → PASS. **Step 7: Commit** — `git commit -m "feat(web,slack): markets-off surfaces absent, renderer exhaustive, recap coverage pinned"`

---

### Task 14: Simulator — module set, and the balance rerun

**Files:**
- Modify: `src/sim/run.ts` (:69 close already ISO'd in Task 5; :150-171 pending reads via `pendingWagersOf`; :156 context literal carries per-day `tickInstant`; `runSeason`/`runMany` gain a `modules` parameter defaulting to all three)
- Test: `src/sim/run.test.ts` (or policies.test.ts)
- Docs: `docs/superpowers/reviews/2026-08-11-balance-run-modules.md` (create, from the run output)

- [ ] **Step 1: Write the failing test**: `runSeason(names, seed, { modules: [] })` completes a season with zero `wagerSettle`/`irl` events; the default-module run still completes; the sim's per-day `tickInstant` parses strictly later than every slate close (assert with `parseInstant`).
- [ ] **Step 2: Implement** — thread `modules` into the sim's context; settlement weighting reads `pendingWagersOf(state)` (`side`/`price` — the accessor Task 4 exports).
- [ ] **Step 3: Rerun the balance suite** — `npm run sim` (2,000 seasons) for a smoke check, then the committed run at 10,000 seasons with pinned seeds (`runSeason(policyNames, seed)`; `runMany` already draws seeds deterministically). The allocation reordering, lock-before-validate, in-cap dial charging AND merge-then-validate all changed combat outcomes — **this is a redo, not a re-check**. Record per-policy win rates against `docs/superpowers/reviews/2026-08-10-balance-run-world.md` and write the new review doc; win-rate movement beyond ~2 points for any policy needs an explanation in the doc before merging (the rule-catalogue plan later adds the per-rule forced runs and the 3-point gate).
- [ ] **Step 4: Full suite + typecheck** — `npm test && npm run typecheck` → all green, 658+ tests.
- [ ] **Step 5: Commit** — `git commit -m "feat(sim): module-aware seasons; redo the balance run for the allocation reordering"`

---

### Task 15: Docs sweep

**Files:**
- Modify: `CLAUDE.md` (the "Not built" section — pluggable mechanics core is now built; the rule catalogue plan remains), `HANDOFF.md` (current state, test count, the stale "stale-price fix" line), `codemaps/` (run `cc-codemaps:update-codemaps` or edit engine.md/data.md by hand to name `mechanics.ts`, `modules/`, `moduleState`), and the stale `first_staked_at` comment in `src/store/sqlite.ts` (it says it anchors "the sequential-greedy reserve check", which no longer exists — reword to "immovable on re-stake; claim seniority now orders by lockedAt").

- [ ] **Step 1: Make the edits above.** **Step 2: `npm test` one last time.** **Step 3: Commit** — `git commit -m "docs: module system landed; retire sequential-greedy references"`

---

## Self-review (performed)

- **Spec coverage:** hook interface → T1; registry/per-namespace/needs → T2 (module half; `needs` is catalogue-plan scope); purity scan → T3; season-one modules + helpers (`marketIdsOf`, `pendingWagersOf`) → T4; pipeline/allocation/tickInstant/claim tagging/deploy-landing → T5; locks-first, merge-then-validate, dial arithmetic, fee/lost/defenderLost/annihilated events, two-sided accounting, moves-in-arbitrary, synthetic tie → T6; malformed returns → T7; isolation matrix → T8; config pin → T9; golden → T10; migration + round-trip + parseState → T11; jobs context/backfill-literals/gating/lifetime/disable-slot-removal → T12; web sweep + client copy + renderer/recap exhaustiveness → T13; sim + balance redo → T14. **Deferred to the catalogue plan:** Rule interface + `needs`, the three rules, `rule_offers`/`rule_reactions` + the vote branch + cutoff predicate, seeded offers, freeze of `rules`, per-rule bounded-swing runs.
- **Placeholders:** none — every step names files, code, and expected outcomes; the two "write tests asserting…" steps enumerate the exact assertions.
- **Type consistency:** `OwnedClaim`/`sortClaims`/`checkContribution`/`parseInstant` (T1) are the names T5–T7 consume; `marketsStateOf`/`marketIdsOf`/`pendingWagersOf` (T4) are the names T5/T11/T12/T14 consume; `resolveCombat(state, orders, locked, dials, log)` (T6) matches T5's call; `MAX_DEPARTURE_COST` defined once (T1).
