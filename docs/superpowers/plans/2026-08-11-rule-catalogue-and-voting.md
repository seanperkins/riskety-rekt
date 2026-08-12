# Rule Catalogue and Voting: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the second half of
`docs/superpowers/specs/2026-08-10-pluggable-mechanics-design.md` (Status: Reviewed,
unanimous APPROVED 2026-08-11): the `Rule` interface with `needs`, the three traced
rules (*Boom*, *Attrition*, *Truce*), `rule_offers`/`rule_reactions` with the Slack
vote branch, the freeze of `ctx.rules`, and the per-rule bounded-swing balance gate.

**Architecture:** A rule is a `Mechanic` with a one-day lifetime and display fields,
dispatched through the hooks the module-system core already ships. New surface: a
seeded daily offer posted to Slack (claim-then-post, like recaps), numeral-emoji
votes stored raw in `rule_reactions`, a tally derived at the 21:00 tick and frozen
into `ctx.rules`. The engine change is one line of dispatch — rules join `active`.

**Tech Stack:** TypeScript via tsx (no build), vitest + fast-check, `node:sqlite`.

## Global Constraints

- `src/engine/` is pure: no I/O, no clock, no `Math.random`, no `Date.now()`, no `new Date(` — enforced by `src/engine/types.test.ts`, which already recurses into engine subdirectories, so `src/engine/rules/` is covered the moment it exists.
- Input state is never mutated; every hook is a pure function of its arguments.
- Never edit a shipped migration in `src/store/schema.ts`; append. Seven ship today (indices 0–6); the new one is appended (index 7 at time of writing — go by "append", not the number).
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on: expect `!`/`?? 0` at lookups; pass optional fields by spreading a conditional object, never explicit `undefined`.
- `node:sqlite` loads via `createRequire`; rows come back with a null prototype — spread them.
- Exit codes: 0 success or deliberate skip; 1 system failure; 2 operator mistake / rejected write.
- Jobs take `now: Date` as a dependency. Never `process.exit()` with the store open.
- Only `src/slack/app.ts` imports Bolt and only `src/slack/post.ts` imports `@slack/web-api`; everything else in `src/slack/` stays pure. Block Kit types are structural, never imported.
- Slack-side timestamps are stored through `slackTsToIso` and compared ISO-to-ISO, never against database write time.
- The golden file does **not** regenerate in this plan: `ctx.rules` defaults to `[]`, no `TickEvent` variant changes, and rules-off behavior is byte-identical. If the golden test goes red, something is wrong — stop and diagnose.
- Commit after every green test cycle; `npm test` and `npm run typecheck` must pass at every commit.

## Plan decisions (recorded per repo convention; each is a delta the spec left open)

1. **The offer is posted by a new 08:05 job, `publish-rules`,** for the current
   calendar day, range `1..lengthDays` inclusive (rules apply to that night's tick,
   so the final day IS offered — unlike the slate, whose wagers settle a tick
   later). A late-day run still posts; votes placed after `tickInstant` never
   count, so the worst case is a wasted message. Judge it by an 08:05 run.
2. **The draw offers every eligible rule** (needs-filtered), capped at 9 (the
   numeral-emoji alphabet), ordered by seeded shuffle. The seed is deterministic
   and auditable: `((season.seed ?? 0) ^ (day * 0x9e3779b9)) >>> 0`, stored as a
   string in `rule_offers.seed`.
3. **`Poster.post` returns the posted message's `ts`** (`Promise<string |
   undefined>`); claim-then-post needs it to record `message_ts`. Existing callers
   ignore the return value; test fakes update their return type.
4. **At most one rule wins per day.** `ctx.rules` stays `string[]` (the frozen
   record is a list by design); the tally produces `[]` or `[winner]`.
5. **A same-faction, same-instant numeral tie breaks on the lower ordinal** —
   Slack event timestamps have sub-second precision so this is near-unreachable,
   but the tally must be deterministic for replay.
6. **The vote-dynamics sim arm votes uniformly at random** (each seat abstains
   with probability ½, else picks a uniform offer). No `Policy` interface change —
   a per-policy voting strategy is machinery with no consumer yet; the review doc
   states the model. Forced-rule arms are the gate; the dynamics arm is context.
7. **The recap learns the day's rule from `tick_context`**, not from state:
   `RecapInput` gains optional `ruleIds`, and the CLI's `postRecapFor` reads
   `loadTickContext(...)?.context.rules`. Display fields come from
   `RULE_REGISTRY`; an id the registry no longer knows renders as the bare id
   (frozen history outliving a catalogue edit must not crash the recap).
8. **Catalogue validation runs at module load** (`rules/index.ts` calls
   `buildCatalogue` at import), so an unknown `needs`, a duplicate id, or a
   module-id collision refuses every process that imports the engine — which is
   the spec's "refuses at catalogue load".
9. **`RULE_DESCRIPTION_MAX_CHARS = 100` lives in `src/engine/rules/index.ts`** —
   the engine cannot import `src/config.ts`, and the cap is a catalogue-load
   check on in-tree constants (the render sinks still `safeText` everything).

---

### Task 1: The `Rule` contract and rule registry validation

**Files:**
- Modify: `src/engine/mechanics.ts` (add `RuleId`, `Rule`)
- Modify: `src/engine/registry.ts` (add `validateRules`)
- Test: `src/engine/registry.test.ts` (extend)

**Interfaces:**
- Consumes: `Mechanic`, `ModuleId` from `./mechanics.js` (shipped).
- Produces (later tasks rely on these exact names):
  - `type RuleId = string` (mechanics.ts)
  - `interface Rule extends Mechanic { id: RuleId; name: string; description: string; needs?: ModuleId[] }` (mechanics.ts)
  - `validateRules(enabled: string[], registry: Map<string, Rule>): Rule[]` (registry.ts) — returns enabled rules **sorted by id**; throws on unknown id, duplicate id, and `advance` without `escrowed`. No veto→irl check (that edge is module-only).

- [ ] **Step 1: Write the failing tests** — append to `src/engine/registry.test.ts`:

```ts
import { validateRules } from "./registry.js"
import type { Rule } from "./mechanics.js"

const rule = (id: string, extra: Partial<Rule> = {}): Rule => ({
  id, name: id, description: `the ${id} rule`, ...extra,
})
const ruleReg = (...rs: Rule[]) => new Map(rs.map((r) => [r.id, r]))

