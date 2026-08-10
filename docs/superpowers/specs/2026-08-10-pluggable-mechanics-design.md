# Riskety Rekt — Pluggable Mechanics Design

**Date:** 2026-08-10
**Status:** Draft — not yet reviewed
**Extends** `2026-08-09-riskety-rekt-design.md`. Depends on the tick-runner spec's
`tick_context`.

## Overview

Two mechanics — prediction-market wagers and Slack-submitted real-world actions —
are currently woven through the engine's seven-step pipeline. This spec makes them
**modules a season enables**, and uses the same machinery for a **daily rule
catalogue** the group votes on.

They are one abstraction, not two: a capability declared as data, frozen per tick,
and dispatched through fixed hooks. The only difference is scope — `modules` is
season-scoped and stable, `rules` is day-scoped and voted.

## Why

Three reasons, in order of weight:

1. **The game should be playable without either mechanic.** A season with markets
   off is plain deterministic Risk with an accountability channel; with IRL off it
   is Risk plus prediction markets. Both are coherent games, and neither is
   reachable today without editing the engine.
2. **The rule-vote idea needs exactly this plumbing.** "Double income today" and
   "attacks cost one extra troop today" are hook implementations with a one-day
   lifetime. Building the vote system without the module system would produce two
   dispatch paths that drift.
3. **It gives the deploy-inflation exploit a principled home.** That bug is an
   accident of claim ordering between two spenders (see "Spend priority").

## What is entangled today

| Surface | markets | irl | veto |
|---|---|---|---|
| `DailyContext` | `slate`, `settlements` | `approvals`, `postedToday` | reads `postedToday` |
| `resolve()` step | 1 (settle), 5 (escrow) | 2 (grants) | 6a |
| `GameState` | `pending[]` | — | — |
| `Order` | `wagers[]` | — | `protect` |
| `TickEvent` | `wagerSettle` | `irl` | `protected` |

Core Risk — territory income, deploys, attacks, combat, elimination — touches none
of it.

**The veto is its own module, not part of `irl`.** It is a core-feeling mechanic
whose *gate* belongs to IRL: `combat.ts` requires `posted.has(factionId) &&
territoriesOf(state, factionId).length === 0`. With IRL off it would either fire
ungated for every eliminated faction — strictly stronger than designed and never
balanced — or vanish silently, removing the kingmaker role. Making it a third
module forces the choice to be explicit. `veto` declares a dependency on `irl`.

## The hook interface

```ts
type ModuleId = string
type RuleId = string

interface Contribution {
  faction: FactionId
  amount: number
  event: TickEvent
}

interface SpendClaim extends Contribution {
  /**
   * When this commitment became irrevocable, as an ISO instant. Claims are
   * honored in ascending order — see "Spend priority". A deploy locks at the
   * 21:00 tick; a wager locks at its market's close, which is earlier.
   */
  lockedAt: string
}

interface Mechanic {
  id: ModuleId | RuleId
  /** Module ids this one requires. `veto` requires `irl`. */
  requires?: ModuleId[]

  /** Steps 1–3: soldiers into a faction's reserve. */
  grant?(state: GameState, ctx: DailyContext): Contribution[]
  /** Step 5: soldiers out of a reserve into mechanic-owned escrow. */
  spend?(state: GameState, orders: Order[], ctx: DailyContext): SpendClaim[]
  /** Step 6a: territories no attack may enter this tick. */
  lock?(state: GameState, orders: Order[], ctx: DailyContext): TerritoryId[]
  /** Order-shape rules this mechanic owns, run alongside core validation. */
  validate?(state: GameState, order: Order, ctx: DailyContext): Rejection[]
  /** Step 6: bounded combat dials; see "Combat dials". */
  combatDials?(state: GameState, ctx: DailyContext): Partial<CombatDials>
  /** Cross-tick state this mechanic owns; see "Module state". */
  advance?(state: GameState, ctx: DailyContext): unknown
}
```

