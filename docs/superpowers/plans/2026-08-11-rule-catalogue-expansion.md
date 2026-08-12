# Rule Catalogue Expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the ten rules designed in
`docs/superpowers/specs/2026-08-11-rule-catalogue-expansion-design.md`, cut the
daily ballot to three, make the gate's baseline reusable, and re-run the voted
arm — which is the measurement that decides whether the catalogue is shippable.

**Architecture:** Ten pure `Rule` objects in `src/engine/rules/`, registered in
the existing catalogue. No engine change, no migration, no store change, no
`TickEvent` change, no golden regeneration. One constant in `publish-rules.ts`.
One refactor in `src/sim/rule-gate.ts`.

**Tech Stack:** TypeScript via tsx (no build), vitest, `node:sqlite`.

## Global Constraints

- `src/engine/` is pure: no I/O, no clock, no `Math.random`, no `Date.now()`, no `new Date(` — enforced by `src/engine/types.test.ts`, which already walks `src/engine/rules/`.
- Every hook is a pure function of its arguments; input state is never mutated.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on.
- **Rule ids are permanent.** They are frozen into `tick_context.context.rules` and logged as `grant.source`. `boom`, `attrition` and `truce` keep their ids forever; only display text may change.
- **`description` must be 1..`RULE_DESCRIPTION_MAX_CHARS` (100)** — `buildCatalogue` throws outside that. `name` is capped at `RECAP_NAME_MAX_CHARS` (40) by the render sinks.
- **Copy rule: the joke may not cost the mechanic.** Every description states what the rule does, in the same sentence or the one before the punchline. The ballot is how players learn what they are voting for.
- The golden file must NOT move. If it does, stop and diagnose.
- Commit after every green test cycle; `npm test` and `npm run typecheck` pass at every commit.

---

### Task 1: The four grant rules

**Files:**
- Create: `src/engine/rules/underdog.ts`, `tribute.ts`, `touch-grass.ts`, `conscription.ts`
- Test: `src/engine/rules/grants.test.ts`

**Interfaces:**
- Consumes: `Rule` from `../mechanics.js`; `territoriesOf` from `../setup.js`.
- Produces: `underdogRule`, `tributeRule`, `touchGrassRule`, `conscriptionRule` — ids `underdog`, `eat-the-rich`, `touch-grass`, `bring-a-friend`.