describe("validateRules", () => {
  it("returns enabled rules sorted by id", () => {
    const reg = ruleReg(rule("truce"), rule("boom"), rule("attrition"))
    expect(validateRules(["truce", "boom"], reg).map((r) => r.id)).toEqual(["boom", "truce"])
  })
  it("refuses an unknown id — a module id in ctx.rules is unknown to the rule registry", () => {
    expect(() => validateRules(["markets"], ruleReg(rule("boom")))).toThrow(/unknown rule/)
  })
  it("refuses a duplicate id", () => {
    expect(() => validateRules(["boom", "boom"], ruleReg(rule("boom")))).toThrow(/duplicate/)
  })
  it("refuses advance without escrowed", () => {
    const bad = ruleReg(rule("stateful", { advance: () => ({}) }))
    expect(() => validateRules(["stateful"], bad)).toThrow(/escrowed/)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -- src/engine/registry.test.ts` → FAIL (`validateRules` not exported).

- [ ] **Step 3: Implement.** In `src/engine/mechanics.ts`, after the `Mechanic` interface:

```ts
export type RuleId = string

/**
 * A rule is a mechanic with a one-day lifetime, display fields for the vote
 * and the recap, and a narrow offer filter. `needs` is a DISPLAY-side filter —
 * the daily draw skips rules whose modules are off, so the vote can never
 * select a rule the engine would refuse — not a dependency system.
 */
export interface Rule extends Mechanic {
  id: RuleId
  /** Shown in the vote offer and the recap. */
  name: string
  /** One line; every render sink caps and escapes it itself. */
  description: string
  /** Modules this rule's OFFER requires. Checked at catalogue load. */
  needs?: ModuleId[]
}
```

In `src/engine/registry.ts`:

```ts
import type { Mechanic, Rule } from "./mechanics.js"

/**
 * The rules half of the per-namespace check: every id the vote system can
 * select must be a registered RULE. A module id lands here as "unknown rule",
 * exactly as a rule id in season.modules lands in validateModules as
 * "unknown module" — the two registries are separate maps on purpose.
 */
export function validateRules(enabled: string[], registry: Map<string, Rule>): Rule[] {
  const seen = new Set<string>()
  for (const id of enabled) {
    if (seen.has(id)) throw new Error(`duplicate rule id: ${id}`)
    seen.add(id)
    if (!registry.has(id)) throw new Error(`unknown rule id: ${id}`)
  }
  const out = enabled.map((id) => registry.get(id)!).sort((a, b) => cmp(a.id, b.id))
  for (const x of out) {
    if (x.advance && !x.escrowed) {
      throw new Error(
        `${x.id} implements advance but not escrowed — the conservation invariant cannot see its soldiers`,
      )
    }
  }
  return out
}
```

- [ ] **Step 4: Run** — `npm test -- src/engine/registry.test.ts` → PASS; `npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(engine): the Rule contract and per-namespace rule validation"`

---

### Task 2: The three rules and the catalogue

**Files:**
- Create: `src/engine/rules/boom.ts`, `src/engine/rules/attrition.ts`, `src/engine/rules/truce.ts`, `src/engine/rules/index.ts`
- Test: `src/engine/rules/rules.test.ts`

**Interfaces:**
- Consumes: `Rule` (Task 1); `territoryIncome` from `../income.js`.
- Produces:
  - `boomRule: Rule`, `attritionRule: Rule`, `truceRule: Rule`
  - `RULE_CATALOGUE: readonly Rule[]` (id-sorted, the closed season-one catalogue)
  - `RULE_REGISTRY: Map<string, Rule>` (built through `buildCatalogue`, which throws at import on a bad catalogue)
  - `buildCatalogue(rules: readonly Rule[], moduleIds: ReadonlySet<string>): Map<string, Rule>`
  - `RULE_DESCRIPTION_MAX_CHARS = 100`
  - `eligibleRules(modules: readonly string[]): Rule[]` — the `needs` offer filter, used by the offer job and tested here.

The purity scan (`src/engine/types.test.ts`) already walks subdirectories and
resolves relative specifiers — no scan change is needed; the new files just have
to obey it (`../income.js`-style imports only).

- [ ] **Step 1: Write the failing tests**

```ts
// src/engine/rules/rules.test.ts
import { describe, expect, it } from "vitest"
import { createSeason, resolve, RISK_MAP } from "../index.js"
import { territoryIncome } from "../income.js"
import {
  RULE_CATALOGUE, RULE_REGISTRY, buildCatalogue, eligibleRules,
} from "./index.js"
import { boomRule } from "./boom.js"
import { truceRule } from "./truce.js"
import { attritionRule } from "./attrition.js"
import type { Rule } from "../mechanics.js"
import type { DailyContext, GameState } from "../types.js"

const ctx = (over: Partial<DailyContext> = {}): DailyContext => ({
  slate: [], approvals: [], postedToday: [], settlements: {},
  tickInstant: "2026-09-01T21:00:00.000Z", modules: [], rules: [], ...over,
})

// A tiny dealt board: use createSeason exactly as other engine tests do.
const dealt = (): GameState =>
  createSeason("s", [
    { id: "f1", playerName: "A", color: "#000" },
    { id: "f2", playerName: "B", color: "#000" },
  ], RISK_MAP.territories.map((t) => t.id), RISK_MAP)

describe("boom", () => {
  it("grants exactly core income again, per faction, logged as a boom grant", () => {
    const s = dealt()
    const grants = boomRule.grant!(s, ctx())
    for (const g of grants) {
      expect(g.amount).toBe(territoryIncome(s, g.faction))
      expect(g.event).toEqual({ t: "grant", source: "boom", faction: g.faction, amount: g.amount })
    }
    expect(grants.length).toBeGreaterThan(0)
  })
  it("skips zero-income (eliminated) factions rather than logging +0", () => {
    const s = dealt()
    const wiped: GameState = {
      ...s,
      ownership: Object.fromEntries(Object.keys(s.ownership).map((t) => [t, "f1"])),
    }
    expect(boomRule.grant!(wiped, ctx()).some((g) => g.faction === "f2")).toBe(false)
  })
})

describe("truce", () => {
  it("locks every territory and supplies no events", () => {
    const s = dealt()
    const locks = truceRule.lock!(s, [], ctx())
    expect(locks.map((l) => l.territory).sort()).toEqual(
      s.map.territories.map((t) => t.id).sort(),
    )
    expect(locks.every((l) => l.event === undefined)).toBe(true)
  })
})

describe("attrition", () => {
  it("returns the flat departure-cost dial", () => {
    expect(attritionRule.combatDials!(dealt(), ctx())).toEqual({ attackDepartureCost: 1 })
  })
})

describe("the catalogue", () => {
  it("ships at least three rules, each with display fields", () => {
    expect(RULE_CATALOGUE.length).toBeGreaterThanOrEqual(3)
    for (const r of RULE_CATALOGUE) {
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.description.length).toBeGreaterThan(0)
      expect(RULE_REGISTRY.get(r.id)).toBe(r)
    }
  })
  it("buildCatalogue refuses a duplicate id, a module-id collision, and an unknown needs", () => {
    const mods = new Set(["markets", "irl", "veto"])
    const r = (id: string, extra: Partial<Rule> = {}): Rule =>
      ({ id, name: id, description: "d", ...extra })
    expect(() => buildCatalogue([r("x"), r("x")], mods)).toThrow(/duplicate/)
    expect(() => buildCatalogue([r("markets")], mods)).toThrow(/collides/)
    expect(() => buildCatalogue([r("x", { needs: ["ghost"] })], mods)).toThrow(/needs/)
  })
  it("buildCatalogue refuses an over-long description", () => {
    const mods = new Set<string>()
    const long: Rule = { id: "x", name: "x", description: "d".repeat(101) }
    expect(() => buildCatalogue([long], mods)).toThrow(/description/)
  })
  it("eligibleRules filters by needs against the enabled modules", () => {
    // Season-one rules have no needs, so the filter needs a synthetic rule to
    // be falsifiable — same reasoning as the synthetic tie-break mechanic.
    const needy: Rule = { id: "zz-needy", name: "N", description: "d", needs: ["markets"] }
    const cat = buildCatalogue([...RULE_CATALOGUE, needy], new Set(["markets", "irl", "veto"]))
    expect(cat.has("zz-needy")).toBe(true)
    expect(eligibleRules(["irl"], cat).map((r) => r.id)).not.toContain("zz-needy")
    expect(eligibleRules(["markets"], cat).map((r) => r.id)).toContain("zz-needy")
  })
})
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```ts
// src/engine/rules/boom.ts
import { territoryIncome } from "../income.js"
import type { Rule } from "../mechanics.js"

/**
 * Income doubled today: recompute core territory income from state (pure) and
 * grant it again. Logged as {t:"grant", source:"boom"} so the recap reads it
 * as the rule that caused it, not as ordinary income. Zero-income factions
 * are skipped, mirroring core income's own `amount === 0` skip.
 */
export const boomRule: Rule = {
  id: "boom",
  name: "Boom",
  description: "Territory income is doubled today.",
  grant(state) {
    return state.factions
      .map((f) => f.id)
      .sort()
      .flatMap((faction) => {
        const amount = territoryIncome(state, faction)
        if (amount === 0) return []
        return [{ faction, amount, event: { t: "grant" as const, source: "boom", faction, amount } }]
      })
  },
}
```

```ts
// src/engine/rules/attrition.ts
import type { Rule } from "../mechanics.js"

/** Attacks cost one extra troop per movement at departure — the one flat dial. */
export const attritionRule: Rule = {
  id: "attrition",
  name: "Attrition",
  description: "Attacks cost one extra troop today.",
  combatDials() {
    return { attackDepartureCost: 1 }
  },
}
```

```ts
// src/engine/rules/truce.ts
import type { Rule } from "../mechanics.js"

/**
 * No attacks land today. Locks gate attacks only — moves and deploys still
 * run, and the description says "attacks" so the recap never promises that
 * nothing moved. Deliberately NO per-territory events: a whole-map lock would
 * bury the log under ~264 protected lines; the recap names the rule itself.
 */
export const truceRule: Rule = {
  id: "truce",
  name: "Truce",
  description: "No attacks land today. Moves and deploys still run.",
  lock(state) {
    return state.map.territories.map((t) => ({ territory: t.id }))
  },
}
```

```ts
// src/engine/rules/index.ts
import { cmp } from "../sort.js"
import { MODULE_REGISTRY } from "../modules/index.js"
import { attritionRule } from "./attrition.js"
import { boomRule } from "./boom.js"
import { truceRule } from "./truce.js"
import type { Rule } from "../mechanics.js"

export { attritionRule, boomRule, truceRule }

/** Engine-local: src/engine cannot import src/config, and this is a load-time
 *  check on in-tree constants. Render sinks still cap and escape themselves. */
export const RULE_DESCRIPTION_MAX_CHARS = 100

/**
 * Validate the closed catalogue: unique ids, no collision with any module id
 * (the per-namespace claim), display fields present and bounded, every
 * `needs` entry a registered module. Throws at import — an unknown needs
 * refuses at catalogue load rather than silently filtering the rule out of
 * every offer forever.
 */
export function buildCatalogue(
  rules: readonly Rule[],
  moduleIds: ReadonlySet<string>,
): Map<string, Rule> {
  const out = new Map<string, Rule>()
  for (const r of rules) {
    if (out.has(r.id)) throw new Error(`duplicate rule id: ${r.id}`)
    if (moduleIds.has(r.id)) throw new Error(`rule id ${r.id} collides with a module id`)
    if (r.name.length === 0) throw new Error(`rule ${r.id} has an empty name`)
    if (r.description.length === 0 || r.description.length > RULE_DESCRIPTION_MAX_CHARS) {
      throw new Error(`rule ${r.id} description must be 1..${RULE_DESCRIPTION_MAX_CHARS} chars`)
    }
    for (const m of r.needs ?? []) {
      if (!moduleIds.has(m)) throw new Error(`rule ${r.id} needs unknown module ${m}`)
    }
    out.set(r.id, r)
  }
  return out
}

/** The daily draw's offer filter: a rule is offered only when every module it
 *  needs is enabled. Display-side — the engine never checks `needs`. */
export function eligibleRules(
  modules: readonly string[],
  catalogue: ReadonlyMap<string, Rule> = RULE_REGISTRY,
): Rule[] {
  const on = new Set(modules)
  return [...catalogue.values()]
    .filter((r) => (r.needs ?? []).every((m) => on.has(m)))
    .sort((a, b) => cmp(a.id, b.id))
}

export const RULE_CATALOGUE: readonly Rule[] = [attritionRule, boomRule, truceRule]

export const RULE_REGISTRY: Map<string, Rule> = buildCatalogue(
  RULE_CATALOGUE,
  new Set(MODULE_REGISTRY.keys()),
)
```

- [ ] **Step 4: Run** — `npm test -- src/engine` → PASS (the purity scan now covers `rules/` automatically); `npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(engine): the season-one rule catalogue — Boom, Attrition, Truce"`

---

### Task 3: Dispatch `ctx.rules` through the pipeline

**Files:**
- Modify: `src/engine/resolve.ts` (the `active` line, `src/engine/resolve.ts:50`)
- Modify: `src/engine/index.ts` (re-export the rules surface if the barrel doesn't already)
- Test: `src/engine/resolve.test.ts` (extend)

**Interfaces:**
- Consumes: `validateRules` (Task 1), `RULE_REGISTRY` (Task 2).
- Produces: `resolve` now honors `context.rules`. No signature change. Barrel exports later tasks import from `../engine/rules/index.js` directly (matching how jobs import `../engine/modules/index.js`), so the barrel change is optional — add `export { RULE_CATALOGUE, RULE_REGISTRY, eligibleRules } from "./rules/index.js"` only if an import cycle check passes; otherwise skip it and import from the subpath.

- [ ] **Step 1: Write the failing tests** — append to `src/engine/resolve.test.ts`, reusing that file's existing state/context helpers (adapt names to what the file defines):

```ts
describe("rule dispatch", () => {
  it("boom doubles each faction's income", () => {
    // Same state, two resolves: baseline vs rules: ["boom"], no orders.
    // For every faction: reserveWith - reserveWithout === territoryIncome(state, f).
    // And the log contains {t:"grant", source:"boom"} entries.
  })
  it("truce voids every attack but moves still run", () => {
    // An attack order and a move order under rules: ["truce"]:
    // the attack logs {t:"rejected", reason:"protected"} and captures nothing;
    // the move's `move` event is present and garrisons reflect it.
  })
  it("attrition charges the departure fee through the rules path", () => {
    // Garrison 3, cost 1 (the review panel's worked case): X→Y 1 fits (consumes 2),
    // X→Z 1 rejected; origin ends at 1; the attack event carries fee: 1.
  })
  it("rule order in ctx.rules does not change output", () => {
    // resolve(s, o, {...ctx, rules: ["truce","boom"]}) deep-equals
    // resolve(s, o, {...ctx, rules: ["boom","truce"]}).
  })
  it("refuses an unknown rule id, and a module id in ctx.rules", () => {
    expect(() => resolve(s, [], { ...c, rules: ["ghost"] })).toThrow(/unknown rule/)
    expect(() => resolve(s, [], { ...c, rules: ["markets"] })).toThrow(/unknown rule/)
  })
  it("a frozen rule replays identically — day-5 semantics come from ctx alone", () => {
    // resolve twice with rules: ["boom"] on the same inputs → deep-equal outputs.
  })
})
```

Write each body concretely against the file's existing fixtures (small maps with
two factions are already in use there — follow the local pattern).

- [ ] **Step 2: Run to verify failure** (unknown-rule cases fail because `resolve` ignores `context.rules` today; behavior cases fail on missing grants/locks).

- [ ] **Step 3: Implement** — in `src/engine/resolve.ts`, replace the `active` line:

```ts
import { RULE_REGISTRY } from "./rules/index.js"
import { validateModules, validateRules } from "./registry.js"
// ...
  // Modules are season-scoped, rules day-scoped; both are validated per
  // namespace (separate registries) and dispatched identically. The merged
  // list is id-sorted so within every hook, mechanics run in one
  // deterministic order regardless of how the context lists them.
  const active = [
    ...validateModules(context.modules, MODULE_REGISTRY),
    ...validateRules(context.rules, RULE_REGISTRY),
  ].sort((a, b) => cmp(a.id, b.id))
```

Nothing else in the pipeline changes — grants, locks, dials and (unused by
season-one rules) spend/validate/advance already iterate `active`.

- [ ] **Step 4: Run the full engine suite** — `npm test -- src/engine` → PASS, including golden (rules default `[]`, so the golden season is untouched). `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(engine): ctx.rules dispatches through the mechanic hooks"`

---

### Task 4: Storage — `rule_offers`, `rule_reactions`, and the vote store

**Files:**
- Modify: `src/store/schema.ts` (APPEND one migration — never edit indices 0–6)
- Modify: `src/store/types.ts` (add `RuleVoteStore`, join it into the composed store type)
- Modify: `src/store/sqlite.ts` (implement the methods)
- Test: `src/store/rule-votes.test.ts` (create; follow the setup pattern of the existing store tests — temp-file db via `openStore`, closed in `afterEach`)

**Interfaces:**
- Consumes: `RULE_REGISTRY` from `../engine/rules/index.js` (a value import of pure engine code — the same relationship the store already has with engine types).
- Produces (exact signatures, in `src/store/types.ts`):

```ts
export interface RuleOfferRow {
  ruleId: string
  ordinal: number
  seed: string
  messageTs: string | null   // NULL = claimed, not yet posted (claim-then-post)
}

export interface RuleReactionRow {
  factionId: FactionId
  ordinal: number
  reactedAt: string          // ISO, via slackTsToIso at write
}

export interface RuleVoteStore {
  /** Claim the day's draw before posting. Throws on a rule id the catalogue
   *  does not know — a payload must never be able to name a rule. */
  claimRuleOffers(seasonId: string, day: number, ruleIds: string[], seed: string): void
  ruleOffersFor(seasonId: string, day: number): RuleOfferRow[]
  /** Record the posted Slack ts on every one of the day's offer rows. */
  recordOfferMessage(seasonId: string, day: number, messageTs: string): void
  /** The ingest's offer-message gate: which day does this ts vote on? */
  offerForMessage(messageTs: string): { seasonId: string; day: number; ordinals: number[] } | undefined
  /** Raw vote record: upsert, latest Slack timestamp wins on re-add. */
  recordRuleReaction(r: { seasonId: string; day: number; factionId: FactionId; ordinal: number; reactedAt: string }): void
  removeRuleReaction(seasonId: string, day: number, factionId: FactionId, ordinal: number): void
  ruleReactionsFor(seasonId: string, day: number): RuleReactionRow[]
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/store/rule-votes.test.ts — assertions, written concretely against openStore:
// - claimRuleOffers inserts rows ordinal 1..n with message_ts NULL and the seed;
//   ruleOffersFor returns them in ordinal order.
// - claimRuleOffers with an unknown rule id THROWS and writes nothing
//   (spec test 9's security claim, its own test).
// - recordOfferMessage stamps every row; offerForMessage maps the ts to
//   {seasonId, day, ordinals}; an unknown ts returns undefined.
// - recordRuleReaction stores reacted_at through slackTsToIso (pass a raw
//   Slack ts like "1756758000.000100"; read back an ISO instant);
//   re-adding the same (faction, ordinal) REWRITES reacted_at (latest wins —
//   the upsert, opposite of reactions' INSERT OR IGNORE, and the reason this
//   table exists apart from `reactions`).
// - removeRuleReaction deletes exactly one row; ruleReactionsFor returns the rest.
// - migration: open a store, close, reopen — migrate is idempotent and the new
//   tables survive (the standard store-test round trip).
```

- [ ] **Step 2: Append the migration** to `MIGRATIONS` in `src/store/schema.ts`:

```sql
  -- The daily rule vote. rule_offers is the day's numbered draw (claim-then-
  -- post: message_ts NULL between the claim and the successful Slack post);
  -- rule_reactions is the RAW vote-reaction record the 21:00 tally derives
  -- from — the analogue of `reactions` for offers. It is a separate table
  -- because `reactions` structurally cannot hold a vote: no emoji column
  -- (a vote is WHICH numeral), one row per player per message (a change of
  -- vote needs two live rows), and first-timestamp-wins writes (votes are
  -- latest-wins). The DERIVED tally is never stored — computed at tick time.
  CREATE TABLE rule_offers (
    season_id  TEXT NOT NULL,
    day        INTEGER NOT NULL CHECK (day >= 1),
    rule_id    TEXT NOT NULL,
    ordinal    INTEGER NOT NULL CHECK (ordinal >= 1),
    seed       TEXT NOT NULL,
    message_ts TEXT,
    PRIMARY KEY (season_id, day, rule_id),
    UNIQUE (season_id, day, ordinal)
  );

  CREATE INDEX rule_offers_by_message ON rule_offers (message_ts);

  CREATE TABLE rule_reactions (
    season_id  TEXT NOT NULL,
    day        INTEGER NOT NULL CHECK (day >= 1),
    faction_id TEXT NOT NULL,
    ordinal    INTEGER NOT NULL CHECK (ordinal >= 1),
    reacted_at TEXT NOT NULL,
    PRIMARY KEY (season_id, day, faction_id, ordinal)
  );
```

- [ ] **Step 3: Implement the methods** in `src/store/sqlite.ts` (inside the store object, following its house style — prepared statements, spread rows):

```ts
claimRuleOffers(seasonId: string, day: number, ruleIds: string[], seed: string): void {
  // Validated against the closed catalogue BEFORE insert: nothing that
  // arrives over the wire can name a rule (reactions carry ordinals only),
  // so anything unknown here is a code bug worth a throw, not a skip.
  for (const id of ruleIds) {
    if (!RULE_REGISTRY.has(id)) throw new Error(`unknown rule id: ${id}`)
  }
  this.transaction(() => {
    ruleIds.forEach((ruleId, i) => {
      db.prepare(
        `INSERT INTO rule_offers (season_id, day, rule_id, ordinal, seed, message_ts)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(seasonId, day, ruleId, i + 1, seed)
    })
  })
},