Every hook is a **pure function of its arguments**. None may read a clock, call
`Math.random`, perform I/O, or mutate its inputs — the same rules `resolve` already
lives under, enforced by `src/engine/types.test.ts`.

## Where hooks fire

The pipeline's step order is **fixed** and mechanics never reorder it:

```
1–3  grant    core territory income, then every active grant hook
     validate core aggregate constraints, then every validate hook
4    deploys  (a core spend claim, lockedAt = the 21:00 tick instant)
5    spend    every spend claim, honored in ascending lockedAt
6a   lock     union of every lock hook
6b–d         field battles and attacks — core, parameterized by the merged dials
7    advance  each mechanic updates its own state
```

**This is the load-bearing constraint.** A mechanic that could reorder steps would
destroy `resolve`'s determinism and make the golden file meaningless. Contributing
at fixed points keeps replay exact regardless of which mechanics are active.

Within a hook, mechanics run **sorted by id**, so the event log is deterministic.

## Conflict rules

**`grant` — sum.** Addition is commutative, so only the log order needs pinning,
which the id sort provides.

**`lock` — union across mechanics; parity stays internal.** The veto's parity rule
(`count(picks on t) % 2 === 1`) is its own business; it returns the territories that
survived its parity count, and the engine unions the results. Two mechanics locking
the same territory is idempotent, not a double-lock.

**`spend` — ascending `lockedAt`, and this is where the exploit dies.**

Today deploys are budgeted first and wagers get the remainder
(`src/engine/validate.ts:41,106`), so inflating deploys at 20:59 drops an
already-locked wager and the stake never leaves the reserve — a free withdrawal
hours after the outcome is public, and selectable, because the check is
sequential-greedy.

Honoring claims in ascending `lockedAt` inverts that: **the commitment that became
irrevocable first is senior.** A wager locked at its market's 16:00 close outranks a
deploy locked at 21:00, so a short reserve drops the deploy, not the wager. Within
one `lockedAt`, ties break on mechanic id then the claim's index — never on
submission time, which the player controls.

This is the whole fix for that exploit, and it falls out of the abstraction rather
than being bolted on. **It changes combat outcomes** (a dropped deploy is troops
that never reach the map), so it requires a fresh balance run.

## Module state

`GameState.pending` is markets-shaped data sitting in core state. It moves:

```ts
interface GameState {
  seasonId, day, map, factions, ownership, garrisons, reserves, log, engineVersion
  moduleState: Record<ModuleId, unknown>   // replaces `pending`
}
```

Each mechanic owns the shape under its own key and is the only reader or writer of
it. `markets` stores `{ pending: PendingWager[] }`; `irl` and `veto` store nothing.
The engine treats the values as opaque and passes them through.

**Cost, stated plainly:** this is the most invasive part of the spec. It changes
`GameState`, so the golden file regenerates, and every state literal in the tests
that mentions `pending` is touched. The alternative — leaving `pending` in core —
was rejected because the next stateful mechanic needs the same exception, and a
season with markets off would carry a permanently empty field that core code still
has to reason about.

## Season-one mechanics

| id | hooks | state | requires |
|---|---|---|---|
| `markets` | `grant` (settlement payouts), `spend` (escrow), `validate` (one wager per market, slate membership), `advance` (mature/refund pending) | `{ pending }` | — |
| `irl` | `grant` (actions + timing bonuses) | — | — |
| `veto` | `lock` (parity over eliminated posters), `validate` (`protect` legality) | — | `irl` |

Core keeps territory income, deploys, attacks, combat, elimination and the
season-end check. Nothing in core mentions a wager or a workout after this change.

## The rule catalogue

A rule is a mechanic with a one-day lifetime, a `name` and a `description` for
display, and the same hook surface.

```ts
interface Rule extends Mechanic {
  id: RuleId
  name: string          // shown in the vote and the recap
  description: string   // one line, plain text, capped like any player-facing text
}
```

