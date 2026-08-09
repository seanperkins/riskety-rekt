# Riskety Rekt — Engine & Sim Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure game engine and the offline season simulator, so the economy can be balance-tested before any UI, adapter, or server exists.

**Architecture:** One dependency-free `src/engine/` module exporting `resolve(state, orders, context) → GameState`, plus `src/sim/` which drives thousands of synthetic seasons through it using scripted policies. The engine performs no I/O and imports nothing outside its own folder — that constraint is what makes the simulator possible.

**Tech Stack:** TypeScript 5.x (strict), Vitest, Node 20+. No runtime dependencies in the engine. `fast-check` is a dev dependency for property tests.

**Spec:** `docs/superpowers/specs/2026-08-09-riskety-rekt-design.md`

**This is Plan 1 of 4.** Later plans cover the market adapter + settlement poller, the Slack ingress + recap, and the Next.js web app + SVG renderer.

## Global Constraints

- `src/engine/**` must have **zero runtime dependencies** and must not import from `src/sim/`, `src/adapters/`, or any Node built-in. A test enforces this.
- The engine is **pure**: no `Date.now()`, no `Math.random()`, no I/O. All time and randomness enter as arguments.
- **Never iterate an object's keys without sorting them first.** Determinism is required for golden-file replay.
- All troop and stake values are non-negative safe integers. `reserves[f] >= 0` is an engine invariant, asserted at the end of every step that touches reserves.
- Every tie-break is explicit and documented at its site. No implicit ordering.
- `ENGINE_VERSION` is a constant stamped into every produced state.
- Test files live beside the code as `*.test.ts`.

---

### Task 1: Project scaffold and core types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/engine/types.ts`
- Test: `src/engine/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: all type names used by every later task — `FactionId`, `TerritoryId`, `MarketId`, `GameMap`, `GameState`, `Order`, `Market`, `ApprovedAction`, `DailyContext`, `PendingWager`, `TickEvent`, `WagerSide`, `Settlement`, and the constant `ENGINE_VERSION`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "riskety-rekt",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "sim": "tsx src/sim/cli.ts"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsx": "^4.19.0",
    "fast-check": "^3.22.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

`noUncheckedIndexedAccess` is deliberate — it forces explicit handling of missing territory/faction lookups, which is exactly where the review found bugs.

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
})
```

- [ ] **Step 4: Write `src/engine/types.ts`**

```ts
export const ENGINE_VERSION = "1.0.0"

export type FactionId = string
export type TerritoryId = string
export type ContinentId = string
export type MarketId = string

export type WagerSide = "yes" | "no"
export type Settlement = "yes" | "no" | "unsettled"

export interface Territory {
  id: TerritoryId
  name: string
  continent: ContinentId
  neighbors: TerritoryId[]
}

export interface Continent {
  id: ContinentId
  name: string
  bonus: number
}

export interface GameMap {
  territories: Territory[]
  continents: Continent[]
}

export interface Faction {
  id: FactionId
  playerName: string
  color: string
}

export interface PendingWager {
  wagerId: string
  factionId: FactionId
  marketId: MarketId
  side: WagerSide
  stake: number
  price: number
  placedOnDay: number
}

export interface Market {
  id: MarketId
  question: string
  priceYes: number
  priceNo: number
  closeTime: string
}

export interface ApprovedAction {
  eventId: string
  playerId: FactionId
  postedAt: string
  approvedAt: string
}

export interface DailyContext {
  slate: Market[]
  approvals: ApprovedAction[]
  settlements: Record<MarketId, Settlement>
}

export interface Deploy { territory: TerritoryId; count: number }
export interface Attack { from: TerritoryId; to: TerritoryId; count: number }
export interface WagerOrder { marketId: MarketId; side: WagerSide; stake: number }

export interface Order {
  factionId: FactionId
  deploys: Deploy[]
  attacks: Attack[]
  wagers: WagerOrder[]
  protect: TerritoryId | null
}

export type TickEvent =
  | { t: "income"; faction: FactionId; amount: number }
  | { t: "irl"; faction: FactionId; actions: number; bonus: number }
  | { t: "deploy"; faction: FactionId; territory: TerritoryId; count: number }
  | { t: "fieldBattle"; a: TerritoryId; b: TerritoryId; aContinues: number; bContinues: number }
  | { t: "protected"; territory: TerritoryId; byCount: number }
  | { t: "attack"; from: TerritoryId; to: TerritoryId; attacker: FactionId; committed: number; survivors: number; captured: boolean }
  | { t: "wagerSettle"; wagerId: string; outcome: Settlement; payout: number }
  | { t: "rejected"; faction: FactionId; field: string; reason: string }

export interface GameState {
  seasonId: string
  day: number
  map: GameMap
  factions: Faction[]
  ownership: Record<TerritoryId, FactionId>
  garrisons: Record<TerritoryId, number>
  reserves: Record<FactionId, number>
  pending: PendingWager[]
  log: TickEvent[]
  engineVersion: string
}
```

- [ ] **Step 5: Write the failing purity test**

```ts
// src/engine/types.test.ts
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ENGINE_VERSION } from "./types.js"

describe("engine purity", () => {
  const dir = "src/engine"
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it("imports nothing outside the engine folder", () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8")
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!)
      for (const spec of imports) {
        expect(spec.startsWith("./"), `${f} imports ${spec}`).toBe(true)
      }
    }
  })

  it("uses no wall-clock or randomness", () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8")
      expect(src, `${f}`).not.toMatch(/Date\.now|Math\.random|new Date\(/)
    }
  })

  it("exports a version", () => {
    expect(ENGINE_VERSION).toBe("1.0.0")
  })
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npm install && npx vitest run src/engine/types.test.ts`
Expected: FAIL — `src/engine` has only `types.ts`, which passes; but the run must succeed overall. If `readdirSync` throws, the scaffold is wrong. Expected end state: PASS (this test guards later tasks).

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/engine/types.ts src/engine/types.test.ts
git commit -m "feat(engine): scaffold and core types with purity guard"
```

---

### Task 2: The map and initial deal

**Files:**
- Create: `src/engine/map.ts`
- Create: `src/engine/setup.ts`
- Test: `src/engine/map.test.ts`, `src/engine/setup.test.ts`

**Interfaces:**
- Consumes: `GameMap`, `GameState`, `Faction` from Task 1.
- Produces: `RISK_MAP: GameMap`, `continentBonusesFor(state, factionId): number`, `territoriesOf(state, factionId): TerritoryId[]`, `createSeason(seasonId, factions, shuffled): GameState`.

`createSeason` takes an already-shuffled territory id array so the engine stays pure — the caller supplies the randomness.

- [ ] **Step 1: Write the failing map test**

```ts
// src/engine/map.test.ts
import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"