ruleOffersFor(seasonId: string, day: number): RuleOfferRow[] {
  const rows = db.prepare(
    `SELECT rule_id, ordinal, seed, message_ts FROM rule_offers
      WHERE season_id = ? AND day = ? ORDER BY ordinal`,
  ).all(seasonId, day) as { rule_id: string; ordinal: number; seed: string; message_ts: string | null }[]
  return rows.map((r) => ({ ruleId: r.rule_id, ordinal: r.ordinal, seed: r.seed, messageTs: r.message_ts }))
},

recordOfferMessage(seasonId: string, day: number, messageTs: string): void {
  db.prepare(`UPDATE rule_offers SET message_ts = ? WHERE season_id = ? AND day = ?`)
    .run(messageTs, seasonId, day)
},

offerForMessage(messageTs: string): { seasonId: string; day: number; ordinals: number[] } | undefined {
  const rows = db.prepare(
    `SELECT season_id, day, ordinal FROM rule_offers WHERE message_ts = ? ORDER BY ordinal`,
  ).all(messageTs) as { season_id: string; day: number; ordinal: number }[]
  const first = rows[0]
  if (first === undefined) return undefined
  return { seasonId: first.season_id, day: first.day, ordinals: rows.map((r) => r.ordinal) }
},

recordRuleReaction(r: { seasonId: string; day: number; factionId: FactionId; ordinal: number; reactedAt: string }): void {
  // Upsert, latest Slack timestamp wins — the exact opposite of reactions'
  // INSERT OR IGNORE, and correct here: a re-added numeral means "this is my
  -- vote again, now". ISO at write, same convention as recordApproval.
  db.prepare(
    `INSERT INTO rule_reactions (season_id, day, faction_id, ordinal, reacted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (season_id, day, faction_id, ordinal)
     DO UPDATE SET reacted_at = excluded.reacted_at`,
  ).run(r.seasonId, r.day, r.factionId, r.ordinal, slackTsToIso(r.reactedAt))
},