**Season one ships a deliberately restricted catalogue: flat, single-tick effects
whose swing has been measured.** Examples: *Boom* (income doubled today, a `grant`),
*Attrition* (attacks cost one extra troop, a dial), *Blackout* (no wagers today, a
`validate`), *Truce* (no attacks today, a `lock`), *Amnesty* (eliminated factions
may deploy once, a `validate`).

Note that "single-tick" describes the *effect*, not the consequence: *Boom*'s
soldiers exist tomorrow and a territory taken under *Attrition* stays taken. No
rule that does anything is reversible in consequence, which is why the gate is
measured swing rather than reversibility — see "Replacing the reversibility test".

### Voting

Voting reuses the Slack ingest wholesale. The bot posts the day's candidates as one
message with a numbered list; players react; the tally at the 21:00 cutoff selects
the winner. That is the same machinery as workout approval — `posts`, `reactions`,
emoji normalization, the `slack_events` dedupe ledger — with a different message
author and a different tally.

- Candidates are drawn deterministically from the catalogue by seeded shuffle, the
  seed stored per day, so the offer is auditable.
- Ties break on the lowest `RuleId`. A day with no votes selects nothing.
- The tally reads Slack timestamps, never database write time, exactly as
  `dailyApprovals` does — a reaction at 20:59:59 delivered at 21:00:01 counts.
- A player may vote for one candidate; a second reaction from the same player on a
  different candidate is a change of vote, not a second vote.

## Freezing

`DailyContext` gains two fields:

```ts
interface DailyContext {
  slate, approvals, postedToday, settlements   // existing
  modules: ModuleId[]
  rules: RuleId[]
}
```

Both are **frozen into `tick_context`** by the tick's transaction, alongside the
rest of the context. This is not optional: a rule voted in on day 5 changes how day
5 resolves, so a rerun that re-read the current catalogue would replay a different
game. The tick-runner spec already records the context for exactly this class of
reason.

`modules` is stored on the season row and copied into each day's context, so a
mid-season module change is visible in the record rather than retroactive.

## Storage

Migration 4:

```sql
ALTER TABLE seasons ADD COLUMN modules TEXT NOT NULL DEFAULT '["markets","irl","veto"]';

-- One row per day per candidate offered, so the offer is reconstructable.
CREATE TABLE rule_offers (
  season_id TEXT NOT NULL,
  day       INTEGER NOT NULL CHECK (day >= 1),
  rule_id   TEXT NOT NULL,
  message_ts TEXT NOT NULL,          -- the Slack post the votes react to
  PRIMARY KEY (season_id, day, rule_id)
);

-- One row per (day, voter). The primary key is the one-vote-per-player rule.
CREATE TABLE rule_votes (
  season_id  TEXT NOT NULL,
  day        INTEGER NOT NULL,
  faction_id TEXT NOT NULL,
  rule_id    TEXT NOT NULL,
  voted_at   TEXT NOT NULL,          -- ISO, from the Slack event_ts
  PRIMARY KEY (season_id, day, faction_id)
);
```

`tick_context.context` already carries the whole `DailyContext` as JSON, so
`modules` and `rules` need no column of their own.

## What this breaks

**The balance model.** Every number this project has assumes one fixed rule set.
A game whose rules change mid-season cannot be summarized by a single simulation
run. Two consequences:

- The simulator takes a module set and a rule policy as arguments, and the
  committed balance run covers the season-one module set with rules **off**.
- The catalogue is restricted to reversible single-tick effects precisely so that
  no rule can move the season's trajectory beyond one day. A compounding rule would
  make the balance run unreproducible in principle, not just in practice.

**The golden file.** `GameState` changes shape, so it regenerates. Regenerate
deliberately and read the diff — the tick-runner review found the current golden
season never exercises protections, so it will not catch a `veto` regression.
Extend the scripted season to eliminate a faction before trusting it here.

**The spend reordering changes combat outcomes.** A deploy dropped in favour of a
senior wager is troops that never reach the map. The balance run must be redone,
not merely re-checked.

## Testing

1. **A season with no modules resolves.** Plain Risk: income, deploys, attacks,
   combat. No `wagerSettle`, no `irl`, no `protected` events; `moduleState` is `{}`.