All four share one shape: iterate `state.factions` id-sorted, skip factions with
zero territories (mirroring core income's own skip), emit
`{faction, amount, event: {t:"grant", source: <id>, faction, amount}}`.

- [ ] **Step 1: Write the failing tests** in `src/engine/rules/grants.test.ts`, reusing the `ctx()`/`dealt()` helpers from `rules.test.ts` (copy them; the files are siblings):

```ts
// underdog: only the minimum-territory faction(s) are paid, and EVERY tie is paid.
// Build a state where f1 holds 1 territory and f2 holds the rest → only f1 paid 3.
// Then an all-equal state → every faction paid (all are tied at the minimum).
// eat-the-rich: the max-territory faction is NOT paid and everyone else gets 2.
// All-equal state → NOBODY paid (no leader to tax), asserted explicitly.
// touch-grass: state.log carrying {t:"attack", attacker:"f1", ...} → f1 unpaid, f2 paid 3.
// An EMPTY log (day 1) pays everyone — asserted, since it is the season's first tick.
// bring-a-friend: every surviving faction paid 3; a zero-territory faction is skipped.
// All four: no faction with 0 territories ever appears in the output.
```

- [ ] **Step 2: Run to verify failure** — `npm test -- src/engine/rules/grants.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement.** Template — `underdog.ts` in full, the other three follow it:

```ts
import { territoriesOf } from "../setup.js"
import type { Rule } from "../mechanics.js"

/**
 * The smallest surviving faction(s) are paid. Every tie is paid, not just the
 * first — an arbitrary tiebreak here would hand one player troops for sorting
 * lower, which is a rule nobody could reason about.
 */
export const underdogRule: Rule = {
  id: "underdog",
  name: "Participation Trophy",
  description: "The smallest factions each gain 3 troops. Everyone's a winner. Some less so.",
  grant(state) {
    const counts = new Map<string, number>()
    for (const f of state.factions) counts.set(f.id, territoriesOf(state, f.id).length)
    const alive = [...counts.entries()].filter(([, n]) => n > 0)
    if (alive.length === 0) return []
    const min = Math.min(...alive.map(([, n]) => n))
    return alive
      .filter(([, n]) => n === min)
      .map(([faction]) => faction)
      .sort()
      .map((faction) => ({
        faction,
        amount: 3,
        event: { t: "grant" as const, source: "underdog", faction, amount: 3 },
      }))
  },
}
```

`tribute.ts` — id `eat-the-rich`, name `Eat the Rich`, description
`"Everyone except the leader gains 2 troops. The leader gains perspective."`:
same shape, but `max` instead of `min`, and it pays the factions **not** at the
max. When every surviving faction ties, the payable set is empty and the rule
is a deliberate no-op — comment that, or a reader will "fix" it.

`touch-grass.ts` — id `touch-grass`, name `Touch Grass`, description
`"Didn't attack yesterday? Gain 3 troops. Violence was never the answer."`:

```ts
  grant(state) {
    // state.log on entry is YESTERDAY's log — the tick that produced this
    // state. An empty log means day 1, so everyone qualifies, which is
    // correct rather than an edge case to suppress.
    const attacked = new Set(
      state.log.flatMap((e) => (e.t === "attack" ? [e.attacker] : [])),
    )
    // …pay every surviving faction not in `attacked`, amount 3
  }
```

`conscription.ts` — id `bring-a-friend`, name `Bring a Friend`, description
`"Every surviving faction gains 3 troops. No cover charge, no guest pass."`:
pays every faction with at least one territory.

- [ ] **Step 4: Run** — `npm test -- src/engine` → PASS, golden included and unmoved. `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(engine): four grant rules — Participation Trophy, Eat the Rich, Touch Grass, Bring a Friend"`

---

### Task 2: The four lock rules

**Files:**
- Create: `src/engine/rules/sole-survivor.ts`, `regional-manager.ts`, `fortress.ts`, `main-character.ts`
- Test: `src/engine/rules/locks.test.ts`

**Interfaces:**
- Produces: `soleSurvivorRule`, `regionalManagerRule`, `fortressRule`, `mainCharacterRule` — ids `sole-survivor`, `regional-manager`, `too-big-to-fail`, `main-character`.

Event policy, per the design: the first three can lock many territories and so
supply **no** per-territory events (the recap names the rule). `main-character`
locks exactly one and supplies its `protected` event.

- [ ] **Step 1: Write the failing tests** in `src/engine/rules/locks.test.ts`:

```ts
// sole-survivor: garrisons {a:1, b:2} → locks a only; supplies no events.
// THE TIMING TEST, through resolve() not the hook: a territory at 1 troop that
// receives a deploy this tick is NOT protected — lock runs after allocation.
// Assert via a full resolve: attack into a deployed-into 1-troop territory is
// NOT rejected as "protected", while an attack into an untouched one IS.
// regional-manager: a map where region A has 2 owners and region B has 1 →
// every territory of A locked, none of B; region-id tiebreak on an even split.
// too-big-to-fail: per faction, only the single largest garrison locked;
// territory-id tiebreak when a faction's two largest are equal.
// main-character: orders attacking t1 twice and t2 once → t1 locked, exactly
// one `protected` event with territory t1; territory-id tiebreak on a tie.
// A day with NO attacks locks nothing and logs nothing.
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement.**

```ts
// main-character.ts — the one that reads today's orders. `lock` receives
// them; `grant` does not, which is why this rule is a lock and not a grant.
export const mainCharacterRule: Rule = {
  id: "main-character",
  name: "Main Character Energy",
  description: "Today's most-attacked territory is protected. Fame has its perks.",
  lock(_state, orders) {
    const counts = new Map<string, number>()
    for (const o of orders) {
      for (const a of o.attacks) counts.set(a.to, (counts.get(a.to) ?? 0) + 1)
    }
    if (counts.size === 0) return []
    const most = Math.max(...counts.values())
    const territory = [...counts.entries()]
      .filter(([, n]) => n === most)
      .map(([t]) => t)
      .sort()[0]!
    return [{ territory, event: { t: "protected", territory, byCount: most } }]
  },
}
```

`sole-survivor.ts` — id `sole-survivor`, name `Sole Survivor`, description
`"A territory down to exactly one troop cannot be attacked. Have a heart."`:
returns `{territory}` (no event) for every territory whose garrison is exactly
1. **Comment the timing**: garrisons here are post-allocation, so deploying
into a sanctuary forfeits it — deliberate, and the kind of thing a later
reader mistakes for a bug.

`regional-manager.ts` — id `regional-manager`, name `Regional Manager`,
description `"The most contested region is closed to attacks. Middle management has spoken."`:
group `state.map.territories` by `.region`, count distinct owners per region,
take the max with region-id tiebreak, return that region's territories with no
events.

`fortress.ts` — id `too-big-to-fail`, name `Too Big to Fail`, description
`"Every faction's largest garrison is untouchable. Systemically important troops."`:
per faction (id-sorted), the owned territory with the highest garrison,
territory-id tiebreak; no events.

- [ ] **Step 4: Run** `npm test -- src/engine` → PASS. **Step 5: Commit** — `git commit -m "feat(engine): four lock rules — Sole Survivor, Regional Manager, Too Big to Fail, Main Character Energy"`

---

### Task 3: The two module-gated rules, and registration

**Files:**
- Create: `src/engine/rules/gains.ts`, `diamond-hands.ts`
- Modify: `src/engine/rules/index.ts` (register all ten; retitle the shipped three)
- Modify: `src/engine/rules/rules.test.ts` (the `needs` test gets real consumers)
- Modify: `src/slack/recap.test.ts` (the Truce copy assertion)

**Interfaces:**
- Produces: `gainsRule` (id `gains`, `needs: ["irl"]`), `diamondHandsRule` (id `diamond-hands`, `needs: ["markets"]`).

- [ ] **Step 1: Write the failing tests.** In `rules.test.ts`, replace the synthetic-rule `needs` test with the real ones: `eligibleRules(["markets","veto"])` excludes `gains`; `eligibleRules(["irl"])` excludes `diamond-hands`; `eligibleRules(["markets","irl","veto"])` includes both. Add: every catalogue entry's `description.length <= RULE_DESCRIPTION_MAX_CHARS` and `name.length <= 40`, asserted across `RULE_CATALOGUE` so a future witty entry cannot silently overflow the ballot.

- [ ] **Step 2: Implement the two rules.**

```ts
// gains.ts — the first consumer of `needs`. With irl off this rule is never
// OFFERED, rather than offered and inert.
export const gainsRule: Rule = {
  id: "gains",
  name: "Gains",
  description: "Posted a workout? Gain 2 troops. Actual gains, for once.",
  needs: ["irl"],
  grant(state, ctx) {
    const posted = new Set(ctx.postedToday)
    return state.factions
      .map((f) => f.id)
      .sort()
      .filter((faction) => posted.has(faction))
      .map((faction) => ({
        faction,
        amount: 2,
        event: { t: "grant" as const, source: "gains", faction, amount: 2 },
      }))
  },
}
```

`diamond-hands.ts` — id `diamond-hands`, name `Diamond Hands`, description
`"Everyone holding a live wager gains 1 troop. Paid for having the stomach."`,
`needs: ["markets"]`. Reads `pendingWagersOf(state)` from
`../modules/markets.js` — the markets module's exported helper, which the
pluggable-mechanics spec explicitly permits calling from anywhere. Pays 1 to
each faction holding at least one pending wager.

- [ ] **Step 3: Register and retitle** in `rules/index.ts`. `RULE_CATALOGUE` becomes all thirteen. **Ids of the shipped three are unchanged** — they are frozen in `tick_context`. Their display text is not, and gets the same treatment as the new ten:

| id (frozen) | name | description |
|---|---|---|
| `boom` | Quantitative Easing | `Territory income is doubled today. Thank the central bank.` |
| `attrition` | Leg Day | `Attacks cost one extra troop today. Feel the burn.` |
| `truce` | Log Off | `No attacks land today. Moves and deploys still run. Go outside.` |

Truce's description **must** keep "Moves and deploys still run" — the spec
requires the copy not promise that nothing moved.

- [ ] **Step 4: Fix the one downstream copy assertion** in `src/slack/recap.test.ts` ("Rule in force: Truce — …" becomes the new copy). Run `npm test` → PASS, golden unmoved.
- [ ] **Step 5: Commit** — `git commit -m "feat(engine): Gains and Diamond Hands exercise needs; the catalogue gets a sense of humor"`

---

### Task 4: The three-slot ballot

**Files:**
- Modify: `src/jobs/publish-rules.ts`
- Modify: `src/jobs/publish-rules.test.ts`

- [ ] **Step 1: Write the failing test**: with all thirteen rules eligible, an offer holds exactly 3 rows with ordinals 1..3; the draw is deterministic for a (season seed, day) pair; two different days draw different sets (assert not-equal on at least one of several days, so the test is not seed-luck dependent); a recovery re-post replays the STORED draw rather than redrawing.

- [ ] **Step 2: Implement.** In `publish-rules.ts`, add beside the existing constants:

```ts
/**
 * Ballot size. Three, not "every eligible rule": with a catalogue this size a
 * nine-option ballot decides most days by one or two votes with ties falling
 * to the lowest rule id, and truncates the rest away entirely. Three against
 * ~8 voters produces real pluralities, and rule scarcity becomes its own
 * strategic event. Also the balance lever — each rule then wins ~1/13 of days
 * instead of ~1/3.
 */
export const RULES_PER_OFFER = 3
```

and replace `.slice(0, 9)` with `.slice(0, RULES_PER_OFFER)`.

- [ ] **Step 3: Run** `npm test -- src/jobs` → PASS. **Step 4: Commit** — `git commit -m "feat(jobs): a three-slot ballot — the catalogue outgrew the numeral alphabet"`

---

### Task 5: Reusable baseline in the gate

**Files:**
- Modify: `src/sim/rule-gate.ts`
- Modify: `src/sim/run.test.ts`

- [ ] **Step 1: Write the failing test**: `runRuleGate` and the cached path return identical `GateResult`s at N=20 — the refactor is behavior-preserving, and the seeds make that an equality assertion, not an approximation.

- [ ] **Step 2: Implement.** Extract the baseline sweep into
`baselineWinners(policyNames, seasons): (string|undefined)[]` (index = seed−1,
value = winning policy), computed once and passed into `runGate`. Fourteen arms
then cost fifteen sweeps rather than twenty-eight. The `main` block computes it
once before the loop.

- [ ] **Step 3: Run** `npm test -- src/sim` → PASS. **Step 4: Commit** — `git commit -m "perf(sim): compute the gate's baseline once instead of once per arm"`

---

### Task 6: The gate run and the verdict

**Files:**
- Create: `docs/superpowers/reviews/2026-08-12-balance-run-rules-expanded.md`
- Modify: `CLAUDE.md`, `HANDOFF.md` (docs table + the "Not built" balance entry)

- [ ] **Step 1: Smoke** — `npm run sim:rules -- 200`, confirm fourteen arms print and nothing throws.
- [ ] **Step 2: The committed run** — `npm run sim:rules` at 10,000 per arm.
- [ ] **Step 3: Read the VOTED arm first.** It is the verdict; the forced arms are diagnostics (a per-rule forced pass cannot clear a catalogue — Blitz's voted movement exceeded every forced arm in the previous run). **Pass = every policy within 3 points in the voted arm.**
- [ ] **Step 4: If the voted arm fails**, cut `truce` from `RULE_CATALOGUE` (keep the file and its id, so frozen history still renders) and re-run. That fallback is the spec's, decided in advance.
- [ ] **Step 5: Write the review doc** — same shape as `2026-08-11-balance-run-rules.md`: method, the paired empirical SE and CI, both arm families, findings, verdict, limitations. It **supersedes** the 2026-08-11 rules run; mark that one superseded in the docs table.
- [ ] **Step 6: Update `CLAUDE.md` and `HANDOFF.md`** to the new verdict — if it passes, the "catalogue fails its own gate" entry is deleted rather than softened.
- [ ] **Step 7: Commit** — `git commit -m "docs(balance): the expanded catalogue's gate run"`

---

## Self-review (performed)

- **Spec coverage:** ten rules → T1–T3; `needs` with real consumers → T3; ballot → T4; baseline caching → T5; voted-arm verdict, the Truce fallback, and the superseding review doc → T6. The design's "what this breaks" list (superseded balance doc, offer shape) is T4 and T6.
- **Placeholders:** none. Every rule names its id, display copy, hook, tiebreak and edge case; the three test steps enumerate exact assertions against named fixtures.
- **Type consistency:** every rule is a `Rule` with the existing hook signatures; `RULES_PER_OFFER` (T4) is the name T4's test imports; `baselineWinners` (T5) is the only new function and is internal to the gate.
- **Deliberately not here:** any engine change, migration, store change, `TickEvent` change, or golden regeneration. If a task seems to need one, the design was wrong — stop.