removeRuleReaction(seasonId: string, day: number, factionId: FactionId, ordinal: number): void {
  db.prepare(
    `DELETE FROM rule_reactions WHERE season_id = ? AND day = ? AND faction_id = ? AND ordinal = ?`,
  ).run(seasonId, day, factionId, ordinal)
},

ruleReactionsFor(seasonId: string, day: number): RuleReactionRow[] {
  const rows = db.prepare(
    `SELECT faction_id, ordinal, reacted_at FROM rule_reactions
      WHERE season_id = ? AND day = ? ORDER BY faction_id, ordinal`,
  ).all(seasonId, day) as { faction_id: string; ordinal: number; reacted_at: string }[]
  return rows.map((r) => ({ factionId: r.faction_id, ordinal: r.ordinal, reactedAt: r.reacted_at }))
},
```

(Watch the comment style inside the template string — SQL comments are `--`.)
Add `import { RULE_REGISTRY } from "../engine/rules/index.js"` and the two row
types to the imports; add `RuleVoteStore` to the store's implemented-interfaces
type in `src/store/types.ts` (the `Store` intersection the file exports).

- [ ] **Step 4: Run** — `npm test -- src/store` → PASS; full `npm test` still green.
- [ ] **Step 5: Commit** — `git commit -m "feat(store): rule_offers and rule_reactions — the raw vote record and the claim-then-post offer ledger"`

---

### Task 5: The tally — derived at read, never stored

**Files:**
- Create: `src/slack/rule-vote.ts`
- Test: `src/slack/rule-vote.test.ts`

**Interfaces:**
- Consumes: `RuleOfferRow`, `RuleReactionRow`, `RuleVoteStore` (Task 4).
- Produces:
  - `tallyRuleVote(offers: RuleOfferRow[], reactions: RuleReactionRow[], tickInstantIso: string): string | undefined` — pure.
  - `dailyRuleSelection(store: RuleVoteStore, seasonId: string, day: number, tickInstantIso: string): string[]` — `[]` or `[winner]`; what the tick freezes into `ctx.rules`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/slack/rule-vote.test.ts
import { describe, expect, it } from "vitest"
import { tallyRuleVote } from "./rule-vote.js"
import type { RuleOfferRow, RuleReactionRow } from "../store/types.js"

const TICK = "2026-09-01T21:00:00.000Z"
const offers: RuleOfferRow[] = [
  { ruleId: "boom", ordinal: 1, seed: "7", messageTs: "111.000" },
  { ruleId: "truce", ordinal: 2, seed: "7", messageTs: "111.000" },
  { ruleId: "attrition", ordinal: 3, seed: "7", messageTs: "111.000" },
]
const rx = (factionId: string, ordinal: number, reactedAt: string): RuleReactionRow =>
  ({ factionId, ordinal, reactedAt })

describe("tallyRuleVote", () => {
  it("a player's vote is their latest still-present numeral", () => {
    // f1 voted 1 at 10:00, then 2 at 12:00 — both rows live; the 12:00 wins.
    const r = [rx("f1", 1, "2026-09-01T10:00:00.000Z"), rx("f1", 2, "2026-09-01T12:00:00.000Z")]
    expect(tallyRuleVote(offers, r, TICK)).toBe("truce")
  })
  it("removal un-votes and an earlier still-present numeral resurrects", () => {
    // The 12:00 row was deleted (reaction_removed) — only the 10:00 row remains.
    expect(tallyRuleVote(offers, [rx("f1", 1, "2026-09-01T10:00:00.000Z")], TICK)).toBe("boom")
  })
  it("re-add records the new timestamp and outranks an intermediate vote", () => {
    // f1: voted 2 at 11:00, then re-added 1 at 13:00 (upsert rewrote 1's row).
    const r = [rx("f1", 1, "2026-09-01T13:00:00.000Z"), rx("f1", 2, "2026-09-01T11:00:00.000Z")]
    expect(tallyRuleVote(offers, r, TICK)).toBe("boom")
  })
  it("the delayed-tick regression: a reaction after 21:00 never counts, even if stored", () => {
    // The 21:00:01 row is PRESENT (a late tick's transaction read it) — the
    // cutoff predicate excludes it; f1's earlier vote stands.
    const r = [rx("f1", 1, "2026-09-01T20:59:00.000Z"), rx("f1", 2, "2026-09-01T21:00:01.000Z")]
    expect(tallyRuleVote(offers, r, TICK)).toBe("boom")
  })
  it("one vote per player; plurality wins; ties break on the LOWEST rule id", () => {
    const r = [
      rx("f1", 2, "2026-09-01T10:00:00.000Z"),   // truce
      rx("f2", 3, "2026-09-01T10:01:00.000Z"),   // attrition
    ]
    expect(tallyRuleVote(offers, r, TICK)).toBe("attrition") // 1-1 tie → lowest id
  })
  it("no votes selects nothing", () => {
    expect(tallyRuleVote(offers, [], TICK)).toBeUndefined()
  })
  it("a reaction on an ordinal with no offer row is ignored (defense in depth)", () => {
    expect(tallyRuleVote(offers, [rx("f1", 9, "2026-09-01T10:00:00.000Z")], TICK)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```ts
// src/slack/rule-vote.ts
import type { RuleOfferRow, RuleReactionRow, RuleVoteStore } from "../store/types.js"

/**
 * Derive the day's winning rule from RAW reaction rows, at the 21:00 tally.
 * Never stored — the frozen ctx.rules is the durable record of what won.
 *
 * The cutoff predicate is explicit and two-part: a row counts only if it is
 * present when the tick's transaction reads AND reacted_at <= tickInstant.
 * Both sides are ISO instants (slackTsToIso at write), so the comparison is
 * a plain string compare — a delayed tick must not count a 21:00:01 reaction
 * just because its webhook landed before the transaction began.
 */