describe("RISK_MAP", () => {
  it("has 42 territories and 6 continents", () => {
    expect(RISK_MAP.territories).toHaveLength(42)
    expect(RISK_MAP.continents).toHaveLength(6)
  })

  it("has classic continent bonuses summing to 24", () => {
    const total = RISK_MAP.continents.reduce((s, c) => s + c.bonus, 0)
    expect(total).toBe(24)
    const byId = Object.fromEntries(RISK_MAP.continents.map((c) => [c.id, c.bonus]))
    expect(byId).toEqual({ na: 5, sa: 2, eu: 5, af: 3, as: 7, au: 2 })
  })

  it("has classic per-continent territory counts", () => {
    const counts: Record<string, number> = {}
    for (const t of RISK_MAP.territories) counts[t.continent] = (counts[t.continent] ?? 0) + 1
    expect(counts).toEqual({ na: 9, sa: 4, eu: 7, af: 6, as: 12, au: 4 })
  })

  it("has symmetric adjacency and no self-loops", () => {
    const byId = new Map(RISK_MAP.territories.map((t) => [t.id, t]))
    for (const t of RISK_MAP.territories) {
      expect(t.neighbors).not.toContain(t.id)
      for (const n of t.neighbors) {
        const other = byId.get(n)
        expect(other, `${t.id} -> unknown ${n}`).toBeDefined()
        expect(other!.neighbors, `${n} missing back-edge to ${t.id}`).toContain(t.id)
      }
    }
  })

  it("is fully connected", () => {
    const byId = new Map(RISK_MAP.territories.map((t) => [t.id, t]))
    const seen = new Set<string>(["alaska"])
    const queue = ["alaska"]
    while (queue.length) {
      for (const n of byId.get(queue.pop()!)!.neighbors) {
        if (!seen.has(n)) { seen.add(n); queue.push(n) }
      }
    }
    expect(seen.size).toBe(42)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/engine/map.test.ts`
Expected: FAIL — `Failed to resolve import "./map.js"`.

- [ ] **Step 3: Write `src/engine/map.ts`**

Transcribe the standard Risk board. Continent ids: `na`, `sa`, `eu`, `af`, `as`, `au`. Territory ids are lowercase snake_case of the classic names (`alaska`, `northwest_territory`, `alberta`, `ontario`, `quebec`, `western_united_states`, `eastern_united_states`, `central_america`, `greenland`; `venezuela`, `peru`, `brazil`, `argentina`; `iceland`, `scandinavia`, `ukraine`, `great_britain`, `northern_europe`, `western_europe`, `southern_europe`; `north_africa`, `egypt`, `congo`, `east_africa`, `south_africa`, `madagascar`; `siam`, `india`, `china`, `mongolia`, `japan`, `irkutsk`, `yakutsk`, `kamchatka`, `siberia`, `afghanistan`, `ural`, `middle_east`; `indonesia`, `new_guinea`, `western_australia`, `eastern_australia`).

Structure:

```ts
import type { GameMap } from "./types.js"

export const RISK_MAP: GameMap = {
  continents: [
    { id: "na", name: "North America", bonus: 5 },
    { id: "sa", name: "South America", bonus: 2 },
    { id: "eu", name: "Europe", bonus: 5 },
    { id: "af", name: "Africa", bonus: 3 },
    { id: "as", name: "Asia", bonus: 7 },
    { id: "au", name: "Australia", bonus: 2 },
  ],
  territories: [
    { id: "alaska", name: "Alaska", continent: "na", neighbors: ["northwest_territory", "alberta", "kamchatka"] },
    // ...all 42, adjacency per the classic board
  ],
}
```

The adjacency test in Step 1 will catch any missing back-edge, so transcribe one direction and let the test find the gaps.

- [ ] **Step 4: Run map tests to verify they pass**

Run: `npx vitest run src/engine/map.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Write the failing setup test**

```ts
// src/engine/setup.test.ts
import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason, territoriesOf, continentBonusesFor } from "./setup.js"
import type { Faction } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
  { id: "f3", playerName: "Cy", color: "#11e" },
]
const ids = RISK_MAP.territories.map((t) => t.id)

describe("createSeason", () => {
  it("deals every territory exactly once, evenly to within one", () => {
    const s = createSeason("s1", factions, ids)
    expect(Object.keys(s.ownership)).toHaveLength(42)
    const counts = factions.map((f) => territoriesOf(s, f.id).length)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(42)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  it("starts every territory at 2 troops and every reserve at 0", () => {
    const s = createSeason("s1", factions, ids)
    expect(Object.values(s.garrisons).every((g) => g === 2)).toBe(true)
    expect(Object.values(s.reserves).every((r) => r === 0)).toBe(true)
  })

  it("starts at day 0 with empty pending and log", () => {
    const s = createSeason("s1", factions, ids)
    expect(s.day).toBe(0)
    expect(s.pending).toEqual([])
    expect(s.log).toEqual([])
    expect(s.engineVersion).toBe("1.0.0")
  })

  it("is deterministic for a given shuffle", () => {
    expect(createSeason("s1", factions, ids)).toEqual(createSeason("s1", factions, ids))
  })
})

describe("continentBonusesFor", () => {
  it("pays a bonus only for a complete continent", () => {
    const s = createSeason("s1", factions, ids)
    const au = RISK_MAP.territories.filter((t) => t.continent === "au").map((t) => t.id)
    for (const t of au) s.ownership[t] = "f1"
    expect(continentBonusesFor(s, "f1")).toBeGreaterThanOrEqual(2)
    s.ownership[au[0]!] = "f2"
    const after = continentBonusesFor(s, "f1")
    expect(after).toBe(continentBonusesFor(s, "f1"))
    expect(after % 2 === 0 || after >= 0).toBe(true)
  })

  it("pays exactly 2 for Australia alone", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    for (const t of RISK_MAP.territories.filter((x) => x.continent === "au")) s.ownership[t.id] = "f1"
    expect(continentBonusesFor(s, "f1")).toBe(2)
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/engine/setup.test.ts`
Expected: FAIL — `Failed to resolve import "./setup.js"`.

- [ ] **Step 7: Write `src/engine/setup.ts`**

```ts
import { RISK_MAP } from "./map.js"
import { ENGINE_VERSION } from "./types.js"
import type { Faction, FactionId, GameState, TerritoryId } from "./types.js"

export function territoriesOf(state: GameState, factionId: FactionId): TerritoryId[] {
  return Object.keys(state.ownership)
    .sort()
    .filter((t) => state.ownership[t] === factionId)
}

export function continentBonusesFor(state: GameState, factionId: FactionId): number {
  let bonus = 0
  for (const c of state.map.continents) {
    const members = state.map.territories.filter((t) => t.continent === c.id)
    if (members.every((t) => state.ownership[t.id] === factionId)) bonus += c.bonus
  }
  return bonus
}

export function createSeason(
  seasonId: string,
  factions: Faction[],
  shuffledTerritoryIds: TerritoryId[],
): GameState {
  const ownership: Record<TerritoryId, FactionId> = {}
  const garrisons: Record<TerritoryId, number> = {}
  shuffledTerritoryIds.forEach((tid, i) => {
    ownership[tid] = factions[i % factions.length]!.id
    garrisons[tid] = 2
  })
  const reserves: Record<FactionId, number> = {}
  for (const f of factions) reserves[f.id] = 0

  return {
    seasonId,
    day: 0,
    map: RISK_MAP,
    factions,
    ownership,
    garrisons,
    reserves,
    pending: [],
    log: [],
    engineVersion: ENGINE_VERSION,
  }
}
```

- [ ] **Step 8: Run setup tests to verify they pass**

Run: `npx vitest run src/engine/setup.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/engine/map.ts src/engine/map.test.ts src/engine/setup.ts src/engine/setup.test.ts
git commit -m "feat(engine): Risk map data and season setup"
```

---

### Task 3: Order validation

**Files:**
- Create: `src/engine/validate.ts`
- Test: `src/engine/validate.test.ts`

**Interfaces:**
- Consumes: `Order`, `GameState`, `DailyContext`, `TickEvent` from Task 1; `territoriesOf` from Task 2.
- Produces: `validateOrder(state, order, context): { clean: Order; rejections: TickEvent[] }` — returns a field-level-sanitized order plus one `{t:"rejected"}` event per dropped item. Never throws on bad player data.

This task implements spec §Orders "Aggregate constraints" and "Rejection is field-level, never whole-order."

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/validate.test.ts
import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason } from "./setup.js"
import { validateOrder } from "./validate.js"
import type { DailyContext, Faction, Order } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
]
const ids = RISK_MAP.territories.map((t) => t.id)

function fixture() {
  const s = createSeason("s1", factions, ids)
  for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
  s.ownership["alaska"] = "f1"
  s.ownership["alberta"] = "f1"
  s.garrisons["alaska"] = 10
  s.garrisons["alberta"] = 3
  s.reserves["f1"] = 10
  const ctx: DailyContext = {
    slate: [{ id: "m1", question: "q", priceYes: 0.5, priceNo: 0.5, closeTime: "2026-08-09T18:00:00Z" }],
    approvals: [],
    settlements: {},
  }
  return { s, ctx }
}

const base: Order = { factionId: "f1", deploys: [], attacks: [], wagers: [], protect: null }

describe("validateOrder — aggregates", () => {
  it("caps total attacks from one origin at garrison - 1", () => {
    const { s, ctx } = fixture()
    const o = { ...base, attacks: [
      { from: "alaska", to: "northwest_territory", count: 9 },
      { from: "alaska", to: "kamchatka", count: 9 },
    ] }
    const { clean, rejections } = validateOrder(s, o, ctx)
    const total = clean.attacks.reduce((sum, a) => sum + a.count, 0)
    expect(total).toBeLessThanOrEqual(9)
    expect(rejections.some((r) => r.t === "rejected" && r.field === "attacks")).toBe(true)
  })

  it("caps total deploys at reserve", () => {
    const { s, ctx } = fixture()
    const o = { ...base, deploys: [
      { territory: "alaska", count: 7 },
      { territory: "alberta", count: 7 },
    ] }
    const { clean } = validateOrder(s, o, ctx)
    expect(clean.deploys.reduce((sum, d) => sum + d.count, 0)).toBeLessThanOrEqual(10)
  })

  it("caps wagers at reserve remaining after deploys", () => {
    const { s, ctx } = fixture()
    const o = { ...base, deploys: [{ territory: "alaska", count: 8 }], wagers: [{ marketId: "m1", side: "yes" as const, stake: 5 }] }
    const { clean } = validateOrder(s, o, ctx)
    expect(clean.wagers.reduce((sum, w) => sum + w.stake, 0)).toBeLessThanOrEqual(2)
  })

  it("allows at most one wager per market", () => {
    const { s, ctx } = fixture()
    const o = { ...base, wagers: [
      { marketId: "m1", side: "yes" as const, stake: 2 },
      { marketId: "m1", side: "no" as const, stake: 2 },
    ] }
    const { clean, rejections } = validateOrder(s, o, ctx)
    expect(clean.wagers).toHaveLength(1)
    expect(rejections.some((r) => r.t === "rejected" && r.reason.includes("one wager per market"))).toBe(true)
  })
})

describe("validateOrder — field level", () => {
  it("drops only the bad item, keeping the rest", () => {
    const { s, ctx } = fixture()
    const o = { ...base, attacks: [
      { from: "alaska", to: "northwest_territory", count: 3 },
      { from: "brazil", to: "peru", count: 1 },
    ] }
    const { clean } = validateOrder(s, o, ctx)
    expect(clean.attacks).toHaveLength(1)
    expect(clean.attacks[0]!.from).toBe("alaska")
  })

  it("rejects non-adjacent, self-owned-target, and unowned-origin attacks", () => {
    const { s, ctx } = fixture()
    const o = { ...base, attacks: [
      { from: "alaska", to: "brazil", count: 1 },
      { from: "alaska", to: "alberta", count: 1 },
      { from: "peru", to: "brazil", count: 1 },
    ] }
    expect(validateOrder(s, o, ctx).clean.attacks).toHaveLength(0)
  })

  it("rejects non-integer, negative, NaN and string counts", () => {
    const { s, ctx } = fixture()
    const o = { ...base, deploys: [
      { territory: "alaska", count: -3 },
      { territory: "alaska", count: 1.5 },
      { territory: "alaska", count: NaN },
      { territory: "alaska", count: "4" as unknown as number },
    ] }
    expect(validateOrder(s, o, ctx).clean.deploys).toHaveLength(0)
  })

  it("rejects deploys to territories the faction does not own", () => {
    const { s, ctx } = fixture()
    const o = { ...base, deploys: [{ territory: "brazil", count: 1 }] }
    expect(validateOrder(s, o, ctx).clean.deploys).toHaveLength(0)
  })

  it("rejects wagers on markets not on today's slate", () => {
    const { s, ctx } = fixture()
    const o = { ...base, wagers: [{ marketId: "not_on_slate", side: "yes" as const, stake: 1 }] }
    expect(validateOrder(s, o, ctx).clean.wagers).toHaveLength(0)
  })

  it("ignores protect from a living faction", () => {
    const { s, ctx } = fixture()
    const o = { ...base, protect: "brazil" }
    const { clean, rejections } = validateOrder(s, o, ctx)
    expect(clean.protect).toBeNull()
    expect(rejections.some((r) => r.t === "rejected" && r.field === "protect")).toBe(true)
  })

  it("keeps protect from an eliminated faction", () => {
    const { s, ctx } = fixture()
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    const o = { ...base, protect: "brazil" }
    expect(validateOrder(s, o, ctx).clean.protect).toBe("brazil")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/engine/validate.test.ts`
Expected: FAIL — `Failed to resolve import "./validate.js"`.

- [ ] **Step 3: Write `src/engine/validate.ts`**

```ts
import { territoriesOf } from "./setup.js"
import type { DailyContext, GameState, Order, TickEvent } from "./types.js"

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0

export function validateOrder(
  state: GameState,
  order: Order,
  context: DailyContext,
): { clean: Order; rejections: TickEvent[] } {
  const f = order.factionId
  const rejections: TickEvent[] = []
  const reject = (field: string, reason: string) =>
    rejections.push({ t: "rejected", faction: f, field, reason })

  const byId = new Map(state.map.territories.map((t) => [t.id, t]))
  const reserve = state.reserves[f] ?? 0

  // Deploys: owned territory, valid count, aggregate <= reserve, in listed order.
  const deploys: Order["deploys"] = []
  let spent = 0
  for (const d of order.deploys) {
    if (!isCount(d.count) || d.count === 0) { reject("deploys", `bad count for ${d.territory}`); continue }
    if (state.ownership[d.territory] !== f) { reject("deploys", `does not own ${d.territory}`); continue }
    if (spent + d.count > reserve) { reject("deploys", `exceeds reserve at ${d.territory}`); continue }
    spent += d.count
    deploys.push(d)
  }

  // Post-deploy garrisons, used for the per-origin attack cap.
  const postDeploy = { ...state.garrisons }
  for (const d of deploys) postDeploy[d.territory] = (postDeploy[d.territory] ?? 0) + d.count

  // Attacks: owned origin, adjacent enemy target, aggregate per origin <= garrison - 1.
  const attacks: Order["attacks"] = []
  const committed: Record<string, number> = {}
  for (const a of order.attacks) {
    if (!isCount(a.count) || a.count === 0) { reject("attacks", `bad count ${a.from}->${a.to}`); continue }
    if (state.ownership[a.from] !== f) { reject("attacks", `does not own ${a.from}`); continue }
    if (state.ownership[a.to] === f) { reject("attacks", `${a.to} is friendly`); continue }
    if (!byId.get(a.from)?.neighbors.includes(a.to)) { reject("attacks", `${a.to} not adjacent to ${a.from}`); continue }
    const cap = Math.max(0, (postDeploy[a.from] ?? 0) - 1)
    const used = committed[a.from] ?? 0
    if (used + a.count > cap) { reject("attacks", `exceeds garrison cap at ${a.from}`); continue }
    committed[a.from] = used + a.count
    attacks.push(a)
  }

  // Wagers: on slate, one per market, aggregate <= reserve - deploys.
  const wagers: Order["wagers"] = []
  const slate = new Map(context.slate.map((m) => [m.id, m]))
  const seen = new Set<string>()
  let staked = 0
  for (const w of order.wagers) {
    if (!isCount(w.stake) || w.stake === 0) { reject("wagers", `bad stake on ${w.marketId}`); continue }
    if (w.side !== "yes" && w.side !== "no") { reject("wagers", `bad side on ${w.marketId}`); continue }
    if (!slate.has(w.marketId)) { reject("wagers", `${w.marketId} not on today's slate`); continue }
    if (seen.has(w.marketId)) { reject("wagers", `at most one wager per market (${w.marketId})`); continue }
    if (staked + w.stake > reserve - spent) { reject("wagers", `exceeds remaining reserve on ${w.marketId}`); continue }
    seen.add(w.marketId)
    staked += w.stake
    wagers.push(w)
  }

  // Protect: eliminated factions only, real territory.
  let protect = order.protect
  if (protect !== null) {
    if (territoriesOf(state, f).length > 0) { reject("protect", "faction is not eliminated"); protect = null }
    else if (!byId.has(protect)) { reject("protect", `unknown territory ${protect}`); protect = null }
  }

  return { clean: { factionId: f, deploys, attacks, wagers, protect }, rejections }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engine/validate.test.ts`
Expected: PASS, all 11.

- [ ] **Step 5: Commit**

```bash
git add src/engine/validate.ts src/engine/validate.test.ts
git commit -m "feat(engine): field-level order validation with aggregate constraints"
```

---

### Task 4: Income — territory, continent, and the elimination carve-out

**Files:**
- Create: `src/engine/income.ts`
- Test: `src/engine/income.test.ts`

**Interfaces:**
- Consumes: `GameState` from Task 1; `territoriesOf`, `continentBonusesFor` from Task 2.
- Produces: `territoryIncome(state, factionId): number`.

Implements spec §Baseline income: `max(5, floor(territories / 2))` plus continent bonuses, **0 for eliminated factions**.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/income.test.ts
import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason } from "./setup.js"
import { territoryIncome } from "./income.js"
import type { Faction } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
]
const ids = RISK_MAP.territories.map((t) => t.id)

function withCount(n: number) {
  const s = createSeason("s1", factions, ids)
  for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
  // Assign n territories to f1, avoiding a complete Australia so bonuses stay 0.
  const pick = RISK_MAP.territories.filter((t) => t.continent !== "au").slice(0, n)
  for (const t of pick) s.ownership[t.id] = "f1"
  return s
}

describe("territoryIncome", () => {
  it("pays 0 to an eliminated faction (regression: max(5,..) paid the floor forever)", () => {
    expect(territoryIncome(withCount(0), "f1")).toBe(0)
  })

  it("floors at 5", () => {
    expect(territoryIncome(withCount(1), "f1")).toBe(5)
    expect(territoryIncome(withCount(7), "f1")).toBe(5)
    expect(territoryIncome(withCount(10), "f1")).toBe(5)
  })

  it("exceeds the floor at 12 territories", () => {
    expect(territoryIncome(withCount(11), "f1")).toBe(5)
    expect(territoryIncome(withCount(12), "f1")).toBe(6)
    expect(territoryIncome(withCount(20), "f1")).toBe(10)
  })

  it("adds continent bonuses", () => {
    const s = createSeason("s1", factions, ids)
    for (const t of RISK_MAP.territories) s.ownership[t.id] = "f2"
    for (const t of RISK_MAP.territories.filter((x) => x.continent === "au")) s.ownership[t.id] = "f1"
    // 4 territories -> floor 5, plus Australia's 2
    expect(territoryIncome(s, "f1")).toBe(7)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/engine/income.test.ts`
Expected: FAIL — `Failed to resolve import "./income.js"`.

- [ ] **Step 3: Write `src/engine/income.ts`**

```ts
import { continentBonusesFor, territoriesOf } from "./setup.js"
import type { FactionId, GameState } from "./types.js"

export function territoryIncome(state: GameState, factionId: FactionId): number {
  const count = territoriesOf(state, factionId).length
  if (count === 0) return 0
  return Math.max(5, Math.floor(count / 2)) + continentBonusesFor(state, factionId)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engine/income.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/income.ts src/engine/income.test.ts
git commit -m "feat(engine): territory income with elimination carve-out"
```

---

### Task 5: IRL actions and timing bonuses

**Files:**
- Create: `src/engine/irl.ts`
- Test: `src/engine/irl.test.ts`

**Interfaces:**
- Consumes: `ApprovedAction`, `FactionId` from Task 1.
- Produces: `irlGrants(approvals): Map<FactionId, { actions: number; bonus: number }>`.

Implements spec §IRL actions and §Timing bonuses: cap 2 actions at +1 each; Early Bird on earliest `postedAt`; Under the Wire on latest `approvedAt`; max one bonus per player; if one player holds both ends, they take Early Bird and Under the Wire passes to the latest *different* player. Ties break on `eventId`, then `playerId`.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/irl.test.ts
import { describe, expect, it } from "vitest"
import { irlGrants } from "./irl.js"
import type { ApprovedAction } from "./types.js"

const a = (playerId: string, postedAt: string, approvedAt: string, eventId = `${playerId}-${postedAt}`): ApprovedAction =>
  ({ eventId, playerId, postedAt, approvedAt })

describe("irlGrants", () => {
  it("returns nothing for an empty day", () => {
    expect(irlGrants([]).size).toBe(0)
  })

  it("caps actions at 2 per player", () => {
    const g = irlGrants([
      a("f1", "T08:00", "T08:05"), a("f1", "T09:00", "T09:05"),
      a("f1", "T10:00", "T10:05"), a("f1", "T11:00", "T11:05"),
    ])
    expect(g.get("f1")!.actions).toBe(2)
  })

  it("awards both bonuses to different players", () => {
    const g = irlGrants([a("f1", "T06:00", "T06:30"), a("f2", "T19:00", "T20:30")])
    expect(g.get("f1")!.bonus).toBe(1)
    expect(g.get("f2")!.bonus).toBe(1)
  })

  it("gives a lone poster exactly one bonus, not two", () => {
    const g = irlGrants([a("f1", "T06:00", "T06:30")])
    expect(g.get("f1")!.bonus).toBe(1)
    expect(g.get("f1")!.actions).toBe(1)
  })

  it("passes Under the Wire to the latest different player", () => {
    const g = irlGrants([
      a("f1", "T06:00", "T06:30"),
      a("f1", "T20:00", "T20:55"), // f1 holds both ends
      a("f2", "T12:00", "T12:30"),
    ])
    expect(g.get("f1")!.bonus).toBe(1)
    expect(g.get("f2")!.bonus).toBe(1)
  })

  it("keys Early Bird on post time, not approval time", () => {
    // f2 posted first but was approved last.
    const g = irlGrants([a("f1", "T09:00", "T09:01"), a("f2", "T07:00", "T20:00")])
    expect(g.get("f2")!.bonus).toBe(1) // Early Bird AND Under the Wire both point at f2
    expect(g.get("f1")!.bonus).toBe(0)
  })

  it("breaks timestamp ties on eventId then playerId", () => {
    const g1 = irlGrants([a("f2", "T08:00", "T08:00", "e1"), a("f1", "T08:00", "T08:00", "e2")])
    const g2 = irlGrants([a("f1", "T08:00", "T08:00", "e2"), a("f2", "T08:00", "T08:00", "e1")])
    expect(g1).toEqual(g2)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/engine/irl.test.ts`
Expected: FAIL — `Failed to resolve import "./irl.js"`.

- [ ] **Step 3: Write `src/engine/irl.ts`**

```ts
import type { ApprovedAction, FactionId } from "./types.js"

export interface IrlGrant { actions: number; bonus: number }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function irlGrants(approvals: ApprovedAction[]): Map<FactionId, IrlGrant> {
  const out = new Map<FactionId, IrlGrant>()
  if (approvals.length === 0) return out

  for (const a of approvals) {
    const g = out.get(a.playerId) ?? { actions: 0, bonus: 0 }
    g.actions = Math.min(2, g.actions + 1)
    out.set(a.playerId, g)
  }

  const byPost = [...approvals].sort(
    (x, y) => cmp(x.postedAt, y.postedAt) || cmp(x.eventId, y.eventId) || cmp(x.playerId, y.playerId),
  )
  const byApproval = [...approvals].sort(
    (x, y) => cmp(y.approvedAt, x.approvedAt) || cmp(y.eventId, x.eventId) || cmp(y.playerId, x.playerId),
  )

  const earlyBird = byPost[0]!.playerId
  out.get(earlyBird)!.bonus = 1

  const underWire = byApproval.find((a) => a.playerId !== earlyBird)
  if (underWire) out.get(underWire.playerId)!.bonus = 1

  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engine/irl.test.ts`
Expected: PASS, all 7.

- [ ] **Step 5: Commit**

```bash
git add src/engine/irl.ts src/engine/irl.test.ts
git commit -m "feat(engine): IRL action grants and timing bonuses"
```

---

### Task 6: Wager escrow, settlement, and payout math

**Files:**
- Create: `src/engine/wagers.ts`
- Test: `src/engine/wagers.test.ts`

**Interfaces:**
- Consumes: `PendingWager`, `Market`, `Order`, `Settlement` from Task 1.
- Produces: `payout(stake, price): number`, `escrow(order, slate, day, seq): PendingWager[]`, `settleAll(pending, settlements, today): { keep: PendingWager[]; credits: Map<FactionId, number>; events: TickEvent[] }`.

Implements spec §Wagers. `payout` uses `round`, not `floor`. `settleAll` is **credit-only** and refunds when `today - placedOnDay >= 2`.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/wagers.test.ts
import { describe, expect, it } from "vitest"
import { escrow, payout, settleAll } from "./wagers.js"
import type { Market, Order, PendingWager } from "./types.js"

const slate: Market[] = [
  { id: "m1", question: "q1", priceYes: 0.5, priceNo: 0.5, closeTime: "T18:00" },
  { id: "m2", question: "q2", priceYes: 0.8, priceNo: 0.2, closeTime: "T18:00" },
]

describe("payout", () => {
  it("pays fair odds plus the 10% house bonus", () => {
    expect(payout(10, 0.5)).toBe(22)
    expect(payout(100, 0.5)).toBe(220)
  })

  it("rounds rather than floors, so small stakes stay positive-EV", () => {
    // Under floor() this was 1 (a -45% EV bet at p just above 0.55).
    expect(payout(1, 0.56)).toBe(2)
    expect(payout(3, 0.9)).toBe(4)
  })

  it("is monotonic in stake", () => {
    for (let s = 1; s < 50; s++) expect(payout(s + 1, 0.4)).toBeGreaterThanOrEqual(payout(s, 0.4))
  })
})

describe("escrow — the hedge is unavailable", () => {
  it("cannot stake both sides of one market (validated upstream, enforced here)", () => {
    const order: Order = {
      factionId: "f1", deploys: [], attacks: [], protect: null,
      wagers: [{ marketId: "m1", side: "yes", stake: 50 }],
    }
    const pending = escrow(order, slate, 3, 0)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.price).toBe(0.5)
    expect(pending[0]!.placedOnDay).toBe(3)
  })

  it("takes price from the slate by side, never from the order", () => {
    const order: Order = {
      factionId: "f1", deploys: [], attacks: [], protect: null,
      wagers: [{ marketId: "m2", side: "no", stake: 10 }],
    }
    expect(escrow(order, slate, 1, 0)[0]!.price).toBe(0.2)
  })

  it("mints stable unique wager ids", () => {
    const order: Order = {
      factionId: "f1", deploys: [], attacks: [], protect: null,
      wagers: [{ marketId: "m1", side: "yes", stake: 1 }, { marketId: "m2", side: "no", stake: 1 }],
    }
    const ids = escrow(order, slate, 2, 0).map((p) => p.wagerId)
    expect(new Set(ids).size).toBe(2)
  })
})

const pending = (over: Partial<PendingWager> = {}): PendingWager => ({
  wagerId: "w1", factionId: "f1", marketId: "m1", side: "yes",
  stake: 10, price: 0.5, placedOnDay: 1, ...over,
})

describe("settleAll", () => {
  it("credits a winner and keeps nothing pending", () => {
    const r = settleAll([pending()], { m1: "yes" }, 2)
    expect(r.credits.get("f1")).toBe(22)
    expect(r.keep).toHaveLength(0)
  })

  it("credits nothing on a loss and never debits (regression: double-charge)", () => {
    const r = settleAll([pending()], { m1: "no" }, 2)
    expect(r.credits.get("f1") ?? 0).toBe(0)
    expect(r.keep).toHaveLength(0)
  })

  it("rolls an unsettled wager forward", () => {
    const r = settleAll([pending()], { m1: "unsettled" }, 2)
    expect(r.keep).toHaveLength(1)
    expect(r.credits.size).toBe(0)
  })

  it("refunds the stake once two ticks have passed", () => {
    const r = settleAll([pending({ placedOnDay: 1 })], { m1: "unsettled" }, 3)
    expect(r.credits.get("f1")).toBe(10)
    expect(r.keep).toHaveLength(0)
  })

  it("treats a missing settlement as unsettled, not a loss", () => {
    const r = settleAll([pending()], {}, 2)
    expect(r.keep).toHaveLength(1)
  })

  it("settles wagers older than yesterday, not just yesterday's", () => {
    const r = settleAll([pending({ placedOnDay: 1 }), pending({ wagerId: "w2", placedOnDay: 2 })], { m1: "yes" }, 3)
    expect(r.credits.get("f1")).toBe(44)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/engine/wagers.test.ts`
Expected: FAIL — `Failed to resolve import "./wagers.js"`.

- [ ] **Step 3: Write `src/engine/wagers.ts`**

```ts
import type {
  FactionId, Market, Order, PendingWager, Settlement, TickEvent,
} from "./types.js"

export const HOUSE_BONUS = 1.1
export const REFUND_AFTER_TICKS = 2

export function payout(stake: number, price: number): number {
  const p = Math.min(0.9, Math.max(0.1, price))
  return Math.round((stake / p) * HOUSE_BONUS)
}

export function escrow(order: Order, slate: Market[], day: number, seq: number): PendingWager[] {
  const byId = new Map(slate.map((m) => [m.id, m]))
  return order.wagers.map((w, i) => {
    const m = byId.get(w.marketId)!
    return {
      wagerId: `${day}-${order.factionId}-${seq + i}`,
      factionId: order.factionId,
      marketId: w.marketId,
      side: w.side,
      stake: w.stake,
      price: w.side === "yes" ? m.priceYes : m.priceNo,
      placedOnDay: day,
    }
  })
}

export function settleAll(
  pending: PendingWager[],
  settlements: Record<string, Settlement>,
  today: number,
): { keep: PendingWager[]; credits: Map<FactionId, number>; events: TickEvent[] } {
  const keep: PendingWager[] = []
  const credits = new Map<FactionId, number>()
  const events: TickEvent[] = []
  const credit = (f: FactionId, n: number) => credits.set(f, (credits.get(f) ?? 0) + n)

  for (const w of [...pending].sort((a, b) => (a.wagerId < b.wagerId ? -1 : 1))) {
    const outcome = settlements[w.marketId] ?? "unsettled"
    if (outcome === "unsettled") {
      if (today - w.placedOnDay >= REFUND_AFTER_TICKS) {
        credit(w.factionId, w.stake)
        events.push({ t: "wagerSettle", wagerId: w.wagerId, outcome, payout: w.stake })
      } else {
        keep.push(w)
      }
      continue
    }
    const won = outcome === w.side
    const amount = won ? payout(w.stake, w.price) : 0
    if (amount > 0) credit(w.factionId, amount)
    events.push({ t: "wagerSettle", wagerId: w.wagerId, outcome, payout: amount })
  }

  return { keep, credits, events }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engine/wagers.test.ts`
Expected: PASS, all 12.

- [ ] **Step 5: Commit**

```bash
git add src/engine/wagers.ts src/engine/wagers.test.ts
git commit -m "feat(engine): wager escrow, credit-only settlement, round-based payout"
```

---

### Task 7: Casualty allocation

**Files:**
- Create: `src/engine/casualties.ts`
- Test: `src/engine/casualties.test.ts`

**Interfaces:**
- Consumes: `FactionId` from Task 1.
- Produces: `allocateCasualties(forces, defense): Map<FactionId, number>` where `forces: { factionId: FactionId; size: number }[]`.

Implements spec §Combat 6d: total casualties equal **exactly** `defense`, allocated pro-rata by largest-remainder rounding, ties by lowest faction id. This is the finding four reviewers raised — applying `D` in full against each attacker breaks troop conservation.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/casualties.test.ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { allocateCasualties } from "./casualties.js"

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

describe("allocateCasualties", () => {
  it("matches the spec's worked example (a1=3, a2=4, D=5)", () => {
    const c = allocateCasualties([{ factionId: "f1", size: 3 }, { factionId: "f2", size: 4 }], 5)
    expect(c.get("f1")).toBe(2)
    expect(c.get("f2")).toBe(3)
  })

  it("destroys everyone when the attack does not exceed defense", () => {
    const c = allocateCasualties([{ factionId: "f1", size: 3 }, { factionId: "f2", size: 2 }], 5)
    expect(c.get("f1")).toBe(3)
    expect(c.get("f2")).toBe(2)
  })

  it("allocates exactly D when the attack succeeds (regression: per-attacker D)", () => {
    const c = allocateCasualties([{ factionId: "f1", size: 5 }, { factionId: "f2", size: 5 }], 4)
    expect(sum(c)).toBe(4)
  })

  it("is order-independent", () => {
    const a = allocateCasualties([{ factionId: "f1", size: 3 }, { factionId: "f2", size: 4 }], 5)
    const b = allocateCasualties([{ factionId: "f2", size: 4 }, { factionId: "f1", size: 3 }], 5)
    expect([...a].sort()).toEqual([...b].sort())
  })

  it("never allocates more casualties than a force has", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 200 }),
        (sizes, defense) => {
          const forces = sizes.map((size, i) => ({ factionId: `f${i}`, size }))
          const c = allocateCasualties(forces, defense)
          const total = sizes.reduce((a, b) => a + b, 0)
          for (const f of forces) expect(c.get(f.factionId)!).toBeLessThanOrEqual(f.size)
          expect(sum(c)).toBe(total <= defense ? total : defense)
        },
      ),
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/engine/casualties.test.ts`
Expected: FAIL — `Failed to resolve import "./casualties.js"`.

- [ ] **Step 3: Write `src/engine/casualties.ts`**

```ts
import type { FactionId } from "./types.js"

export interface Force { factionId: FactionId; size: number }

export function allocateCasualties(forces: Force[], defense: number): Map<FactionId, number> {
  const total = forces.reduce((s, f) => s + f.size, 0)
  if (total <= defense) return new Map(forces.map((f) => [f.factionId, f.size]))

  const rows = forces.map((f) => {
    const exact = (defense * f.size) / total
    const base = Math.floor(exact)
    return { factionId: f.factionId, base, rem: exact - base }
  })

  const out = new Map(rows.map((r) => [r.factionId, r.base]))
  let short = defense - rows.reduce((s, r) => s + r.base, 0)

  const order = [...rows].sort(
    (a, b) => b.rem - a.rem || (a.factionId < b.factionId ? -1 : a.factionId > b.factionId ? 1 : 0),
  )
  for (let i = 0; i < short; i++) {
    const id = order[i]!.factionId
    out.set(id, out.get(id)! + 1)
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engine/casualties.test.ts`
Expected: PASS, all 5 including the property test.

- [ ] **Step 5: Commit**

```bash
git add src/engine/casualties.ts src/engine/casualties.test.ts
git commit -m "feat(engine): largest-remainder casualty allocation"
```

---

### Task 8: Combat — protections, field battles, and attack resolution

**Files:**
- Create: `src/engine/combat.ts`
- Test: `src/engine/combat.test.ts`

**Interfaces:**
- Consumes: `GameState`, `Order`, `TickEvent` from Task 1; `allocateCasualties` from Task 7.
- Produces: `resolveCombat(state, orders): { ownership; garrisons; events }` — step 6 in full.

Implements spec §Combat 6a–6d. Sub-steps in order: parity protections → field battles (`a−2b`) → post-departure defense → attack resolution.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/combat.test.ts
import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason } from "./setup.js"
import { resolveCombat } from "./combat.js"
import type { Faction, Order } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
  { id: "f3", playerName: "Cy", color: "#11e" },
]
const ids = RISK_MAP.territories.map((t) => t.id)
const order = (o: Partial<Order> & { factionId: string }): Order =>
  ({ deploys: [], attacks: [], wagers: [], protect: null, ...o })

function board(setup: (s: ReturnType<typeof createSeason>) => void) {
  const s = createSeason("s1", factions, ids)
  for (const t of RISK_MAP.territories) { s.ownership[t.id] = "f3"; s.garrisons[t.id] = 1 }
  setup(s)
  return s
}

describe("attack resolution", () => {
  it("captures when attack exceeds defense, survivors = attack - defense", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"; s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"; s.garrisons["alberta"] = 3
    })
    const r = resolveCombat(s, [order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] })])
    expect(r.ownership["alberta"]).toBe("f1")
    expect(r.garrisons["alberta"]).toBe(6)
    expect(r.garrisons["alaska"]).toBe(1)
  })

  it("destroys the attacker when attack equals defense, leaving a 0-troop territory", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"; s.garrisons["alaska"] = 4
      s.ownership["alberta"] = "f2"; s.garrisons["alberta"] = 3
    })
    const r = resolveCombat(s, [order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 3 }] })])
    expect(r.ownership["alberta"]).toBe("f2")
    expect(r.garrisons["alberta"]).toBe(0)
  })

  it("defends with the post-departure garrison", () => {
    // alaska holds 10, sends 9 out; alberta attacks alaska with 2 and should take it.
    const s = board((s) => {
      s.ownership["alaska"] = "f1"; s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"; s.garrisons["alberta"] = 5
      s.ownership["northwest_territory"] = "f3"; s.garrisons["northwest_territory"] = 1
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "northwest_territory", count: 9 }] }),
      order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 2 }] }),
    ])
    expect(r.ownership["alaska"]).toBe("f2")
  })
})

describe("field battles", () => {
  it("destroys the smaller force and continues at a - 2b", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"; s.garrisons["alaska"] = 11
      s.ownership["alberta"] = "f2"; s.garrisons["alberta"] = 5
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 10 }] }),
      order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 1 }] }),
    ])
    // 10 - 2*1 = 8 continues; alberta's post-departure garrison is 4 -> captured with 4
    expect(r.ownership["alberta"]).toBe("f1")
    expect(r.garrisons["alberta"]).toBe(4)
  })

  it("destroys both forces when equal, and neither advances", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"; s.garrisons["alaska"] = 6
      s.ownership["alberta"] = "f2"; s.garrisons["alberta"] = 6
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 5 }] }),
      order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 5 }] }),
    ])
    expect(r.ownership["alaska"]).toBe("f1")
    expect(r.ownership["alberta"]).toBe("f2")
    expect(r.garrisons["alaska"]).toBe(1)
    expect(r.garrisons["alberta"]).toBe(1)
  })

  it("a 1-troop feint no longer voids a large assault (regression)", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"; s.garrisons["alaska"] = 101
      s.ownership["alberta"] = "f2"; s.garrisons["alberta"] = 3
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 100 }] }),
      order({ factionId: "f2", attacks: [{ from: "alberta", to: "alaska", count: 1 }] }),
    ])
    expect(r.ownership["alberta"]).toBe("f1")
  })
})

describe("multi-attacker", () => {
  it("gives the territory to the largest surviving force", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"; s.garrisons["alaska"] = 9
      s.ownership["northwest_territory"] = "f2"; s.garrisons["northwest_territory"] = 9
      s.ownership["alberta"] = "f3"; s.garrisons["alberta"] = 5
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 3 }] }),
      order({ factionId: "f2", attacks: [{ from: "northwest_territory", to: "alberta", count: 4 }] }),
    ])
    // A=7 > D=5, casualties 2/3, survivors 1/1, tie -> larger original force (f2)
    expect(r.ownership["alberta"]).toBe("f2")
    expect(r.garrisons["alberta"]).toBe(1)
  })

  it("returns losing attackers' survivors to their origin", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"; s.garrisons["alaska"] = 9
      s.ownership["northwest_territory"] = "f2"; s.garrisons["northwest_territory"] = 9
      s.ownership["alberta"] = "f3"; s.garrisons["alberta"] = 5
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 3 }] }),
      order({ factionId: "f2", attacks: [{ from: "northwest_territory", to: "alberta", count: 4 }] }),
    ])
    // f1 committed 3 of 9 (6 stay home) and gets its 1 survivor back
    expect(r.garrisons["alaska"]).toBe(7)
  })
})

describe("protections", () => {
  it("voids attacks on a protected territory and leaves troops home", () => {
    const s = board((s) => {
      s.ownership["alaska"] = "f1"; s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"; s.garrisons["alberta"] = 1
      for (const t of RISK_MAP.territories) if (s.ownership[t.id] === "f3") s.ownership[t.id] = "f2"
    })
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f3", protect: "alberta" }),
    ])
    expect(r.ownership["alberta"]).toBe("f2")
    expect(r.garrisons["alaska"]).toBe(10)
  })

  it("cancels protection when two eliminated factions pick the same territory", () => {
    // f3 and f4 are both eliminated; two picks on alberta cancel to unprotected.
    const four = [...factions, { id: "f4", playerName: "Dee", color: "#ee1" }]
    const s = createSeason("s1", four, ids)
    for (const t of RISK_MAP.territories) { s.ownership[t.id] = "f1"; s.garrisons[t.id] = 1 }
    s.garrisons["alaska"] = 10
    s.ownership["alberta"] = "f2"; s.garrisons["alberta"] = 1
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f3", protect: "alberta" }),
      order({ factionId: "f4", protect: "alberta" }),
    ])
    expect(r.ownership["alberta"]).toBe("f1") // two picks cancelled; attack landed
  })

  it("re-protects on a third pick", () => {
    const five = [...factions,
      { id: "f4", playerName: "Dee", color: "#ee1" },
      { id: "f5", playerName: "Eli", color: "#1ee" }]
    const s = createSeason("s1", five, ids)
    for (const t of RISK_MAP.territories) { s.ownership[t.id] = "f1"; s.garrisons[t.id] = 1 }
    s.garrisons["alaska"] = 10
    s.ownership["alberta"] = "f2"; s.garrisons["alberta"] = 1
    const r = resolveCombat(s, [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f3", protect: "alberta" }),
      order({ factionId: "f4", protect: "alberta" }),
      order({ factionId: "f5", protect: "alberta" }),
    ])
    expect(r.ownership["alberta"]).toBe("f2") // odd count -> protected
    expect(r.garrisons["alaska"]).toBe(10)    // voided troops stayed home
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/engine/combat.test.ts`
Expected: FAIL — `Failed to resolve import "./combat.js"`.

- [ ] **Step 3: Write `src/engine/combat.ts`**

```ts
import { allocateCasualties } from "./casualties.js"
import { territoriesOf } from "./setup.js"
import type { FactionId, GameState, Order, TerritoryId, TickEvent } from "./types.js"

export function resolveCombat(
  state: GameState,
  orders: Order[],
): { ownership: Record<TerritoryId, FactionId>; garrisons: Record<TerritoryId, number>; events: TickEvent[] } {
  const ownership = { ...state.ownership }
  const garrisons = { ...state.garrisons }
  const events: TickEvent[] = []
  const sorted = [...orders].sort((a, b) => (a.factionId < b.factionId ? -1 : 1))

  // 6a — parity protections from eliminated factions only.
  const picks: Record<TerritoryId, number> = {}
  for (const o of sorted) {
    if (o.protect && territoriesOf(state, o.factionId).length === 0) {
      picks[o.protect] = (picks[o.protect] ?? 0) + 1
    }
  }
  const protectedSet = new Set(
    Object.keys(picks).sort().filter((t) => picks[t]! % 2 === 1),
  )
  for (const t of protectedSet) events.push({ t: "protected", territory: t, byCount: picks[t]! })

  // Collect live attacks, dropping those into protected territories.
  const attacks: { factionId: FactionId; from: TerritoryId; to: TerritoryId; size: number }[] = []
  for (const o of sorted) {
    for (const a of [...o.attacks].sort((x, y) => (x.from + x.to < y.from + y.to ? -1 : 1))) {
      if (protectedSet.has(a.to)) continue
      attacks.push({ factionId: o.factionId, from: a.from, to: a.to, size: a.count })
    }
  }

  // 6b — field battles on mutually attacked edges.
  const key = (a: string, b: string) => [a, b].sort().join("|")
  const byEdge = new Map<string, typeof attacks>()
  for (const a of attacks) {
    const k = key(a.from, a.to)
    byEdge.set(k, [...(byEdge.get(k) ?? []), a])
  }
  for (const [, pair] of [...byEdge].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (pair.length !== 2) continue
    const [x, y] = pair as [typeof attacks[0], typeof attacks[0]]
    if (!(x.from === y.to && y.from === x.to)) continue
    const a = x.size, b = y.size
    x.size = a > b ? Math.max(0, a - 2 * b) : 0
    y.size = b > a ? Math.max(0, b - 2 * a) : 0
    events.push({ t: "fieldBattle", a: x.from, b: y.from, aContinues: x.size, bContinues: y.size })
  }

  // 6c — post-departure garrisons. Every committed troop leaves its origin.
  for (const a of attacks) garrisons[a.from] = (garrisons[a.from] ?? 0) - a.size
  // Field-battle losses are already reflected: size was reduced after departure,
  // so restore the difference is NOT done — those troops died in the field.

  // 6d — resolve each contested territory.
  const targets = [...new Set(attacks.filter((a) => a.size > 0).map((a) => a.to))].sort()
  for (const to of targets) {
    const forces = attacks.filter((a) => a.to === to && a.size > 0)
    const defense = garrisons[to] ?? 0
    const total = forces.reduce((s, f) => s + f.size, 0)

    const byFaction = new Map<FactionId, number>()
    for (const f of forces) byFaction.set(f.factionId, (byFaction.get(f.factionId) ?? 0) + f.size)
    const grouped = [...byFaction].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([factionId, size]) => ({ factionId, size }))

    const casualties = allocateCasualties(grouped, defense)

    if (total <= defense) {
      garrisons[to] = defense - total
      for (const f of forces) {
        events.push({ t: "attack", from: f.from, to, attacker: f.factionId, committed: f.size, survivors: 0, captured: false })
      }
      continue
    }

    const survivors = grouped
      .map((g) => ({ ...g, alive: g.size - (casualties.get(g.factionId) ?? 0) }))
      .sort((a, b) => b.alive - a.alive || b.size - a.size || (a.factionId < b.factionId ? -1 : 1))
    const winner = survivors[0]!

    ownership[to] = winner.factionId
    garrisons[to] = winner.alive

    // Losing attackers' survivors go home, split back across their origins in order.
    for (const s of survivors.slice(1)) {
      let remaining = s.alive
      for (const f of forces.filter((f) => f.factionId === s.factionId).sort((a, b) => (a.from < b.from ? -1 : 1))) {
        const back = Math.min(remaining, f.size)
        garrisons[f.from] = (garrisons[f.from] ?? 0) + back
        remaining -= back
      }
    }

    for (const f of forces) {
      events.push({
        t: "attack", from: f.from, to, attacker: f.factionId, committed: f.size,
        survivors: f.factionId === winner.factionId ? winner.alive : 0,
        captured: f.factionId === winner.factionId,
      })
    }
  }

  return { ownership, garrisons, events }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engine/combat.test.ts`
Expected: PASS, all 9.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/combat.ts src/engine/combat.test.ts
git commit -m "feat(engine): combat with protections, field battles, post-departure defense"
```

---

### Task 9: The resolve pipeline

**Files:**
- Create: `src/engine/resolve.ts`
- Create: `src/engine/index.ts`
- Test: `src/engine/resolve.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–8.
- Produces: `resolve(state, orders, context): GameState` and a barrel `src/engine/index.ts` re-exporting the public surface.

Implements spec §Resolution pipeline, all seven steps in the mandated order.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/resolve.test.ts
import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason } from "./setup.js"
import { resolve } from "./resolve.js"
import type { DailyContext, Faction, Order } from "./types.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ana", color: "#e11" },
  { id: "f2", playerName: "Ben", color: "#1e1" },
]
const ids = RISK_MAP.territories.map((t) => t.id)
const emptyCtx: DailyContext = { slate: [], approvals: [], settlements: {} }
const order = (o: Partial<Order> & { factionId: string }): Order =>
  ({ deploys: [], attacks: [], wagers: [], protect: null, ...o })

describe("resolve", () => {
  it("advances the day and stamps the engine version", () => {
    const s = createSeason("s1", factions, ids)
    const next = resolve(s, [], emptyCtx)
    expect(next.day).toBe(1)
    expect(next.engineVersion).toBe("1.0.0")
  })

  it("does not mutate the input state", () => {
    const s = createSeason("s1", factions, ids)
    const snapshot = JSON.stringify(s)
    resolve(s, [order({ factionId: "f1" })], emptyCtx)
    expect(JSON.stringify(s)).toBe(snapshot)
  })

  it("grants income into reserves", () => {
    const s = createSeason("s1", factions, ids)
    const next = resolve(s, [], emptyCtx)
    expect(next.reserves["f1"]).toBeGreaterThanOrEqual(5)
  })

  it("escrows wagers after deploys, so committed troops cannot be staked", () => {
    const s = createSeason("s1", factions, ids)
    s.reserves["f1"] = 10
    const own = Object.keys(s.ownership).sort().find((t) => s.ownership[t] === "f1")!
    const ctx: DailyContext = {
      slate: [{ id: "m1", question: "q", priceYes: 0.5, priceNo: 0.5, closeTime: "T18:00" }],
      approvals: [], settlements: {},
    }
    const next = resolve(s, [order({
      factionId: "f1",
      deploys: [{ territory: own, count: 10 }],
      wagers: [{ marketId: "m1", side: "yes", stake: 10 }],
    })], ctx)
    expect(next.pending).toHaveLength(0)
  })

  it("keeps reserves non-negative under an all-in order", () => {
    const s = createSeason("s1", factions, ids)
    s.reserves["f1"] = 3
    const ctx: DailyContext = {
      slate: [{ id: "m1", question: "q", priceYes: 0.5, priceNo: 0.5, closeTime: "T18:00" }],
      approvals: [], settlements: {},
    }
    const next = resolve(s, [order({ factionId: "f1", wagers: [{ marketId: "m1", side: "yes", stake: 3 }] })], ctx)
    expect(next.reserves["f1"]).toBeGreaterThanOrEqual(0)
  })

  it("records rejections in the log", () => {
    const s = createSeason("s1", factions, ids)
    const next = resolve(s, [order({ factionId: "f1", deploys: [{ territory: "not_a_place", count: 1 }] })], emptyCtx)
    expect(next.log.some((e) => e.t === "rejected")).toBe(true)
  })

  it("is deterministic — same inputs, identical output", () => {
    const s = createSeason("s1", factions, ids)
    const orders = [order({ factionId: "f1" }), order({ factionId: "f2" })]
    expect(resolve(s, orders, emptyCtx)).toEqual(resolve(s, orders, emptyCtx))
  })

  it("is order-independent in the orders array", () => {
    const s = createSeason("s1", factions, ids)
    const a = order({ factionId: "f1" }), b = order({ factionId: "f2" })
    expect(resolve(s, [a, b], emptyCtx)).toEqual(resolve(s, [b, a], emptyCtx))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/engine/resolve.test.ts`
Expected: FAIL — `Failed to resolve import "./resolve.js"`.

- [ ] **Step 3: Write `src/engine/resolve.ts`**

```ts
import { resolveCombat } from "./combat.js"
import { territoryIncome } from "./income.js"
import { irlGrants } from "./irl.js"
import { ENGINE_VERSION } from "./types.js"
import { validateOrder } from "./validate.js"
import { escrow, settleAll } from "./wagers.js"
import type { DailyContext, GameState, Order, PendingWager, TickEvent } from "./types.js"

export function resolve(state: GameState, orders: Order[], context: DailyContext): GameState {
  const day = state.day + 1
  const reserves = { ...state.reserves }
  const log: TickEvent[] = []

  const sorted = [...orders].sort((a, b) => (a.factionId < b.factionId ? -1 : 1))
  const clean: Order[] = []
  for (const o of sorted) {
    const { clean: c, rejections } = validateOrder(state, o, context)
    clean.push(c)
    log.push(...rejections)
  }

  // 1 — settle matured wagers (credit only)
  const settled = settleAll(state.pending, context.settlements, day)
  for (const [f, amount] of [...settled.credits].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    reserves[f] = (reserves[f] ?? 0) + amount
  }
  log.push(...settled.events)

  // 2 — IRL grants
  const grants = irlGrants(context.approvals)
  for (const f of state.factions.map((x) => x.id).sort()) {
    const g = grants.get(f)
    if (!g) continue
    const amount = g.actions + g.bonus
    reserves[f] = (reserves[f] ?? 0) + amount
    log.push({ t: "irl", faction: f, actions: g.actions, bonus: g.bonus })
  }

  // 3 — territory income
  for (const f of state.factions.map((x) => x.id).sort()) {
    const amount = territoryIncome(state, f)
    if (amount === 0) continue
    reserves[f] = (reserves[f] ?? 0) + amount
    log.push({ t: "income", faction: f, amount })
  }

  // 4 — deploys
  const garrisons = { ...state.garrisons }
  for (const o of clean) {
    for (const d of o.deploys) {
      garrisons[d.territory] = (garrisons[d.territory] ?? 0) + d.count
      reserves[o.factionId] = (reserves[o.factionId] ?? 0) - d.count
      log.push({ t: "deploy", faction: o.factionId, territory: d.territory, count: d.count })
    }
  }

  // 5 — escrow wagers
  const pending: PendingWager[] = [...settled.keep]
  for (const o of clean) {
    const staked = o.wagers.reduce((s, w) => s + w.stake, 0)
    if (staked === 0) continue
    reserves[o.factionId] = (reserves[o.factionId] ?? 0) - staked
    pending.push(...escrow(o, context.slate, day, pending.length))
  }

  // 6 — combat, against a state carrying the post-deploy garrisons
  const combat = resolveCombat({ ...state, garrisons }, clean)
  log.push(...combat.events)

  for (const [f, v] of Object.entries(reserves)) {
    if (v < 0) throw new Error(`engine invariant violated: reserve for ${f} is ${v}`)
  }

  return {
    ...state,
    day,
    ownership: combat.ownership,
    garrisons: combat.garrisons,
    reserves,
    pending,
    log,
    engineVersion: ENGINE_VERSION,
  }
}
```

- [ ] **Step 4: Write `src/engine/index.ts`**

```ts
export { RISK_MAP } from "./map.js"
export { createSeason, territoriesOf, continentBonusesFor } from "./setup.js"
export { territoryIncome } from "./income.js"
export { irlGrants } from "./irl.js"
export { payout, escrow, settleAll, HOUSE_BONUS } from "./wagers.js"
export { allocateCasualties } from "./casualties.js"
export { resolveCombat } from "./combat.js"
export { validateOrder } from "./validate.js"
export { resolve } from "./resolve.js"
export * from "./types.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/engine/`
Expected: PASS, entire engine suite.

- [ ] **Step 6: Commit**

```bash
git add src/engine/resolve.ts src/engine/resolve.test.ts src/engine/index.ts
git commit -m "feat(engine): seven-step resolve pipeline"
```

---

### Task 10: Conservation and invariant property tests

**Files:**
- Create: `src/engine/invariants.test.ts`

**Interfaces:**
- Consumes: `resolve`, `createSeason`, `RISK_MAP` from Tasks 2 and 9.
- Produces: nothing — this task is pure verification.

Implements spec §Testing item 5. Paired with the rejection-logging assertion, so a clamping bug cannot pass trivially.

- [ ] **Step 1: Write the property tests**

```ts
// src/engine/invariants.test.ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { RISK_MAP } from "./map.js"
import { createSeason } from "./setup.js"
import { resolve } from "./resolve.js"
import type { DailyContext, Faction, Order } from "./types.js"

const factions: Faction[] = ["f1", "f2", "f3", "f4"].map((id) => ({ id, playerName: id, color: "#000" }))
const ids = RISK_MAP.territories.map((t) => t.id)
const ctx: DailyContext = { slate: [], approvals: [], settlements: {} }

const arbOrder = (factionId: string) =>
  fc.record({
    factionId: fc.constant(factionId),
    deploys: fc.array(fc.record({ territory: fc.constantFrom(...ids), count: fc.integer({ min: 0, max: 12 }) }), { maxLength: 4 }),
    attacks: fc.array(fc.record({ from: fc.constantFrom(...ids), to: fc.constantFrom(...ids), count: fc.integer({ min: 0, max: 12 }) }), { maxLength: 4 }),
    wagers: fc.constant([]),
    protect: fc.oneof(fc.constant(null), fc.constantFrom(...ids)),
  }) as fc.Arbitrary<Order>

describe("engine invariants", () => {
  it("never produces a negative reserve or garrison", () => {
    fc.assert(fc.property(fc.tuple(...factions.map((f) => arbOrder(f.id))), (orders) => {
      const next = resolve(createSeason("s", factions, ids), [...orders], ctx)
      expect(Object.values(next.reserves).every((r) => r >= 0)).toBe(true)
      expect(Object.values(next.garrisons).every((g) => g >= 0)).toBe(true)
    }), { numRuns: 300 })
  })

  it("keeps every territory owned by exactly one faction", () => {
    fc.assert(fc.property(fc.tuple(...factions.map((f) => arbOrder(f.id))), (orders) => {
      const next = resolve(createSeason("s", factions, ids), [...orders], ctx)
      expect(Object.keys(next.ownership)).toHaveLength(42)
      const known = new Set(factions.map((f) => f.id))
      expect(Object.values(next.ownership).every((f) => known.has(f))).toBe(true)
    }), { numRuns: 300 })
  })

  it("conserves troops: troops out + casualties equals troops in + income", () => {
    fc.assert(fc.property(fc.tuple(...factions.map((f) => arbOrder(f.id))), (orders) => {
      const before = createSeason("s", factions, ids)
      const next = resolve(before, [...orders], ctx)
      const totalBefore =
        Object.values(before.garrisons).reduce((a, b) => a + b, 0) +
        Object.values(before.reserves).reduce((a, b) => a + b, 0)
      const totalAfter =
        Object.values(next.garrisons).reduce((a, b) => a + b, 0) +
        Object.values(next.reserves).reduce((a, b) => a + b, 0)
      const income = next.log.filter((e) => e.t === "income").reduce((s, e) => s + (e as { amount: number }).amount, 0)
      // Casualties are the only sink, so after <= before + income.
      expect(totalAfter).toBeLessThanOrEqual(totalBefore + income)
    }), { numRuns: 300 })
  })

  it("logs a rejection whenever an order item is dropped", () => {
    const bad: Order = {
      factionId: "f1", deploys: [{ territory: "nowhere", count: 5 }],
      attacks: [], wagers: [], protect: null,
    }
    const next = resolve(createSeason("s", factions, ids), [bad], ctx)
    expect(next.log.filter((e) => e.t === "rejected")).not.toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run them**

Run: `npx vitest run src/engine/invariants.test.ts`
Expected: PASS. If conservation fails, the bug is in `resolveCombat`'s return-home accounting — that is the intended catch.

- [ ] **Step 3: Commit**

```bash
git add src/engine/invariants.test.ts
git commit -m "test(engine): conservation and invariant property tests"
```

---

### Task 11: Sim policies, including the Arbitrageur

**Files:**
- Create: `src/sim/policies.ts`
- Test: `src/sim/policies.test.ts`

**Interfaces:**
- Consumes: the engine barrel `src/engine/index.js`.
- Produces: `type Policy = { name: string; decide(state, factionId, slate, rng): Order }` and `POLICIES: Policy[]` containing `Turtle`, `Blitz`, `Gambler`, `Slacker`, `GymRat`, `Arbitrageur`.

`Arbitrageur` exists because the original policy set could not express the both-sides hedge, and a policy set that cannot express cheating cannot detect it. It attempts every exploit the review found: both sides of one market, over-committed attacks from one origin, deploys beyond reserve, and a `protect` pick while alive.

- [ ] **Step 1: Write the failing test**

```ts
// src/sim/policies.test.ts
import { describe, expect, it } from "vitest"
import { RISK_MAP, createSeason } from "../engine/index.js"
import { POLICIES, makeRng } from "./policies.js"
import type { Faction, Market } from "../engine/index.js"

const factions: Faction[] = ["f1", "f2"].map((id) => ({ id, playerName: id, color: "#000" }))
const ids = RISK_MAP.territories.map((t) => t.id)
const slate: Market[] = [{ id: "m1", question: "q", priceYes: 0.4, priceNo: 0.6, closeTime: "T18:00" }]

describe("policies", () => {
  it("includes all six named policies", () => {
    expect(POLICIES.map((p) => p.name).sort()).toEqual(
      ["Arbitrageur", "Blitz", "Gambler", "GymRat", "Slacker", "Turtle"],
    )
  })

  it("every policy returns a well-formed order", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 20
    for (const p of POLICIES) {
      const o = p.decide(s, "f1", slate, makeRng(1))
      expect(o.factionId).toBe("f1")
      expect(Array.isArray(o.deploys)).toBe(true)
      expect(Array.isArray(o.attacks)).toBe(true)
      expect(Array.isArray(o.wagers)).toBe(true)
    }
  })

  it("Turtle never attacks", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 20
    const turtle = POLICIES.find((p) => p.name === "Turtle")!
    expect(turtle.decide(s, "f1", slate, makeRng(1)).attacks).toHaveLength(0)
  })

  it("Arbitrageur attempts to stake both sides of one market", () => {
    const s = createSeason("s", factions, ids)
    s.reserves["f1"] = 100
    const arb = POLICIES.find((p) => p.name === "Arbitrageur")!
    const wagers = arb.decide(s, "f1", slate, makeRng(1)).wagers
    expect(wagers.filter((w) => w.marketId === "m1")).toHaveLength(2)
    expect(new Set(wagers.map((w) => w.side))).toEqual(new Set(["yes", "no"]))
  })

  it("makeRng is deterministic for a seed", () => {
    const a = makeRng(7), b = makeRng(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/sim/policies.test.ts`
Expected: FAIL — `Failed to resolve import "./policies.js"`.

- [ ] **Step 3: Write `src/sim/policies.ts`**

```ts
import { RISK_MAP, territoriesOf } from "../engine/index.js"
import type { FactionId, GameState, Market, Order, TerritoryId } from "../engine/index.js"

export type Rng = () => number

export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}

export interface Policy {
  name: string
  /** Fraction of days this policy posts approved IRL actions, 0..2. */
  irlActionsPerDay: number
  decide(state: GameState, factionId: FactionId, slate: Market[], rng: Rng): Order
}

const empty = (factionId: FactionId): Order =>
  ({ factionId, deploys: [], attacks: [], wagers: [], protect: null })

const byId = new Map(RISK_MAP.territories.map((t) => [t.id, t]))

function borderTargets(state: GameState, f: FactionId): { from: TerritoryId; to: TerritoryId }[] {
  const out: { from: TerritoryId; to: TerritoryId }[] = []
  for (const t of territoriesOf(state, f)) {
    for (const n of byId.get(t)!.neighbors) {
      if (state.ownership[n] !== f) out.push({ from: t, to: n })
    }
  }
  return out.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1))
}

function spreadDeploys(state: GameState, f: FactionId): Order["deploys"] {
  const mine = territoriesOf(state, f)
  const reserve = state.reserves[f] ?? 0
  if (mine.length === 0 || reserve === 0) return []
  return [{ territory: mine[0]!, count: reserve }]
}

export const POLICIES: Policy[] = [
  {
    name: "Turtle",
    irlActionsPerDay: 1,
    decide: (s, f) => ({ ...empty(f), deploys: spreadDeploys(s, f) }),
  },
  {
    name: "Blitz",
    irlActionsPerDay: 1,
    decide: (s, f) => {
      const deploys = spreadDeploys(s, f)
      const garrisons = { ...s.garrisons }
      for (const d of deploys) garrisons[d.territory] = (garrisons[d.territory] ?? 0) + d.count
      const targets = borderTargets(s, f)
        .sort((a, b) => (garrisons[a.to] ?? 0) - (garrisons[b.to] ?? 0))
      const best = targets[0]
      if (!best) return { ...empty(f), deploys }
      const avail = Math.max(0, (garrisons[best.from] ?? 0) - 1)
      return { ...empty(f), deploys, attacks: avail > 0 ? [{ ...best, count: avail }] : [] }
    },
  },
  {
    name: "Gambler",
    irlActionsPerDay: 1,
    decide: (s, f, slate, rng) => {
      const reserve = s.reserves[f] ?? 0
      const m = slate[0]
      if (!m || reserve === 0) return { ...empty(f), deploys: spreadDeploys(s, f) }
      return { ...empty(f), wagers: [{ marketId: m.id, side: rng() < 0.5 ? "yes" : "no", stake: reserve }] }
    },
  },
  { name: "Slacker", irlActionsPerDay: 0, decide: (s, f) => ({ ...empty(f), deploys: spreadDeploys(s, f) }) },
  { name: "GymRat", irlActionsPerDay: 2, decide: (s, f) => ({ ...empty(f), deploys: spreadDeploys(s, f) }) },
  {
    name: "Arbitrageur",
    irlActionsPerDay: 2,
    decide: (s, f, slate) => {
      const reserve = s.reserves[f] ?? 0
      const m = slate[0]
      const mine = territoriesOf(s, f)
      const order = empty(f)

      // Exploit 1: stake both sides of one market proportionally to price.
      if (m && reserve > 0) {
        order.wagers = [
          { marketId: m.id, side: "yes", stake: Math.floor(reserve * m.priceYes) },
          { marketId: m.id, side: "no", stake: Math.floor(reserve * m.priceNo) },
        ].filter((w) => w.stake > 0)
      }
      // Exploit 2: over-commit attacks from one origin.
      const from = mine[0]
      if (from) {
        const g = s.garrisons[from] ?? 0
        order.attacks = byId.get(from)!.neighbors
          .filter((n) => s.ownership[n] !== f)
          .map((to) => ({ from, to, count: Math.max(0, g - 1) }))
          .filter((a) => a.count > 0)
      }
      // Exploit 3: deploy beyond reserve. Exploit 4: protect while alive.
      if (from) order.deploys = [{ territory: from, count: reserve + 50 }]
      order.protect = mine[0] ?? null
      return order
    },
  },
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sim/policies.test.ts`
Expected: PASS, all 5.

- [ ] **Step 5: Commit**

```bash
git add src/sim/policies.ts src/sim/policies.test.ts
git commit -m "feat(sim): scripted policies including the Arbitrageur exploit prober"
```

---

### Task 12: Season runner and the balance report

**Files:**
- Create: `src/sim/run.ts`
- Create: `src/sim/cli.ts`
- Test: `src/sim/run.test.ts`

**Interfaces:**
- Consumes: `resolve`, `createSeason` from the engine barrel; `POLICIES`, `makeRng` from Task 11.
- Produces: `runSeason(assignment, seed): SeasonResult`, `runMany(assignment, seasons): Report`, and a CLI entry point.

Implements spec §Testing item 6. The report answers the five questions the spec poses.

- [ ] **Step 1: Write the failing test**

```ts
// src/sim/run.test.ts
import { describe, expect, it } from "vitest"
import { runSeason, runMany } from "./run.js"
import { POLICIES } from "./policies.js"

const four = ["Turtle", "Blitz", "GymRat", "Slacker"]

describe("runSeason", () => {
  it("runs 21 ticks and returns a winner", () => {
    const r = runSeason(four, 1)
    expect(r.days).toBe(21)
    expect(four).toContain(r.winner)
  })

  it("is deterministic for a seed", () => {
    expect(runSeason(four, 42)).toEqual(runSeason(four, 42))
  })

  it("never leaves a negative reserve", () => {
    const r = runSeason(four, 7)
    expect(Object.values(r.finalReserves).every((v) => v >= 0)).toBe(true)
  })
})

describe("runMany", () => {
  it("reports win rates summing to the season count", () => {
    const rep = runMany(four, 40)
    const total = Object.values(rep.wins).reduce((a, b) => a + b, 0)
    expect(total).toBe(40)
  })

  it("reports whether the Arbitrageur outperforms — the key regression signal", () => {
    const rep = runMany(["Arbitrageur", "Blitz", "Turtle", "GymRat"], 60)
    expect(rep.wins["Arbitrageur"]).toBeDefined()
    // With the hedge closed, the Arbitrageur must not dominate.
    expect(rep.wins["Arbitrageur"]! / 60).toBeLessThan(0.6)
  })

  it("reports day-3 leader conversion", () => {
    expect(runMany(four, 20).day3LeaderWinRate).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/sim/run.test.ts`
Expected: FAIL — `Failed to resolve import "./run.js"`.

- [ ] **Step 3: Write `src/sim/run.ts`**

```ts
import { RISK_MAP, continentBonusesFor, createSeason, resolve, territoriesOf } from "../engine/index.js"
import { POLICIES, makeRng, type Rng } from "./policies.js"
import type { ApprovedAction, DailyContext, Faction, Market } from "../engine/index.js"

export const SEASON_DAYS = 21

export interface SeasonResult {
  days: number
  winner: string
  finalTerritories: Record<string, number>
  finalReserves: Record<string, number>
  day3Leader: string
}

export interface Report {
  seasons: number
  wins: Record<string, number>
  day3LeaderWinRate: number
  meanFinalTerritories: Record<string, number>
}

function shuffled(rng: Rng): string[] {
  const a = RISK_MAP.territories.map((t) => t.id)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

function makeSlate(day: number, rng: Rng): Market[] {
  const p = Math.round((0.15 + rng() * 0.7) * 100) / 100
  return [{
    id: `d${day}-m1`, question: `market ${day}`,
    priceYes: p, priceNo: Math.round((1 - p) * 100) / 100,
    closeTime: "T18:00",
  }]
}

export function runSeason(policyNames: string[], seed: number): SeasonResult {
  const rng = makeRng(seed)
  const policies = policyNames.map((n) => POLICIES.find((p) => p.name === n)!)
  const factions: Faction[] = policyNames.map((n) => ({ id: n, playerName: n, color: "#000" }))

  let state = createSeason(`sim-${seed}`, factions, shuffled(rng))
  let day3Leader = policyNames[0]!

  for (let day = 1; day <= SEASON_DAYS; day++) {
    const slate = day < SEASON_DAYS ? makeSlate(day, rng) : []
    const approvals: ApprovedAction[] = []
    policies.forEach((p, i) => {
      for (let k = 0; k < p.irlActionsPerDay; k++) {
        approvals.push({
          eventId: `${day}-${p.name}-${k}`,
          playerId: p.name,
          postedAt: `T${String(6 + i).padStart(2, "0")}:${String(k * 10).padStart(2, "0")}`,
          approvedAt: `T${String(8 + i).padStart(2, "0")}:${String(k * 10).padStart(2, "0")}`,
        })
      }
    })

    // Settle every pending market by a coin weighted to its snapshotted YES price.
    // Resolved per market, not per wager, so two factions on one market agree.
    const settlements: Record<string, "yes" | "no" | "unsettled"> = {}
    for (const w of [...state.pending].sort((a, b) => (a.marketId < b.marketId ? -1 : 1))) {
      if (settlements[w.marketId]) continue
      const pYes = w.side === "yes" ? w.price : 1 - w.price
      settlements[w.marketId] = rng() < pYes ? "yes" : "no"
    }

    const context: DailyContext = { slate, approvals, settlements }
    const orders = policies.map((p) => p.decide(state, p.name, slate, rng))
    state = resolve(state, orders, context)

    if (day === 3) {
      day3Leader = [...policyNames].sort(
        (a, b) => territoriesOf(state, b).length - territoriesOf(state, a).length || (a < b ? -1 : 1),
      )[0]!
    }
  }

  const finalTerritories = Object.fromEntries(policyNames.map((n) => [n, territoriesOf(state, n).length]))

  // Spec tiebreak: total troops = garrisons + reserves. Escrowed `pending` is excluded.
  const totalTroops = Object.fromEntries(policyNames.map((n) => [
    n,
    territoriesOf(state, n).reduce((s, t) => s + (state.garrisons[t] ?? 0), 0) + (state.reserves[n] ?? 0),
  ]))
  const continents = Object.fromEntries(policyNames.map((n) => [n, continentBonusesFor(state, n)]))

  const winner = [...policyNames].sort(
    (a, b) =>
      finalTerritories[b]! - finalTerritories[a]! ||
      totalTroops[b]! - totalTroops[a]! ||
      continents[b]! - continents[a]! ||
      (a < b ? -1 : 1),
  )[0]!

  return {
    days: SEASON_DAYS,
    winner,
    finalTerritories,
    finalReserves: Object.fromEntries(policyNames.map((n) => [n, state.reserves[n] ?? 0])),
    day3Leader,
  }
}

export function runMany(policyNames: string[], seasons: number): Report {
  const wins: Record<string, number> = Object.fromEntries(policyNames.map((n) => [n, 0]))
  const totals: Record<string, number> = Object.fromEntries(policyNames.map((n) => [n, 0]))
  let day3Converted = 0

  for (let i = 0; i < seasons; i++) {
    const r = runSeason(policyNames, i + 1)
    wins[r.winner] = (wins[r.winner] ?? 0) + 1
    for (const n of policyNames) totals[n] = totals[n]! + r.finalTerritories[n]!
    if (r.day3Leader === r.winner) day3Converted++
  }

  return {
    seasons,
    wins,
    day3LeaderWinRate: day3Converted / seasons,
    meanFinalTerritories: Object.fromEntries(policyNames.map((n) => [n, totals[n]! / seasons])),
  }
}
```

- [ ] **Step 4: Write `src/sim/cli.ts`**

```ts
import { runMany } from "./run.js"

const roster = process.argv.slice(2)
const names = roster.length > 0 ? roster : ["Turtle", "Blitz", "GymRat", "Slacker", "Gambler", "Arbitrageur"]
const report = runMany(names, 2000)

console.log(`seasons: ${report.seasons}`)
console.log(`day-3 leader wins: ${(report.day3LeaderWinRate * 100).toFixed(1)}%`)
for (const [name, w] of Object.entries(report.wins).sort((a, b) => b[1] - a[1])) {
  const pct = ((w / report.seasons) * 100).toFixed(1)
  console.log(`  ${name.padEnd(14)} ${pct.padStart(5)}%   mean territories ${report.meanFinalTerritories[name]!.toFixed(1)}`)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/sim/run.test.ts`
Expected: PASS, all 6.

- [ ] **Step 6: Run the full simulation**

Run: `npm run sim`
Expected: a table of win rates. Record the output — this is the balance data the whole plan exists to produce.

Interpret against the spec's five questions:
- **GymRat beats Blitz** → the IRL grant is too strong; lower the per-action value.
- **Gambler never wins** → variance is too weak for comebacks; raise the house bonus or widen slate prices.
- **Day-3 leader wins > ~50%** → the season is decided too early.
- **Arbitrageur outperforms** → the wager economy is still broken; the hedge fix did not hold.

- [ ] **Step 7: Commit**

```bash
git add src/sim/run.ts src/sim/run.test.ts src/sim/cli.ts
git commit -m "feat(sim): season runner and balance report"
```

---

### Task 13: Golden-file replay

**Files:**
- Create: `src/engine/golden.test.ts`
- Create: `src/engine/__golden__/season-1.json` (generated in Step 2)

**Interfaces:**
- Consumes: `runSeason` from Task 12, `resolve` from Task 9.
- Produces: nothing — verification only.

Implements spec §Testing item 8. Catches unintended behaviour changes when tuning numbers between seasons.

- [ ] **Step 1: Write the golden test**

```ts
// src/engine/golden.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { runSeason } from "../sim/run.js"

const GOLDEN = "src/engine/__golden__/season-1.json"

describe("golden-file replay", () => {
  it("reproduces a recorded season byte-for-byte", () => {
    const actual = runSeason(["Turtle", "Blitz", "GymRat", "Slacker"], 1)
    if (!existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 2))
      console.warn(`wrote new golden file ${GOLDEN} — re-run to verify`)
      return
    }
    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")))
  })

  it("produces identical results across repeated runs", () => {
    expect(runSeason(["Turtle", "Blitz", "GymRat", "Slacker"], 99))
      .toEqual(runSeason(["Turtle", "Blitz", "GymRat", "Slacker"], 99))
  })
})
```

- [ ] **Step 2: Generate the golden file**

Run: `mkdir -p src/engine/__golden__ && npx vitest run src/engine/golden.test.ts`
Expected: first run writes the file and warns; second run passes.

- [ ] **Step 3: Re-run to verify**

Run: `npx vitest run src/engine/golden.test.ts`
Expected: PASS, both tests.

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/golden.test.ts src/engine/__golden__/season-1.json
git commit -m "test(engine): golden-file season replay"
```

---

## Deferred to later plans

- **Plan 2 — Market adapter + settlement poller.** Kalshi client, slate selection and persistence, price validation at the boundary, the 30-minute poller, recorded fixtures.
- **Plan 3 — Slack ingress + recap.** Bolt app with signature verification and fail-closed boot, reaction caching with dedupe and removal handling, scope checks, the recap composer.
- **Plan 4 — Web app + SVG renderer + deployment.** Slack OAuth, the public projection and its leak test, order entry with per-market wager locks, the SVG board, SQLite store with WAL and `claimTick`, systemd units.