2. **Each module in isolation.** `markets` only; `irl` only; `irl` + `veto`.
3. **`veto` without `irl` is refused at season-init** — the dependency is declared
   and checked, not discovered at tick time.
4. **Hook determinism.** The same state, orders and context produce byte-identical
   output regardless of the order mechanics appear in the configured list.
5. **Spend priority.** A deploy submitted at 20:59 cannot drop a wager locked at
   16:00 — the regression test for the exploit this reordering fixes. And two
   claims with equal `lockedAt` break on mechanic id, not on submission order.
6. **Lock union.** Two mechanics locking one territory lock it once. The veto's
   parity still cancels *within* the veto.
7. **Freezing.** A rule voted on day 5 replays on day 5 after the catalogue
   changes; a module disabled on day 6 does not retroactively alter day 5.
8. **Voting.** One vote per player; a second reaction is a change of vote; a
   reaction at 20:59:59 delivered late still counts; a day with no votes selects
   nothing; ties break on lowest `RuleId`.
9. **Every catalogue rule has bounded swing.** Run the committed balance suite
   with each rule forced active *every* day and reject any that moves a policy's
   win rate by more than 3 points against the no-rules baseline. Forcing it daily
   is harsher than the real once-per-day vote, so passing there is sufficient.
   (The draft's "diverge then reconverge by day N+1" test was unsatisfiable — see
   "Replacing the reversibility test".)
10. **Conservation survives the dials.** `attackDepartureCost` troops are logged as
    casualties, so `in = out + casualties` holds exactly at every dial setting. And
    the invariant's `created` term is derived from returned `Contribution[]` rather
    than a hard-coded event-type switch — otherwise a new module's grant makes the
    test fail on legitimate soldiers.

## Deltas against the original design

| Original spec | This design | Why |
|---|---|---|
| the pipeline hard-codes wagers and IRL | both become modules dispatched through hooks | a season should be playable without either, and the rule catalogue needs the same dispatch |
| `GameState.pending` | `GameState.moduleState[markets].pending` | core state should not carry one mechanic's data |
| the veto lives inside the IRL mechanic | `veto` is its own module, `requires: ["irl"]` | with IRL off the veto would silently either fire ungated or vanish |
| deploys are budgeted before wagers | spend claims are honored in ascending `lockedAt` | the earlier-locked commitment is senior; this is the fix for the deploy-inflation exploit |
| — | a voted daily rule catalogue | new mechanic, gated on measured swing rather than argued smallness |
| combat arithmetic is fixed | two flat dials (`attackDepartureCost`, `tieGoesToAttacker`) | *Attrition* fits no other hook; flat dials do not scale with army size, so the 1:1 anti-snowball brake survives |

## Open questions

- **Does a rule need a `spend` hook at all?** Every catalogue rule drafted so far
  is a `grant` or a combat modifier. If none needs `spend`, the rule interface can
  be narrower than the module interface, which simplifies the priority story.
- **How does a mid-season module change interact with `moduleState`?** Disabling
  `markets` on day 6 leaves escrowed wagers in `moduleState`. Refund at disable, or
  refuse to disable while state is non-empty? The latter is simpler and probably
  right.
- **Does a mid-season module change need a migration path?** Disabling `markets`
  on day 6 leaves escrowed wagers in `moduleState` — see above.

## Combat dials — the fifth hook

*Attrition* ("attacks cost one extra troop today") fits none of the four hooks:
it is not a grant, not a reserve spend, not a lock, and `validate` returns
rejections rather than mutating an order. Combat needs a hook or the catalogue is
restricted to soldier-flow and locks.

It gets one, deliberately narrow.

### What the conservation invariant actually protects

The engine's troop-conservation property (`src/engine/invariants.test.ts:69-92`) is
**one-sided**:

```ts
// Casualties are the only sink, so the total can only fall short.
expect(totalOf(next)).toBeLessThanOrEqual(totalOf(before) + created)
```