export function tallyRuleVote(
  offers: RuleOfferRow[],
  reactions: RuleReactionRow[],
  tickInstantIso: string,
): string | undefined {
  const byOrdinal = new Map(offers.map((o) => [o.ordinal, o.ruleId]))

  // One vote per player: the latest still-present numeral inside the cutoff.
  // A same-instant tie breaks on the lower ordinal — Slack ts precision makes
  // it near-unreachable, but replay must be deterministic.
  const latest = new Map<string, { ordinal: number; reactedAt: string }>()
  for (const r of reactions) {
    if (r.reactedAt > tickInstantIso) continue
    if (!byOrdinal.has(r.ordinal)) continue
    const cur = latest.get(r.factionId)
    if (
      cur === undefined ||
      r.reactedAt > cur.reactedAt ||
      (r.reactedAt === cur.reactedAt && r.ordinal < cur.ordinal)
    ) {
      latest.set(r.factionId, { ordinal: r.ordinal, reactedAt: r.reactedAt })
    }
  }

  const counts = new Map<string, number>()
  for (const v of latest.values()) {
    const ruleId = byOrdinal.get(v.ordinal)!
    counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1)
  }
  let winner: string | undefined
  let best = 0
  for (const [ruleId, n] of counts) {
    if (n > best || (n === best && winner !== undefined && ruleId < winner)) {
      winner = ruleId
      best = n
    }
  }
  return winner
}

/** What the tick freezes into ctx.rules: [] or [winner]. */
export function dailyRuleSelection(
  store: RuleVoteStore,
  seasonId: string,
  day: number,
  tickInstantIso: string,
): string[] {
  const offers = store.ruleOffersFor(seasonId, day)
  if (offers.length === 0) return []
  const winner = tallyRuleVote(offers, store.ruleReactionsFor(seasonId, day), tickInstantIso)
  return winner === undefined ? [] : [winner]
}
```

- [ ] **Step 4: Run** — `npm test -- src/slack/rule-vote.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(slack): the rule-vote tally, derived from raw reactions at read time"`

---

### Task 6: The ingest vote branch

**Files:**
- Modify: `src/slack/config.ts` (add `NUMERAL_EMOJI`)
- Modify: `src/slack/events.ts` (the vote branch in `interpretReaction`, new decision kinds)
- Modify: `src/slack/handlers.ts` (the vote branch in `handleReactionEvent`, extended `IngestDeps`)
- Modify: `src/slack/app.ts` (widen `SlackAppDeps.store` with `RuleVoteStore`)
- Test: `src/slack/events.test.ts`, `src/slack/handlers.test.ts` (extend both)

**Interfaces:**
- Consumes: `RuleVoteStore` (Task 4).
- Produces:
  - `NUMERAL_EMOJI: Readonly<Record<string, number>>` (`one`→1 … `nine`→9) in config.ts
  - `ReactionDecision` gains `{ kind: "vote"; slackUserId; messageTs; ordinal; reactedAt }` and `{ kind: "unvote"; slackUserId; messageTs; ordinal }`
  - `DropReason` gains `"not-an-offer" | "unmapped-numeral"`
  - `IngestDeps.store` becomes `ApprovalStore & RosterStore & RuleVoteStore`
  - `IngestOutcome` kinds gain `"vote" | "unvote"`

- [ ] **Step 1: Write the failing tests**

```ts
// events.test.ts additions (follow the file's existing input-builder helpers):
// - a numeral reaction ("two") on a message in the right team/channel from a
//   rostered user → { kind: "vote", ordinal: 2, ... } — BEFORE the approval
//   filter, which would have dropped it as not-an-approval.
// - reaction_removed with "two" → { kind: "unvote", ordinal: 2 }.
// - a numeral from a NON-rostered user → drop not-on-roster (the branch does
//   its own roster check — the shipped gate order has roster after the emoji
//   filter, which the vote branch bypasses).
// - a numeral where user === item_user is STILL a vote: the offer message is
//   bot-authored, so the self-approval check does not apply. Assert kind
//   "vote", not a drop — pinned so nobody re-adds the check.
// - "+1" still approves; junk emoji still drops as not-an-approval.

// handlers.test.ts additions (the file already fakes the store):
// - THE REACHABILITY TEST (spec test 9): store an offer via claimRuleOffers +
//   recordOfferMessage("111.000"); a numeral reaction event on ts "111.000"
//   survives BOTH gates (interpretReaction's emoji filter and
//   handleReactionEvent's postFor gate) and lands in rule_reactions.
// - a numeral on a ts with NO offer row → drop "not-an-offer" (numerals on
//   workout photos or chatter store nothing).
// - "nine" on a three-candidate offer → drop "unmapped-numeral", and rule_
//   reactions is EMPTY after — an unmapped numeral must not become a player's
//   "latest" and void their valid earlier vote (spec test 9).
// - reaction_removed on the offer message deletes the row (unvote).
// - dedupe: the same eventId twice → second returns { kind: "duplicate" }.
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

`src/slack/config.ts`:

```ts
/** Numeral reactions on the daily rule offer. Post-normalizeEmoji names. */
export const NUMERAL_EMOJI: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
}
```

`src/slack/events.ts` — extend the unions:

```ts
export type DropReason =
  | /* existing members */ "not-an-offer" | "unmapped-numeral"

export type ReactionDecision =
  | { kind: "approve"; slackUserId: string; messageTs: string; reactedAt: string }
  | { kind: "unapprove"; slackUserId: string; messageTs: string }
  | { kind: "vote"; slackUserId: string; messageTs: string; ordinal: number; reactedAt: string }
  | { kind: "unvote"; slackUserId: string; messageTs: string; ordinal: number }
  | { kind: "drop"; reason: DropReason }
```

and insert the branch in `interpretReaction` after the channel check
(`src/slack/events.ts:114`), BEFORE the `APPROVAL_EMOJI` filter:

```ts
  // The vote branch. Sits BEFORE the approval-emoji filter, which would drop
  // every numeral. It does its own roster check (the shipped gate order puts
  // roster after the emoji filter) and skips the self-approval check on
  // purpose: the offer message is bot-authored, so item_user is never a
  // player — stated so nobody re-adds it.
  const numeral =
    event.reaction === undefined ? undefined : NUMERAL_EMOJI[normalizeEmoji(event.reaction)]
  if (numeral !== undefined) {
    if (event.user === undefined || !scope.roster.has(event.user)) {
      return { kind: "drop", reason: "not-on-roster" }
    }
    if (event.item.ts === undefined) return { kind: "drop", reason: "not-a-message" }
    if (event.type === "reaction_removed") {
      return { kind: "unvote", slackUserId: event.user, messageTs: event.item.ts, ordinal: numeral }
    }
    if (event.event_ts === undefined) return { kind: "drop", reason: "not-a-message" }
    return {
      kind: "vote",
      slackUserId: event.user,
      messageTs: event.item.ts,
      ordinal: numeral,
      reactedAt: event.event_ts,
    }
  }
```

`src/slack/handlers.ts` — widen deps and outcomes, then insert the branch in
`handleReactionEvent` after `seen()` + `interpretReaction`, BEFORE the `postFor`
gate (a bot-authored offer message never enters `posts`, so the existing gate
would drop every vote):

```ts
export interface IngestDeps {
  store: ApprovalStore & RosterStore & RuleVoteStore
  scope: { teamId: string; channelId: string }
  log: (msg: string) => void
}

export type IngestOutcome =
  | { kind: "post" | "delete" | "approve" | "unapprove" | "vote" | "unvote" }
  | { kind: "duplicate" }
  | { kind: "drop"; reason: DropReason | "unknown-post" }
```

```ts
  if (decision.kind === "vote" || decision.kind === "unvote") {
    // The day's offer message is recognized by its stored ts — the analogue
    // of the postFor gate, which this branch deliberately bypasses.
    const offer = deps.store.offerForMessage(decision.messageTs)
    if (offer === undefined) return { kind: "drop", reason: "not-an-offer" }

    const factionId = deps.store.factionForSlackUser(decision.slackUserId)
    if (factionId === undefined) return { kind: "drop", reason: "not-on-roster" }

    // Dropped at ingest, not stored: `nine` on a three-candidate day must not
    // become the player's "latest" and silently void a valid earlier vote.
    if (!offer.ordinals.includes(decision.ordinal)) {
      return { kind: "drop", reason: "unmapped-numeral" }
    }

    if (decision.kind === "unvote") {
      deps.store.removeRuleReaction(offer.seasonId, offer.day, factionId, decision.ordinal)
      deps.log(`unvote day ${offer.day} ordinal ${decision.ordinal} by ${factionId}`)
      return { kind: "unvote" }
    }
    deps.store.recordRuleReaction({
      seasonId: offer.seasonId,
      day: offer.day,
      factionId,
      ordinal: decision.ordinal,
      reactedAt: decision.reactedAt,
    })
    deps.log(`vote day ${offer.day} ordinal ${decision.ordinal} by ${factionId}`)
    return { kind: "vote" }
  }
```

`src/slack/app.ts`: `store: ApprovalStore & RosterStore & AuthStore & RuleVoteStore`.
(`src/slack/cli.ts` passes `openStore`'s result, which implements everything —
no change there.)

- [ ] **Step 4: Run** — `npm test -- src/slack` → PASS; `npm run typecheck` (catches any fake store missing the new methods — extend the test fakes with the `RuleVoteStore` methods where handlers tests build partial stores).
- [ ] **Step 5: Commit** — `git commit -m "feat(slack): the numeral vote branch through both ingest gates"`

---

### Task 7: The offer message and the `publish-rules` job

**Files:**
- Modify: `src/slack/post.ts` (`Poster.post` returns the message ts)
- Create: `src/slack/offer.ts` (`renderRuleOffer`)
- Create: `src/jobs/publish-rules.ts`
- Modify: `src/jobs/cli.ts` (the `publish-rules` command), `package.json` (`"rules:publish": "tsx src/jobs/cli.ts publish-rules"`)
- Create: `deploy/riskety-publish-rules.service`, `deploy/riskety-publish-rules.timer` (08:05, mirroring the publish-slate pair); mention in `deploy/README.md`
- Test: `src/slack/offer.test.ts`, `src/jobs/publish-rules.test.ts`

**Interfaces:**
- Consumes: `RULE_REGISTRY`, `eligibleRules` (Task 2); `RuleVoteStore` (Task 4); `makeRng`, `shuffle` from `../rng.js`; `etDate`, `etDaysBetween` from `../time.js`.
- Produces:
  - `Poster.post(message: SlackMessage): Promise<string | undefined>` — the posted message's `ts` (from `chat.postMessage`'s response), `undefined` if Slack omits it.
  - `renderRuleOffer(day: number, offers: { ordinal: number; name: string; description: string }[], opts?: { supersedes?: boolean }): { text: string; blocks: Block[] }`
  - `runPublishRules(deps: PublishRulesDeps): Promise<PublishRulesOutcome>` with

```ts
export type PublishRulesOutcome =
  | { status: "posted"; day: number; ruleIds: string[] }
  | { status: "claimed"; day: number; ruleIds: string[] }   // no poster configured; rows claimed, post pending
  | { status: "skipped"; day: number; reason: "before-season" | "after-season" | "already-posted" | "no-candidates" }

export interface PublishRulesDeps {
  store: SeasonStore & RuleVoteStore & Transactional
  seasonId: string
  now: Date
  poster?: Poster        // optional, same concession postRecapFor makes
  log?: (msg: string) => void
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/slack/offer.test.ts:
// - renderRuleOffer(5, [{ordinal:1,name:"Boom",description:"…"}, …]) produces a
//   header naming day 5, one line per candidate containing ":one:" / ":two:" /
//   ":three:" and the name and description, and a context block telling players
//   to react with the number, that the latest reaction counts, that removing
//   un-votes, and that the tally is at 21:00 ET.
// - opts.supersedes adds the supersession line "Replaces the offer above — vote
//   here." as the FIRST context block.
// - a hostile description (`*bold* <script>`) passes through safeText length
//   caps; blocks are plain_text so Slack renders it inert (assert the cap, and
//   that block types are plain_text — mirroring announce.test.ts's approach).

// src/jobs/publish-rules.test.ts (in-memory store via openStore, fake poster
// capturing messages and returning a fixed ts):
// - fresh day: claims rows (ordinal 1..n, seed stored), posts, records ts;
//   outcome "posted"; ruleOffersFor shows message_ts set.
// - the draw is DETERMINISTIC: two stores initialized with the same season
//   seed produce the same rule order for the same day, and the stored seed
//   string equals String(((seed ?? 0) ^ (day * 0x9e3779b9)) >>> 0).
// - already-posted: second run → skipped "already-posted", poster not called.
// - CRASH-BEFORE-POST replay (spec test 9): first run with a poster whose
//   post() throws → rows exist with message_ts NULL (the claim landed; the
//   error propagates for systemd). Second run with a working poster → posts
//   WITH the supersession copy and records the new ts. Votes recorded against
//   the NEW ts count (drive handleReactionEvent at the new ts, then
//   dailyRuleSelection returns the winner) — the orphan window is accepted
//   loss, asserted exactly this way and no stronger.
// - needs filter: a season with modules ["irl"] and a test catalogue where a
//   rule needs "markets" → that rule is not offered. Season-one rules have no
//   needs, so pass the synthetic catalogue through eligibleRules directly in
//   its own unit test (Task 2 already covers it) and here assert the job
//   offers all three under default modules.
// - before-season / after-season days skip; a catalogue yielding zero eligible
//   rules skips "no-candidates".
// - no poster configured: outcome "claimed", rows NULL, a later run posts.
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

`src/slack/post.ts` — return the ts:

```ts
export interface Poster {
  /** Resolves to the posted message's ts — claim-then-post ledgers record it. */
  post(message: SlackMessage): Promise<string | undefined>
}
// in createPoster:
    async post(message: SlackMessage): Promise<string | undefined> {
      const res = await web.chat.postMessage({ /* unchanged args */ })
      return (res as { ts?: string }).ts
    },
```

Sweep: test fakes of `Poster` update their signature (return `Promise.resolve("1.000")`
or similar); production callers (`postRecapFor`, the slate announce closure)
ignore the value — no change.

`src/slack/offer.ts` — reuse the structural `Block` type:

```ts
import { RECAP_NAME_MAX_CHARS } from "./config.js"
import { safeText } from "./text.js"
import type { Block } from "./recap.js"

const NUMERAL_NAMES = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true as const })

export function renderRuleOffer(
  day: number,
  offers: { ordinal: number; name: string; description: string }[],
  opts: { supersedes?: boolean } = {},
): { text: string; blocks: Block[] } {
  const blocks: Block[] = [
    { type: "header", text: plain(`Day ${day} — vote on today's rule`) },
  ]
  if (opts.supersedes === true) {
    blocks.push({ type: "context", elements: [plain("Replaces the offer above — vote here.")] })
  }
  const lines = offers.map(
    (o) =>
      `:${NUMERAL_NAMES[o.ordinal - 1] ?? "hash"}: ${safeText(o.name, RECAP_NAME_MAX_CHARS)} — ${safeText(o.description, 120)}`,
  )
  blocks.push({ type: "section", text: plain(lines.join("\n")) })
  blocks.push({
    type: "context",
    elements: [
      plain(
        "React with the number to vote. Your latest reaction counts; remove it to un-vote. Tally at 9pm ET — the winner applies to tonight's tick.",
      ),
    ],
  })
  return { text: safeText(`Day ${day} rule vote`, 200), blocks }
}
```

`src/jobs/publish-rules.ts`:

```ts
import { RULE_REGISTRY, eligibleRules } from "../engine/rules/index.js"
import { makeRng, shuffle } from "../rng.js"
import { etDate, etDaysBetween } from "../time.js"
import { renderRuleOffer } from "../slack/offer.js"
import type { Poster } from "../slack/post.js"
import type { RuleVoteStore, SeasonStore, Transactional } from "../store/types.js"

/**
 * The 08:05 job: draw the day's candidates, claim them, post the offer.
 *
 * Claim-then-post, the recap ledger's pattern. The guarantee, stated honestly
 * (spec, "Voting"): a crash BEFORE the post replays cleanly — the next run
 * finds claimed rows with message_ts NULL and posts them. A crash AFTER the
 * post but before recordOfferMessage orphans that message: its ts exists
 * nowhere, its reactions can never map to a row, and they are lost by
 * construction — one systemd retry wide, accepted rather than papered over.
 * The re-post marks supersession so players move to the live message.
 */