It catches soldiers being *created* and says nothing about soldiers being
destroyed. So a defender bonus or a casualty-ratio dial would **not** trip it —
they only ever destroy more. The invariant is not the reason to refuse them.

Two real consequences for this spec, both of which must be fixed regardless of the
dial question:

- `created` hard-codes the soldier-creating event types (`income`, `irl`,
  `wagerSettle`). Under arbitrary `grant` hooks that list is wrong by construction:
  a new module's grant would make the test fail on legitimate soldiers. `created`
  must be derived from the returned `Contribution[]`, not from a switch on event
  type.
- `totalOf` reads `s.pending` directly, which `moduleState` removes. Each module
  contributes its own escrowed total.

### The real objection to multiplicative dials

The design spec makes the 1:1 loss ratio load-bearing: *"the primary brake on
snowballing: taking ground is expensive, so a leader cannot cheaply convert an
advantage into a runaway."* A `casualtyRatio` dial does not break correctness — it
disables that brake for a day.

The discriminator is **whether a dial's effect scales with the acting faction's
existing advantage**:

| Dial | Effect | Scales with army size? |
|---|---|---|
| `attackDepartureCost` | flat, per attack order | no — bounded by attack count |
| `tieGoesToAttacker` | a tie-break | no |
| `defenderBonus` | flat per territory | no, but see below |
| `casualtyRatio` | multiplies the value of every attack | **yes** |

A multiplicative dial pays the leader most, because the leader has the most troops
to multiply. That is precisely the runaway the design is built to prevent, and it
is why the catalogue takes flat dials only.

`defenderBonus` is excluded on a second ground: casualties are allocated as
*exactly* `D` by largest-remainder (a worked example in the design spec depends on
it), so raising `D` above the defenders actually present makes that example
conditional and the allocation harder to reason about for no gain the other dials
do not already provide.

### The hook

```ts
/** Step 6. Every field defaults to the core value; omitted fields are unchanged. */
combatDials?(state: GameState, ctx: DailyContext): Partial<{
  /** Extra troops lost by each attack order at departure. >= 0. */
  attackDepartureCost: number
  /** On an exactly-equal field battle, the attacker continues instead of both dying. */
  tieGoesToAttacker: boolean
}>
```

Numeric dials **sum** across active mechanics and are then clamped to a stated
maximum; boolean dials **OR**. Both are order-independent, so the id sort is only
needed for the log.

`attackDepartureCost` is conservation-safe by construction: the extra troops leave
the origin garrison and are logged as casualties, so `in = out + casualties` still
holds exactly. It is charged **per attack order, at departure**, before field
battles — so it also raises the price of the multi-attack feint the design already
worries about.

**Explicitly not dials, now or later:** casualty ratios, defense bonuses, adjacency
changes, ownership changes, anything touching the largest-remainder allocation. A
rule wanting one of those is a rules-engine change, not a catalogue entry.

### Replacing the reversibility test

The draft's property test — *"a season with the rule on day N and one without it
diverge on day N and **reconverge** by day N+1"* — is unsatisfiable, and would have
rejected the whole catalogue. *Boom*'s soldiers exist on day 6; a territory taken
on an *Attrition* day stays taken. **No rule that does anything is reversible in
consequence.** That was a wrong criterion, not a strict one.

The criterion is **bounded swing**, gated empirically the way the rest of this
project's balance work is gated: run the committed balance suite with each rule
forced active every day, and reject any rule that moves a policy's win rate by more
than 3 points against the no-rules baseline. Forcing it every day is deliberately
harsher than a once-per-season vote, so a rule that passes at that intensity is
safe at the real one.

That gate is also what keeps the balance model tractable: rules stay in the
catalogue because they were measured, not because they were argued to be small.

## Blockers

This spec depends on the tick-runner spec's `tick_context` and should not be
implemented before it. It also **supersedes the wager-economy spec's ownership of
the deploy-inflation exploit** — that fix now lives here, in the spend-priority
rule. The stale-price exploit remains the wager spec's.