export async function runPublishRules(deps: PublishRulesDeps): Promise<PublishRulesOutcome> {
  const { store, seasonId, now } = deps
  const log = deps.log ?? (() => {})

  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`publish-rules: unknown season ${seasonId}`)

  const day = etDaysBetween(season.startDate, etDate(now))
  // Rules apply to the SAME day's tick, so the final day is offered — unlike
  // the slate, whose wagers would settle at a tick that never runs.
  if (day < 1) return { status: "skipped", day, reason: "before-season" }
  if (day > season.lengthDays) return { status: "skipped", day, reason: "after-season" }

  let offers = store.ruleOffersFor(seasonId, day)
  const recovering = offers.length > 0 && offers.every((o) => o.messageTs === null)
  if (offers.length > 0 && !recovering) {
    return { status: "skipped", day, reason: "already-posted" }
  }

  if (!recovering) {
    const modules = season.modules ?? ["markets", "irl", "veto"]
    const eligible = eligibleRules(modules)
    if (eligible.length === 0) return { status: "skipped", day, reason: "no-candidates" }
    // Deterministic and auditable: the seed derives from the season seed and
    // the day, and is stored on every offer row.
    const seedNum = (((season.seed ?? 0) ^ (day * 0x9e3779b9)) >>> 0)
    const draw = shuffle([...eligible], makeRng(seedNum)).slice(0, 9)
    store.claimRuleOffers(seasonId, day, draw.map((r) => r.id), String(seedNum))
    offers = store.ruleOffersFor(seasonId, day)
    log(`day ${day}: offering ${draw.map((r) => r.id).join(", ")} (seed ${seedNum})`)
  }

  const ruleIds = offers.map((o) => o.ruleId)
  if (deps.poster === undefined) {
    log(`day ${day}: offer claimed; no Slack token, so nothing was posted`)
    return { status: "claimed", day, ruleIds }
  }

  const message = renderRuleOffer(
    day,
    offers.map((o) => {
      const r = RULE_REGISTRY.get(o.ruleId)!
      return { ordinal: o.ordinal, name: r.name, description: r.description }
    }),
    { ...(recovering ? { supersedes: true } : {}) },
  )
  const ts = await deps.poster.post(message)
  if (ts !== undefined) store.recordOfferMessage(seasonId, day, ts)
  log(`day ${day}: rule offer posted${ts === undefined ? " (no ts returned)" : ""}`)
  return { status: "posted", day, ruleIds }
}
```

(Define `PublishRulesDeps`/`PublishRulesOutcome` exactly as in the Interfaces
block.) In `src/jobs/cli.ts`, add the command beside `publish-slate`, reusing
its poster-optional pattern:

```ts
  } else if (command === "publish-rules") {
    const poster =
      process.env.SLACK_BOT_TOKEN === undefined || process.env.SLACK_BOT_TOKEN === ""
        ? undefined
        : createPoster(loadSlackEnv())
    const out = await runPublishRules({
      store,
      seasonId: required("RR_SEASON_ID"),
      now: new Date(),
      log,
      ...(poster === undefined ? {} : { poster }),
    })
    if (out.status === "skipped") log(`skipped day ${out.day}: ${out.reason}`)
```

Add it to the CLI's unknown-command usage list. `package.json`:
`"rules:publish": "tsx src/jobs/cli.ts publish-rules"`. The systemd pair copies
`riskety-publish-slate.service`/`.timer` with `OnCalendar=*-*-* 08:05:00`
(America/New_York, matching the existing units) and the `publish-rules` command.

- [ ] **Step 4: Run** — `npm test -- src/jobs src/slack` → PASS; full suite + typecheck (the `Poster` return-type sweep will surface every fake).
- [ ] **Step 5: Commit** — `git commit -m "feat(jobs,slack): the daily rule offer — seeded draw, claim-then-post, numeral ballot"`

---

### Task 8: Freeze the tally into the tick; announce the rule in the recap

**Files:**
- Modify: `src/jobs/tick.ts` (`TickDeps.store` type, the `rules:` line at `src/jobs/tick.ts:140`)
- Modify: `src/jobs/rerun.ts` (`assembleContext`'s store type and `rules:` line at `src/jobs/rerun.ts:204`; `backfillContext` is already correct — pre-change rows synthesize `rules: []`)
- Modify: `src/jobs/post-recap.ts` (`ruleIds` through to the renderer), `src/jobs/cli.ts` (`postRecapFor` reads `tick_context`)
- Modify: `src/slack/recap.ts` (`RecapInput.ruleIds`, the "Rule in force" block)
- Test: `src/jobs/tick.test.ts`, `src/jobs/rerun.test.ts`, `src/slack/recap.test.ts` (extend)

**Interfaces:**
- Consumes: `dailyRuleSelection` (Task 5), `RuleVoteStore` (Task 4), `RULE_REGISTRY` (Task 2).
- Produces: `RecapInput` gains `ruleIds?: string[]`; `PostRecapDeps` gains `ruleIds?: string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// tick.test.ts additions:
// - seed rule_offers + rule_reactions for the day (via the store, raw Slack ts
//   through recordRuleReaction); run the tick; assert the SAVED tick_context's
//   context.rules === [winner], and the resolved state shows the rule's effect
//   (use "boom": reserves grew by double income).
// - a day with offers but no votes freezes rules: [] and resolves normally.
// - a reaction with reacted_at after the tick instant does not count even
//   though the row is present (the delayed-tick regression, end to end).
//
// rerun.test.ts additions:
// - FREEZING (spec test 8): tick a day where "boom" won; then DELETE every
//   rule_reactions row; rerun the day with --confirm. The replay must use the
//   frozen ctx.rules — assert the replayed state still shows boom's grants
//   and the re-saved context still carries ["boom"]. (Rule selection is
//   frozen; rule behavior is engineVersion's concern, per the spec.)
// - a pre-change context (no tickInstant/modules/rules) still backfills
//   rules: [] — existing test, extend its assertion to name rules.
//
// recap.test.ts additions:
// - renderRecap({ ..., ruleIds: ["truce"] }) renders a block containing
//   "Rule in force" with Truce's name AND description (the user-visible record
//   of why no attacks landed — and the description says moves still run).
// - an id RULE_REGISTRY doesn't know renders as the bare id, no throw
//   (frozen history must outlive a catalogue edit).
// - no ruleIds → no rule block (existing recaps unchanged).
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

`src/jobs/tick.ts` — widen `TickDeps.store` with `& RuleVoteStore`, import
`dailyRuleSelection` from `../slack/rule-vote.js`, and build the context with
the tally (inside the transaction — the tally reads what is present when the
transaction reads, which with `reacted_at <= tickInstant` is exactly the
spec's cutoff predicate):

```ts
    const instant = tickInstant(season, day).toISOString()
    const context: DailyContext = {
      slate,
      approvals: irl.approvals,
      postedToday: irl.postedToday,
      settlements,
      tickInstant: instant,
      modules: season.modules ?? [...DEFAULT_MODULES],
      rules: dailyRuleSelection(store, seasonId, day, instant),
    }
```

`src/jobs/rerun.ts` — `assembleContext` gains the same `rules:` derivation (its
store param type gains `& RuleVoteStore`); it is the `--assemble-missing` path,
where reading live tables is the named concession. `backfillContext` is
untouched.

`src/slack/recap.ts`:

```ts
import { RULE_REGISTRY } from "../engine/rules/index.js"
// RecapInput:
  /** The day's winning rule ids, from the frozen tick_context. */
  ruleIds?: string[]
// after the correction block in renderRecap:
  for (const id of input.ruleIds ?? []) {
    const r = RULE_REGISTRY.get(id)
    const label = r === undefined ? id : `${r.name} — ${r.description}`
    blocks.push(context([safeText(`Rule in force: ${label}`, 200)]))
  }
```

`src/jobs/post-recap.ts` — `PostRecapDeps` gains `ruleIds?: string[]`, passed to
`renderRecap` by conditional spread. `src/jobs/cli.ts` `postRecapFor`:

```ts
  const ruleIds = s.loadTickContext(seasonId, state.day)?.context.rules ?? []
  // pass ...(ruleIds.length === 0 ? {} : { ruleIds }) into runPostRecap
```

- [ ] **Step 4: Run** — `npm test` → PASS (the golden file must NOT have changed — if it did, stop). `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(jobs,slack): freeze the day's rule into tick_context; the recap names it"`

---

### Task 9: The bounded-swing gate and the balance run

**Files:**
- Modify: `src/sim/run.ts` (`runSeason` opts gain `rules` and `voteRules`)
- Create: `src/sim/rule-gate.ts` (paired per-rule arms + the gate; also the CLI entry)
- Modify: `package.json` (`"sim:rules": "tsx src/sim/rule-gate.ts"`)
- Test: `src/sim/run.test.ts` or `src/sim/policies.test.ts` (extend, tiny-N smoke)
- Docs: `docs/superpowers/reviews/2026-08-11-balance-run-rules.md` (create from the run's output)

**Interfaces:**
- Consumes: `RULE_CATALOGUE`, `RULE_REGISTRY` (Task 2); `runSeason`, `seatsFor` (shipped); `shuffle`, `makeRng`.
- Produces:
  - `runSeason(policyNames, seed, opts?: { modules?: string[]; rules?: string[]; voteRules?: boolean })` — `rules` forces those rules active every day; `voteRules` draws a daily offer (seeded shuffle of the catalogue) and has each seat vote uniformly at random (abstain probability ½), plurality winner, ties lowest id.
  - `runRuleGate(policyNames: string[], seasonsPerArm: number, ruleId: string): GateResult` where

```ts
export interface GateResult {
  ruleId: string
  seasons: number
  perPolicy: {
    policy: string
    baselinePct: number
    forcedPct: number
    diffPct: number       // forced − baseline, percentage points
    pairedSePct: number   // sd of per-season paired diffs / sqrt(n), ×100
    ci95Pct: [number, number]
    pass: boolean         // |diffPct| <= 3
  }[]
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// sim test additions (tiny N so the suite stays fast):
// - runSeason(names, 1, { rules: ["truce"] }) completes; runSeason(names, 1,
//   { rules: ["boom"] }) completes; runSeason(names, 1, { voteRules: true })
//   completes. (Completion is the engine accepting the forced context every
//   day — a wrong rule id would throw.)
// - forced truce vs baseline on one seed: identical seeds, and the truce arm's
//   final ownership equals the day-0 ownership restricted to attacks — assert
//   simply that no seat was eliminated in the truce arm... too map-dependent;
//   instead assert runSeason(names, 7, { rules: ["truce"] }).finalTerritories
//   sums to the board size (conservation smoke) and differs from baseline.
// - runRuleGate(names, 30, "boom") returns one row per distinct policy with
//   finite diffPct and pairedSePct, and baseline/forced arms used the SAME
//   seeds (determinism: calling it twice returns identical numbers).
```

- [ ] **Step 2: Implement `runSeason` opts** — in `src/sim/run.ts`:

```ts
export function runSeason(
  policyNames: string[],
  seed: number,
  opts: { modules?: string[]; rules?: string[]; voteRules?: boolean } = {},
): SeasonResult {
```

Inside the day loop, replace `rules: []` in the context literal:

```ts
    // Forced rules are the balance gate's stress arm; voteRules is the
    // dynamics arm — a seeded daily draw with uniform-random seat votes
    // (abstain ½), plurality, ties to the lowest rule id. The model is
    // deliberately strategy-free; the review doc states it.
    let rules: string[] = opts.rules ?? []
    if (opts.voteRules === true) {
      const offered = shuffle([...RULE_CATALOGUE], rng).slice(0, 9)
      const counts = new Map<string, number>()
      for (let i = 0; i < seatIds.length; i++) {
        if (rng() < 0.5) continue
        const pick = offered[Math.floor(rng() * offered.length)]!
        counts.set(pick.id, (counts.get(pick.id) ?? 0) + 1)
      }
      let winner: string | undefined
      let best = 0
      for (const [id, n] of counts) {
        if (n > best || (n === best && winner !== undefined && id < winner)) { winner = id; best = n }
      }
      rules = winner === undefined ? [] : [winner]
    }
    const context: DailyContext = { /* …existing fields… */, rules }
```

(Import `RULE_CATALOGUE` from `../engine/rules/index.js` and `shuffle` from
`../rng.js`.) Note the draw consumes `rng` — the voteRules arm is therefore not
seed-comparable with baseline, which is fine: only the FORCED arms feed the
gate, and they consume no extra randomness.

- [ ] **Step 3: Implement `src/sim/rule-gate.ts`**

```ts
import { RULE_CATALOGUE } from "../engine/rules/index.js"
import { runSeason, seatsFor } from "./run.js"

export interface GateResult { /* as in Interfaces */ }

/**
 * The bounded-swing gate (spec, "Replacing the reversibility test"): each rule
 * forced active EVERY day vs a no-rules baseline, same pinned seeds both arms
 * (common random numbers), 10,000 seasons per arm. Reject a rule moving any
 * policy's win rate by more than 3 points. The paired SE is EMPIRICAL — the
 * sd of per-season win-indicator differences — reported with a 95% CI, per
 * the spec's statistics correction.
 */
export function runRuleGate(policyNames: string[], seasonsPerArm: number, ruleId: string): GateResult {
  const seats = seatsFor(policyNames)
  const policyOf = new Map(seats.map((s) => [s.id, s.policy]))
  const policies = [...new Set(policyNames)]
  const diffs = new Map(policies.map((p) => [p, [] as number[]]))
  let baseWins = new Map(policies.map((p) => [p, 0]))
  let forcedWins = new Map(policies.map((p) => [p, 0]))

  for (let seed = 1; seed <= seasonsPerArm; seed++) {
    const base = runSeason(policyNames, seed)
    const forced = runSeason(policyNames, seed, { rules: [ruleId] })
    const bWin = policyOf.get(base.winner)
    const fWin = policyOf.get(forced.winner)
    for (const p of policies) {
      const b = bWin === p ? 1 : 0
      const f = fWin === p ? 1 : 0
      diffs.get(p)!.push(f - b)
      if (b) baseWins.set(p, baseWins.get(p)! + 1)
      if (f) forcedWins.set(p, forcedWins.get(p)! + 1)
    }
  }

  return {
    ruleId,
    seasons: seasonsPerArm,
    perPolicy: policies.map((p) => {
      const d = diffs.get(p)!
      const mean = d.reduce((a, x) => a + x, 0) / d.length
      const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (d.length - 1))
      const se = (sd / Math.sqrt(d.length)) * 100
      const diffPct = mean * 100
      return {
        policy: p,
        baselinePct: (baseWins.get(p)! / seasonsPerArm) * 100,
        forcedPct: (forcedWins.get(p)! / seasonsPerArm) * 100,
        diffPct,
        pairedSePct: se,
        ci95Pct: [diffPct - 1.96 * se, diffPct + 1.96 * se] as [number, number],
        pass: Math.abs(diffPct) <= 3,
      }
    }),
  }
}
```

CLI entry at the bottom (guarded on `import.meta.url` vs `process.argv[1]`, or
just always-run since the file IS the entry — follow `src/sim/cli.ts`'s style):
the 8-policy roster `["Turtle","Blitz","Consolidator","Hunter","Gambler","Slacker","GymRat","Arbitrageur"]`,
`seasonsPerArm = Number(process.argv[2] ?? 10_000)`, one gate per catalogue
rule, a printed table (policy, baseline, forced, diff, ±CI, PASS/FAIL), and a
final `voteRules: true` summary pass (wins per policy over the same season
count) for the dynamics arm.

- [ ] **Step 4: Run the committed gate** — `npm run sim:rules -- 200` as a smoke
  check first, then the full `npm run sim:rules` (10,000 per arm; the baseline
  arm re-runs per rule — accept the ~4× cost, it keeps the pairing code simple).
  Write `docs/superpowers/reviews/2026-08-11-balance-run-rules.md`: the gate
  table per rule, the empirical paired SEs and CIs, the vote-dynamics summary
  and its stated random-voting model, the stress-not-proof caveat for nonlinear
  rules (compounding Boom days), and the verdict per rule. **A rule failing the
  3-point gate does not merge with a failing number** — it is removed from
  `RULE_CATALOGUE` (and its file kept with a comment) or retuned, and the doc
  records which. Expected direction, to sanity-check against: Truce forced
  daily freezes the map and should crater aggressive policies' win rates —
  if it moves someone more than 3 points, that is the gate working; discuss in
  the doc and decide there. The forced-daily regime is the spec's stress
  screen, and the spec's own text anticipates rules passing it.
- [ ] **Step 5: Full suite + typecheck** — `npm test && npm run typecheck` → green.
- [ ] **Step 6: Commit** — `git commit -m "feat(sim): forced-rule and vote-dynamics arms; the bounded-swing gate at 10k seasons per arm"`

---

### Task 10: Docs sweep

**Files:**
- Modify: `CLAUDE.md` — the "Not built" section (the rule catalogue is now built; what remains, if anything, is whatever Task 9's gate rejected); the commands block gains `npm run rules:publish` and `npm run sim:rules`; the docs table gains the new review doc.
- Modify: `HANDOFF.md` — current state; add the vote-system rules a newcomer gets wrong (raw reactions vs derived tally; the cutoff predicate; unmapped numerals dropped at ingest; the accepted crash-after-post orphan window; the kill criterion: **if the catalogue ever holds fewer than three rules, delete the vote apparatus and keep the module system**).
- Modify: `codemaps/` — run `cc-codemaps:update-codemaps`, or by hand: `engine.md` (rules/, RULE_CATALOGUE, ctx.rules dispatch), `data.md` (migration 7, RuleVoteStore), `jobs.md` (publish-rules, tick's tally line), `integrations.md` (the vote branch gate order).
- Modify: `deploy/README.md` if not already done in Task 7.

- [ ] **Step 1: Make the edits.** **Step 2: `npm test && npm run typecheck` one last time.** **Step 3: Commit** — `git commit -m "docs: rule catalogue and voting landed"`

---

## Self-review (performed)

- **Spec coverage:** `Rule` + `needs` → T1/T2; three traced rules → T2; catalogue-load validation incl. unknown `needs`, per-namespace, description cap → T2 (+T1's unknown-rule half, +T3's ctx-side test); engine dispatch, determinism, day-5 replay → T3; `rule_offers`/`rule_reactions` migration + unknown-`rule_id`-refused-at-insert → T4; tally (latest-wins, removal, resurrect, re-add, cutoff predicate/delayed tick, one vote, no votes, lowest-id tie) → T5; both ingest branch points, own roster lookup, self-approval bypass, unmapped-numeral drop, reachability → T6; offer message, numbered candidates, seeded auditable draw, `needs` filter, claim-then-post with the honest orphan-window semantics and supersession copy, re-posted-message votes count → T7 (+T4's ledger); freeze into `ctx.rules`, rerun replays frozen selection, backfill `rules: []`, recap names the winner with the Truce moves-still-run copy → T8; bounded-swing gate (10k/arm, pinned seeds, empirical paired SE + CI, 3-point reject, stress-not-proof caveat) + vote-dynamics arm → T9; kill criterion recorded → T10. Spec tests 9 and 11 map to T4–T8 and T9 respectively; tests 1–8, 10, 12–16 shipped with the core plan.
- **Deliberately out of scope:** Blackout and Amnesty stay cut (spec); no web-app rule surface (the spec's web sweep was module gating, already shipped); no `Policy` voting strategies (plan decision 6).
- **Placeholder scan:** the four test-step comment blocks enumerate exact assertions rather than code because they extend existing test files whose helpers they must reuse — each names the behavior, the fixture, and the expected outcome. No TBDs.
- **Type consistency:** `validateRules(enabled, registry): Rule[]` (T1) is what T3 calls; `RuleOfferRow`/`RuleReactionRow`/`RuleVoteStore` (T4) are the names T5–T8 consume; `tallyRuleVote`/`dailyRuleSelection` (T5) match T8's tick usage; `Poster.post → Promise<string | undefined>` (T7) matches `recordOfferMessage(…, ts)`; `eligibleRules(modules, catalogue?)` (T2) matches T7's call; `RecapInput.ruleIds` (T8) matches `postRecapFor`'s spread.
