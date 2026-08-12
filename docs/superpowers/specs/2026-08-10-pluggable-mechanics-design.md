# Riskety Rekt — Pluggable Mechanics Design

**Date:** 2026-08-10 · **Revised:** 2026-08-11 after a six-seat review panel
**Status:** Reviewed — unanimous APPROVED, 2026-08-11 (three rounds + verification; history in "Review history")
**Extends** `2026-08-09-riskety-rekt-design.md`. Depends on the tick-runner spec's
`tick_context`.

## Overview

Two mechanics — prediction-market wagers and Slack-submitted real-world actions —
are currently woven through the engine's seven-step pipeline. This spec makes them
**modules a season enables**, and uses the same machinery for a **daily rule
catalogue** the group votes on.

They are one abstraction, not two: a capability declared as data, frozen per tick,
and dispatched through fixed hooks. The only difference is scope — `modules` is
season-scoped configuration, `rules` is day-scoped and voted.

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
   accident of claim ordering between two spenders (see "The allocation phase").

## What is entangled today

| Surface | markets | irl | veto |
|---|---|---|---|
| `DailyContext` | `slate`, `settlements` | `approvals`, `postedToday` | reads `postedToday` |
| `resolve()` step | 1 (settle), 5 (escrow) | 2 (grants) | 6a |
| `GameState` | `pending[]` | — | — |
| `Order` | `wagers[]` | — | `protect` |
| `TickEvent` | `wagerSettle` | `irl` | `protected` |

Core Risk — territory income, deploys, **moves** (the reinforcement step that
landed 2026-08-11), attacks, combat, elimination — touches none of it.

**The veto is its own module, not part of `irl`.** It is a core-feeling mechanic
whose *gate* belongs to IRL: `combat.ts` requires `posted.has(factionId) &&
territoriesOf(state, factionId).length === 0`. With IRL off it would either fire
ungated for every eliminated faction — strictly stronger than designed and never
balanced — or vanish silently, removing the kingmaker role. Making it a third
module forces the choice to be explicit. The one module dependency in the
system — veto needs irl — is **hardcoded as a refusal in `season:init`**, not
expressed through a general `requires` field: a declared-dependency subsystem
for a single edge is machinery with one consumer. Generalize it the day a second
dependency exists. (Rules get a narrow `needs` field for *offer filtering* —
see the catalogue — which is a display-side filter, not a dependency system.)

## The hook interface

```ts
type ModuleId = string
type RuleId = string

/** JSON-serializable; the engine asserts a round-trip on every save. */
type ModuleStateValue = JsonValue

interface Contribution {
  faction: FactionId
  amount: number          // engine-validated: a non-negative integer
  event: TickEvent        // logged verbatim; see "Events"
}

interface SpendClaim extends Contribution {
  /**
   * When this commitment became irrevocable, as an ISO instant. Claims are
   * honored in ascending order of the PARSED epoch-millisecond value — never
   * string order — see "The allocation phase". A deploy locks at
   * `ctx.tickInstant`; a wager locks at its market's close, which the slate
   * publisher guarantees is earlier (see "lockedAt semantics").
   */
  lockedAt: string
  /** Identifies the order item this claim funds, for the rejection log. */
  ref: string
}

/** A locked territory, with an optional event the engine logs for it. */
interface LockResult {
  territory: TerritoryId
  event?: TickEvent       // veto supplies `protected` (with byCount);
                          // Truce omits it — see "Conflict rules"
}

interface Mechanic {
  id: ModuleId | RuleId

  /** Step 1: soldiers into a faction's reserve (incl. settlement payouts). */
  grant?(state: GameState, ctx: DailyContext): Contribution[]
  /** Step 2: claims against reserves, resolved in step 3. */
  spend?(state: GameState, orders: Order[], ctx: DailyContext): SpendClaim[]
  /** Order-shape rules this mechanic owns, run in step 2 alongside core checks. */
  validate?(state: GameState, order: Order, ctx: DailyContext): Rejection[]
  /** Step 4: territories no attack may enter this tick. */
  lock?(state: GameState, orders: Order[], ctx: DailyContext): LockResult[]
  /** Step 6: the one bounded combat dial; see "The combat dial". */
  combatDials?(state: GameState, ctx: DailyContext): Partial<CombatDials>
  /**
   * Step 7: returns this module's complete next state value, which REPLACES
   * `moduleState[id]`. Receives the validated orders and the subset of ITS OWN
   * claims that were honored in step 3 — without those it cannot append this
   * tick's escrow. A module without cross-tick state omits the hook and owns
   * no slot. A mechanic that implements `advance` MUST also implement
   * `escrowed` — asserted at season-init (see below for why the invariant
   * cannot police this itself).
   */
  advance?(state: GameState, orders: Order[], ctx: DailyContext,
           honored: SpendClaim[]): ModuleStateValue
  /**
   * How many soldiers currently sit in this module's escrow, given its own
   * state value. Feeds conservation accounting. Enforced by pairing: because
   * the shipped conservation check is one-sided (`<=`), a module that held
   * soldiers but omitted `escrowed` would make the total SMALLER and pass —
   * so the requirement is checked structurally at season-init
   * (`advance` present ⇒ `escrowed` present), and behaviorally by the new
   * two-sided accounting test (see "Events").
   */
  escrowed?(own: ModuleStateValue): number
}
```

Every hook is a **pure function of its arguments**. None may read a clock, call
`Math.random`, perform I/O, or mutate its inputs — the same rules `resolve`
already lives under. Mechanics live in `src/engine/modules/` and
`src/engine/rules/`, and `src/engine/types.test.ts` is extended to reach them —
which is two changes, not one: the directory scan recurses, **and the
import-boundary assertion changes shape**. Today it asserts every specifier
starts with `./`; a legitimate `../types.js` from a subdirectory would fail
that. The check becomes: resolve each specifier against the importing file's
directory and assert the result stays under `src/engine/` — **after first
rejecting any specifier that does not begin `./` or `../`**, because naive
resolution alone would *accept* a bare package import (`join("src/engine",
"lodash")` is under `src/engine/`), weakening the exact boundary the check
exists to hold. (The text-pattern scan is a tripwire, not a proof — it catches
the common impurities, and code review carries the rest, same as today.)

The engine validates what hooks return: `amount` must be a non-negative integer,
`faction` must exist, `lockedAt` must parse as an instant. A malformed return is
a thrown error — the tick refuses rather than resolving with corrupt claims.

The active registry is validated at season-init, **per namespace**: every id in
`season.modules` must be a registered *module* and every id the vote system can
select must be a registered *rule* — namespace non-collision alone would still
admit a rule id in `modules` or a module id in `rules`. Ids must be unique,
every `Rule.needs` entry must name a registered module (an unknown `needs`
refuses at catalogue load, rather than silently filtering the rule out of every
offer forever), veto-without-irl is refused, and `advance` ⇒ `escrowed` is
asserted.

One dispatch detail that is engine-internal but load-bearing: `SpendClaim`
carries no owner field. **The engine tags each claim with the mechanic that
returned it** as it collects hook results, and that internal tag — never
anything the claim itself asserts — is what drives the tie-break's "mechanic
id" and the routing of `honored` claims back to their owner's `advance`.

## Where hooks fire

The pipeline's step order is **fixed** and mechanics never reorder it:

```
1   grant     core territory income, then every active grant hook, ONCE —
              settlement payouts are part of the markets module's grant.
              One phase: a hook that ran in a separate "settle" step too
              would pay every settlement twice.
2   claims    order-shape validation (core + validate hooks) — including
              deploy legality (target owned), so an illegal deploy never
              produces a claim and cannot consume reserve — then the claim
              list: one core claim per deploy (lockedAt = ctx.tickInstant),
              plus every spend hook's claims
3   allocate  ALL claims sorted by parsed lockedAt ascending (ties: mechanic
              id, then claim index); honored against each faction's reserve;
              a claim that no longer fits is DROPPED with a `rejected` event.
              Honored deploy claims LAND here — troops leave the reserve and
              join their target garrisons at this step's end, which is what
              step 5 validates against
4   locks     union of every lock hook; attacks into locked territories are
              voided HERE — they consume no cap and no fee in step 5, and
              each voided attack logs a `rejected` event (ref, reason:
              "protected") so the attacker sees why the order vanished; the
              engine logs each LockResult's event
5   validate  attacks and moves, capped against garrisons AFTER the
              surviving deploys have landed; attacks merged by (from, to)
              before cap accounting; the dial's fee inside the cap
6   combat    reinforcements, field battles, attacks — parameterized by the
              merged dial
7   advance   each module returns its next state value, seeing its honored
              claims
```

**Why allocation happens before attack validation — this ordering is the fix.**
The original draft validated attacks early and dropped short claims late. Two
reviewers independently showed that cannot work: attack and move caps are
computed from post-deploy garrisons, so a deploy dropped *after* validation
leaves an attack legal for troops that never arrived — a garrison of 2 with a
dropped 10-troop deploy departs 11 troops into a battle, creating soldiers from
nothing. Seniority must resolve **before** any cap that depends on deploys is
computed. All claims are knowable at that point (spend hooks are pure functions
of state, orders and context), so nothing about the fix requires late
resolution.

**Why locks resolve before movement validation.** A voided attack never
departs, so it must not occupy cap capacity: with a dial fee active, a 1-troop
attack at a protected target would otherwise consume `1 + fee` of the origin's
cap and crowd out a valid attack that then gets rejected for nothing. Lock
hooks are pure functions of state, orders and context, so the union is
computable before step 5. This is a deliberate behavior change from today
(voided attacks currently do consume validation cap); the golden regeneration
and balance run cover it.

A dropped claim emits `{t:"rejected", faction, field, ref, reason:"reserve
short"}` — the same surface validation rejections use today, so the invariant
that every dropped item is logged holds unchanged, and the player sees exactly
which order lost. `ref` is a **new optional field** on the shipped `rejected`
variant (`ref?: string`): core validation's existing `reject()` call sites are
unchanged, allocation drops supply it, and the web renderer appends it when
present.

**Deploys are still validated after grants** — income earned this tick is
spendable this tick, unchanged from today. To be explicit about what moves
where: step 2's validation is **shape and legality only** (targets owned,
slate membership, one wager per market); the **aggregate reserve budgeting**
that `validate.ts:41,139` performs today moves entirely into step 3's
allocation. Spend hooks and core deploy claims are built from
already-shape-validated orders, and no reserve check outside the allocation
phase may preempt the cross-mechanic seniority ordering.

**Claim granularity is per order item** — for the allocation phase (deploys and
wagers), matching today's per-line-item greedy budgeting: a 1-troop shortfall
drops one deploy line, not a faction's whole set. Attack validation in step 5
is per **merged movement**, a different granularity for a different phase — see
"The combat dial" for why, and what a merged rejection names.

**The exploit, restated.** Today deploys are budgeted first and wagers get the
remainder (`src/engine/validate.ts:41,139`), so inflating deploys at 20:59 drops
an already-locked wager and the stake never leaves the reserve — a free
withdrawal hours after the outcome is public. Under ascending `lockedAt` the
commitment that became irrevocable first is senior: a wager locked at its
market's 16:00 close outranks a deploy locked at 21:00, so a short reserve drops
the deploy.

Within one instant, ties break on mechanic id then claim index. Note the
precise security claim: intra-faction claim order (a wager list's index follows
`first_staked_at`) is **self-allocation** — a player ordering their own claims
against their own reserve is not an attack surface. What blocks inter-temporal
games is the store's `stillOpen` gate (below), not the tie-break. (A production
slate wager can never actually tie a deploy — the publisher's strict close
window guarantees it — so the tie-break test needs a synthetic mechanic to be
falsifiable; see Testing. The `first_staked_at` comment in `sqlite.ts`, which
explains it as anchoring "the sequential-greedy reserve check", goes stale with
this change and is reworded as part of the sweep.)

**It changes combat outcomes** (a dropped deploy is troops that never reach the
map), so it requires a fresh balance run.

Within a hook, mechanics run **sorted by id**, so the event log is deterministic.

## lockedAt semantics

`DailyContext` gains `tickInstant: string` — the frozen ISO instant of the tick,
supplied by the runner and recorded in `tick_context` like every other context
field. The engine still contains no clock; time enters as an argument, per the
project's standing rule.

A wager's `lockedAt` is its market's slate `closeTime`. That is a deliberate
simplification of the store's true lock (`min(closeTime, observed_at)`): the
earlier `observed_at` lock only ever makes a wager *more* senior, and the
slate's `closeTime` is already frozen at 08:00, so using it alone cannot be
gamed — it can only under-credit seniority a wager already had.

Three legs make the seniority argument watertight, and all three are cited
because all three are load-bearing:

1. **The publisher window**: a slate market must close strictly before the
   21:00 order lock (`WINDOW_CLOSE_HOUR = 21` at `src/config.ts:62`; the strict
   `closeMs >= closesBefore` rejection at `src/adapters/kalshi/parse.ts:125`,
   with `closesBefore` built at `src/jobs/publish-slate.ts:62`). So every wager
   claim is strictly senior to every deploy claim.
2. **Parsed comparison** (below) — so the ordering is temporal, not lexical.
3. **The store's `stillOpen` gate** (`src/store/sqlite.ts`): placement and
   re-staking are rejected once `min(close_time, settlement observed_at)` has
   passed, and settlements are never observed before close. Together: after a
   wager's market closes, no claim senior to it can be created — any
   still-writable market closes later, and deploys lock at `tickInstant`, the
   maximum. Backdating seniority through a late wager on an early-closing
   market is therefore impossible, which is what makes `lockedAt = closeTime`
   safe to trust.

Comparison is by **parsed epoch milliseconds**, never string order. This is
load-bearing: several test and sim fixtures use `closeTime: "T18:00"`, which
string-sorts *after* every ISO instant — a string comparison would make deploys
senior again and the redone balance run would silently measure the pre-fix
ordering while reporting it as the fix. (The database side is already
normalized — migration index 2 rewrites `slate_markets.close_time` to ISO and
the adapter normalizes at ingest — so the residual really is fixtures only.)
Every fixture becomes a full ISO instant as part of this change, and a
`lockedAt` that does not parse refuses the tick loudly. Two of those fixture
lines are **production sim code, pinned here** because the balance run is the
evidence for the whole reordering: `closeTime: "T18:00"` at `src/sim/run.ts:69`
becomes a full ISO instant strictly earlier than the tick, and the sim's
`DailyContext` literal at `src/sim/run.ts:156` gains a per-day `tickInstant`
strictly later than every slate close — wrong ordering in either line and the
sim measures the pre-fix game.

The window/tick coupling gets the same treatment as the price-band coupling:
a `config.test.ts` assertion pinning `WINDOW_CLOSE_HOUR` (`src/config.ts`)
equal to `TICK_HOUR` (`src/slack/config.ts:20` — note: a different module, so
the test imports and names both symbols), so a config change cannot silently
reopen the exploit for late-closing markets.

## Conflict rules

**`grant` — sum.** Addition is commutative, so only the log order needs pinning,
which the id sort provides. Each active mechanic's `grant` runs **exactly once
per tick**, in step 1.

**`lock` — union across mechanics; parity stays internal.** The veto's parity
rule (`count(picks on t) % 2 === 1`) is its own business; it returns the
territories that survived its parity count, and the engine unions the results.
Two mechanics locking the same territory is idempotent, not a double-lock.
`lock` returns `LockResult[]` — `{territory, event?}` — and the engine logs each
supplied event, so the recap's existing `protected` output (with `byCount`) is
reproducible without hooks mutating anything. The event is **optional**
deliberately: *Truce* locks every territory, and ~264 individual lock events
would bury the log — Truce omits per-territory events, and the day's recap
announces the winning rule itself (name and description from `ctx.rules`),
which is the user-visible record of why **no attacks landed** (locks gate
attacks only — moves still execute under Truce, so the copy must not promise
that nothing moved).

**`spend` — ascending parsed `lockedAt`**, as specified in the allocation phase.

## Module state

`GameState.pending` is markets-shaped data sitting in core state. It moves:

```ts
interface GameState {
  seasonId, day, map, factions, ownership, garrisons, reserves, log, engineVersion
  moduleState: Record<ModuleId, ModuleStateValue>   // replaces `pending`
}
```

Each module owns the shape under its own key. **"Owner-only access" means module
code is the only code that interprets the value** — and module code includes the
module's exported helpers, wherever they are called from. `tick.ts` and
`rerun.ts` currently iterate `previous.pending` to decide which settlements to
load; after this change they call `marketIdsOf(state)` — a helper exported by
the markets module — so the job layer never interprets the shape itself. The
simulator needs a **richer accessor**: `sim/run.ts:150-154` reads each pending
wager's `side` and `price` to weight its settlement coin, so the markets
module also exports `pendingWagersOf(state)` (a read-only view) — the helper
contract is those two exports, not `marketIdsOf` alone.

Values are `JsonValue`, not `unknown`: the engine asserts JSON round-trip
serializability on every save, and each stateful module ships a validating
parser for its own slot (the same discipline `parseState` applies to core state
today), so a shape change in season 3 is handled where the shape is owned. The
alternative — the engine owning every module's schema — reintroduces exactly the
coupling this spec removes; the acknowledged cost is that module-state
migrations are module code, written against the same append-only migration list
as everything else.

`markets` stores `{ pending: PendingWager[] }` and implements `escrowed` (the
sum of pending stakes); `irl` and `veto` store nothing.

**Persisted states migrate, and the statement is pinned.** `parseState`
(`src/store/sqlite.ts:83`) hard-rejects a state row without `pending`, so
existing databases would become unloadable. `MIGRATIONS` is a `string[]` applied
via `db.exec` — no JS hook — so the rewrite must be SQL (a migration string may
hold several statements; this one needs only the following).
`node:sqlite` ships JSON1, and migration index 2 is precedent for data
migrations in a migration string. The statement:

```sql
UPDATE states SET state = json_set(
  json_remove(state, '$.pending'),
  '$.moduleState',
  json_object('markets', json_object('pending', json_extract(state, '$.pending')))
);
```

The failure mode of a mis-composed rewrite is an unbootable database with no
rollback (`user_version` has already advanced), which is why the exact
statement lives in the spec and test 10 loads a real pre-migration row through
it.

**Frozen contexts are backfilled at read time, not migrated.** Every
`tick_context` row written before this change lacks `tickInstant`, `modules`
and `rules`; left alone, the new "unparseable `lockedAt` refuses the tick" rule
would turn `tick:rerun` — the documented recovery tool, which by design warns
on engine-version mismatch and proceeds — into a hard failure for every
historical day. The rerun's context assembly therefore **synthesizes exactly
these three fields** for old rows, each from its authoritative source, all
deterministic and historically faithful:

- `tickInstant` = `etInstant(etDateAdd(season.startDate, day), TICK_HOUR)` —
  the same calendar computation `src/season.ts:36` already performs; this *is*
  the instant the original tick used.
- `modules` = the **literal** `["markets","irl","veto"]` — NOT the season
  row. Every pre-change `tick_context` row was by definition written under
  hardcoded all-three behavior, and the season row is not an authoritative
  source for history precisely because this spec makes it mutable: an operator
  who disables `irl` mid-season must not cause a rerun of a pre-change day to
  replay under a different module set — and then launder that wrong value into
  a permanently frozen record, since rerun saves the synthesized context back
  via `saveTickContext`. The backfill test pins this: mutate `season.modules`,
  rerun a pre-change day, assert the replay used all three.
- `rules` = `[]` — no rules existed before this change.

**No other field is ever defaulted.** A context missing anything else still
refuses loudly — an implementer "fixing" a refusal by inventing defaults would
silently replay a different game across a rerun cascade, which is exactly the
failure this backfill's narrowness prevents.

**Cost, stated plainly:** this is the most invasive part of the spec. It changes
`GameState`, so the golden file regenerates, and every state literal in the
tests that mentions `pending` is touched — plus the production readers:
`setup.ts`, `resolve.ts`, `sqlite.ts` (parse and save), `tick.ts`, `rerun.ts`,
`sim/run.ts`.

## The module boundary outside the engine

"A season with markets off is plain deterministic Risk" is only true if the
non-engine surfaces also consult `season.modules`. They do, explicitly:

- **Jobs**: `publish-slate`, `poll-settlements` and `poll-prices` exit 0 as a
  deliberate skip when `markets` is off (a skip, not a failure — the condition
  never clears, same reasoning as tick refusals). The tick assembles each
  module's context fields only for enabled modules.
- **Web** — the full sweep, enumerated like the `pending` consumers because a
  partial sweep leaves a ghost UI: the `/` projection stops embedding
  `wagers` **and `slate`** (`src/web/server.ts:97`; the projection type drops
  them at `src/web/projection-data.ts:92-93`, again in the args type at
  `:106-107`, and in the copy at `:166-167`); the wagers panel is not rendered
  (`src/web/render.ts:404`) **and neither is the board's `/wagers` nav link
  (`src/web/render.ts:368`)** — a dead link to a 404 is exactly the ghost this
  sweep exists to prevent; two copy lines that assume both modules are on are
  made conditional (`src/web/render.ts:310` "Approved workouts and settled
  wagers arrive at the tick", `:496` "Income, workouts and settled wagers are
  all the same…"); `/wagers` is absent — 404, not hidden
  (`src/web/server.ts:288,312`); and `POST /api/plan`
  (`src/web/server.ts:182`) **rejects** a payload containing `wagers` for a
  markets-off season, and `protect` for a veto-off season, with an explicit
  reason. Silent acceptance of an order field the engine will ignore is a lost
  order, which is worse than an error. One line of client copy is **added**
  (not reworded — none exists today): next to the reserve counter's `over`
  state (`src/web/client.ts:1029-1031`), a hint that deploys, not wagers, are
  what a short reserve drops. The client already treats wagers as senior when
  *adding* deploys (`spent()` counts stakes, `deployTo` blocks beyond the
  remainder); the gap is only the stale-plan path where later wagers push an
  existing plan negative.
- **Slack**: the recap renders nothing for modules that are off (their events
  never occur); the approval flow simply isn't invoked when `irl` is off.

`DailyContext` keeps its existing named fields (`slate`, `approvals`,
`postedToday`, `settlements`) rather than generalizing to an opaque per-module
context bag. The asymmetry with `moduleState` is deliberate: context fields are
frozen *inputs* already serialized into every existing `tick_context` row —
renaming them buys no capability, breaks every frozen context, and the fields
are empty (not absent) when their module is off. If a module ever ships from
outside this tree, generalize then.

**Module lifetime, precisely.** `modules` is season-scoped configuration: set
at `season:init`, expected constant for the season. A mid-season change is an
explicit operator command that updates the season row **between ticks**; it is
never retroactive (each day's frozen context records what was in force), and
disabling a module is **refused while `escrowed(own) > 0`** — orphaned
escrowed soldiers are the harm the refusal exists to prevent. The gate is the
escrow, not slot presence: `moduleState` values are opaque JSON, so "non-empty
slot" is not an implementable test (markets' slot is `{pending: []}` even with
zero escrow, which would refuse forever), while `escrowed` is a hook the
engine already requires of every stateful module. **A permitted disable also
removes the module's `moduleState` slot** — the state was idle by the gate's
own test — so a later re-enable starts the module fresh: a stale slot must
not sit dormant and resurrect escrow (or any other state) when the module
returns. "Season-scoped" describes the intent; the refusal rule is what makes
the escape hatch safe.

## Events

`TickEvent` stays a closed union — season-one modules are in-tree engine code,
and a closed union is what makes the render switch checkable. **Every
event-shape change in this spec, in one list** (each regenerates the golden
file and touches the renderer and recap, all already budgeted):

- A new generic variant `{t:"grant", source: ModuleId | RuleId, faction,
  amount}` for mechanics that don't already own a variant. *Boom*'s doubled
  income logs as `{t:"grant", source:"boom", ...}` — distinguishable in the
  recap from ordinary income, and a new catalogue rule needs no core type edit.
  The existing `irl`, `wagerSettle` and `protected` variants stay.
- `attack` gains `fee?: number` — the dial's departure fee, kept **separate
  from `committed`** so `committed` still means "troops that fight". Combat's
  departure deduction becomes `committed + fee` (today it deducts exactly
  `committed`; this is the deduction-site change the dial needs, distinct from
  the validation cap).
- `attack` gains `lost: number` and `defenderLost: number`. These exist
  because the accounting below is otherwise impossible: a **losing**
  attacker's surviving troops withdraw home (`combat.ts:166-173`) while its
  event logs `survivors: 0` (`combat.ts:185`), so `committed − survivors`
  overstates destruction on every multi-attacker contest; and the repulse
  branch's defender losses (`garrisons[to] = defense − total`) appear in no
  event at all. Three attribution rules make the fields summable without
  double-counting: **`lost` is target-combat casualties only** — a troop that
  died in a field battle is counted in `fieldBattle.aLost/bLost` and nowhere
  else; **`defenderLost` is logged once per contested territory**, on the
  arriving movement with the lexicographically-first `from` (zero on the
  others) — one `attack` event is pushed per arriving movement, and repeating
  the territory's losses on each would sum to `legs × defense`; and **a
  movement annihilated in a field battle still emits its `attack` event**
  (`size 0, survivors 0, lost 0`, its deaths being `fieldBattle`'s) — the
  shipped code filters `m.size > 0` before emitting, which would silently
  drop that movement's `fee` from the log. Renderers may skip zero-strength
  arrivals; the log keeps the fee.
- `fieldBattle` gains explicit per-side losses (`aLost`, `bLost`) — it
  currently reports only continuation counts, not what died.
- `wagerSettle` gains `stake: number` — settlement accounting is
  unclassifiable without it (below).
- `rejected` gains `ref?: string` (optional — core validation call sites
  unchanged; allocation drops and step-4 voids populate it).
- **Exhaustiveness, honestly split by consumer shape.** The web renderer's
  event `switch` (opens `src/web/render.ts:445`; the `default: assertNever(e)`
  lands after the last case, at the brace on line 476) gets that default — a
  new helper; none exists in `src/` today — and its genuinely missing `move`
  case ships fixed as the proof the failure mode is real. The recap is **not a
  switch** — it is a per-type filter helper with independent call sites, and
  it deliberately never queries `deploy` — so the coverage test asserts
  `RECAP_HANDLED ∪ RECAP_IGNORED === TickEvent["t"]`, with
  `RECAP_IGNORED = {"deploy"}` and a comment saying why it is unrendered. A
  new variant fails the suite; a deliberately-ignored one is on the record
  instead of being a hand-maintained lie. The renderer claim is compile-time;
  the recap claim is test-time; the spec does not pretend otherwise.

**Conservation accounting becomes two-sided.** The shipped invariant is
deliberately one-sided (`totalOf(next) <= totalOf(before) + created`) — it
catches creation and is silent on destruction, which is also why it cannot
police a module that holds soldiers but omits `escrowed` (that makes the total
*smaller*, which passes). This spec adds a **new** per-tick accounting test —
new work, not an extension: `totalOf(next) === totalOf(before) + created −
destroyed`, where `totalOf` sums garrisons + reserves + each module's
`escrowed`. **The full source list, each term named with the log field that
carries it** — a sink without a field was this test's round-3 failure mode:

| flow | sign | log field |
|---|---|---|
| territory income | + | `income.amount` |
| IRL grants | + | `irl.actions + irl.bonus` |
| module/rule grants | + | `grant.amount` |
| wager win | + `payout − stake` | `wagerSettle.payout`, `wagerSettle.stake` |
| wager refund | 0 (payout = stake: a transfer, not creation) | same |
| wager loss | − `stake` | `wagerSettle.stake` (payout 0) |
| attacker casualties (target combat only) | − | `attack.lost` (withdrawn survivors are alive, not lost; field-battle deaths are not repeated here) |
| defender casualties | − | `attack.defenderLost` (once per contested territory — see attribution rules above) |
| field-battle losses | − | `fieldBattle.aLost + bLost` (exclusively — disjoint from `attack.lost`) |
| dial fees | − | `attack.fee` (every departed movement emits its event, even annihilated ones) |

The equality is what turns a forgotten `escrowed`, an unlogged fee, or a
mis-signed settlement into a test failure instead of a silent pass.

## Season-one mechanics

| id | hooks | state | dependency |
|---|---|---|---|
| `markets` | `grant` (settlement payouts), `spend` (escrow), `validate` (one wager per market, slate membership), `advance` (mature/refund + append honored escrow), `escrowed` | `{ pending }` | — |
| `irl` | `grant` (actions + timing bonuses) | — | — |
| `veto` | `lock` (parity over eliminated posters, `protected` events), `validate` (`protect` legality) | — | irl (hardcoded season-init check) |

Core keeps territory income, deploys, moves, attacks, combat, elimination and
the season-end check. Core *state* carries no mechanic's data after this
change; core *context* still names the season-one modules' inputs, as argued
above.

## The rule catalogue

A rule is a mechanic with a one-day lifetime, display fields, and a narrow
offer-filter field:

```ts
interface Rule extends Mechanic {
  id: RuleId
  name: string          // shown in the vote and the recap
  description: string   // one line; rendered through esc() and length-capped
                        // like capQuestion caps market titles
  /** Modules this rule's offer requires — an OFFER FILTER, not a dependency
   *  system: the daily draw skips rules whose needs are unmet, so the vote
   *  can never select a rule the engine would refuse. */
  needs?: ModuleId[]
}
```

**Season one ships three rules, each traced through the hook surface below** —
the original draft listed five, and tracing killed two:

| rule | hook | trace |
|---|---|---|
| *Boom* — income doubled today | `grant` | recomputes core territory income from `state` (pure), grants an equal amount per faction, logs `{t:"grant", source:"boom"}` |
| *Attrition* — attacks cost one extra troop today | `combatDials` | returns `{attackDepartureCost: 1}`; arithmetic in "The combat dial" |
| *Truce* — no attacks today | `lock` | returns every territory (no per-territory events); the union voids all attacks; the recap names the rule |

**Cut: *Blackout*** (no wagers today). A rule voted in at the 21:00 tally would
void wagers that became irrevocable at their market's close — refunding stakes
*after outcomes are public*, by group vote. That is the deploy-inflation
exploit with a quorum requirement, and it directly undercuts the irrevocability
the allocation phase is built on. It returns only with a placement-time gate
(the vote known before markets close), which is a different feature.

**Cut: *Amnesty*** (eliminated factions may deploy once). Unimplementable in
this hook surface: `validate` hooks can add rejections but never suppress core
ones, core validation rejects deploys to unowned territories, an eliminated
faction owns none, and ownership changes are explicitly outside the dial set.
Its removal is the reason the tracing rule above exists: **a catalogue entry
that has not been traced through the hooks on paper is not a candidate.**

Rules resolve at the 21:00 tally and apply to **that night's tick**. Players
submit orders all day without knowing which rule will win — deliberate: the
vote is itself a strategic surface (voting *Truce* at 20:58 to void a feared
attack is kingmaking, not a bug), and it is stated here so the balance section
measures it rather than discovering it.

Note that "single-tick" describes the *effect*, not the consequence: *Boom*'s
soldiers exist tomorrow and a territory taken under *Attrition* stays taken. No
rule that does anything is reversible in consequence, which is why the gate is
measured swing rather than reversibility — see "Replacing the reversibility
test".

**Kill criterion.** The vote-offer-freeze apparatus exists to ship a catalogue.
If the catalogue ever holds fewer than three rules, delete the apparatus and
keep the module system — the machinery must keep re-earning its weight.

### Voting

Voting **shares the ingest's foundations — the `slack_events` dedupe ledger,
roster lookup, and emoji normalization — but is its own branch at both layers
of the ingest.** Two existing gates would otherwise drop every vote, and the
branch points are named so the implementer patches both:

- `interpretReaction` (`src/slack/events.ts`) drops any reaction outside
  `APPROVAL_EMOJI` before handlers ever see it. The vote branch is inserted
  after the team/channel checks, **before the approval-emoji filter** — note
  the shipped gate order: the roster check sits *after* the emoji filter
  (`events.ts:118` vs `:115`), so the vote branch performs **its own roster
  lookup and faction resolution** (it needs the user→faction mapping
  regardless, and downstream `factionForSlackUser` at `handlers.ts:83` sits
  behind the `postFor` gate the vote branch bypasses). It also bypasses the
  self-approval check — harmless for a bot-authored offer message, stated so
  nobody re-adds it.
- `handleReactionEvent` (`src/slack/handlers.ts`) drops reactions whose message
  has no `posts` row, and a bot-authored offer message never enters `posts`.
  The vote branch recognizes the day's offer message by its stored `ts`, after
  the `seen()` dedupe, before the `postFor` gate.

Mechanics:

- The bot posts **one offer message** listing the day's candidates, numbered.
  A vote is a numeral-emoji reaction (`one`, `two`, `three`, …) on that
  message.
- **Raw vote reactions persist in their own table** — see Storage for
  `rule_reactions`. This is not the round-1 anti-pattern returning: the
  project's rule is "an approved action is **derived**, never stored," and the
  existing `reactions` table is itself the *raw-event record* approvals derive
  from. Votes need their own raw record because `reactions` cannot represent
  one: it has no emoji column (a vote is *which* numeral you picked), its
  primary key is one-row-per-player-per-message (a change of vote needs two
  live rows), and its writes are deliberately first-timestamp-wins
  (`INSERT OR IGNORE` — correct for approvals, the exact opposite of
  latest-vote-wins). What stays deleted is the *derived* table — the round-1
  `rule_votes`, one authoritative row per voter, which made `reaction_removed`
  a state machine.
- Derivation at the 21:00 tally, from raw rows: a player's vote is the ordinal
  of their still-present numeral reaction with the **latest** Slack timestamp;
  removing it un-votes (its row is deleted); an earlier still-present numeral
  resurrects naturally; re-adding a numeral records the new timestamp.
  Timestamps follow the store's established convention: `reacted_at` is
  written through `slackTsToIso` — exactly as `recordApproval` does
  (`sqlite.ts:414`, whose comment explains why: a raw Slack ts and an ISO
  string compare as strings and would put every reaction on the wrong side of
  the cutoff) — so the tally's comparisons are ISO-to-ISO string compares,
  never database write time. **The cutoff predicate is explicit**: the tally
  counts a row only if it is present when the tick's transaction reads AND
  `reacted_at <= ctx.tickInstant` — a delayed tick must not count a reaction
  placed after 21:00 just because it arrived before the transaction began.
- **A numeral with no matching offer row is dropped at ingest, not stored.**
  `nine` on a three-candidate day must not become a player's "latest" reaction
  and silently void their valid earlier vote.
- Same delivery window as approvals: a reaction *stored* by the time the
  tick's transaction reads is counted by its Slack timestamp; one whose
  webhook arrives after that is lost, exactly as a late approval is today.
- Candidates are drawn deterministically from the catalogue by seeded shuffle,
  filtered by each rule's `needs` against the season's enabled modules, the
  seed stored per day so the draw is auditable.
- One vote per player; ties break on the lowest `RuleId`; a day with no votes
  selects nothing. The winner is frozen into the context (`ctx.rules`), which
  is the durable record of what won.
- `rule_id` values entering `rule_offers` are validated against the closed
  catalogue before insert — a Slack payload must never be able to name a rule.
- **Offer posting is claim-then-post**, the recap ledger's existing pattern:
  the offer rows (with the draw and seed) are inserted **before** the Slack
  post with `message_ts` NULL, then the post happens, then the `ts` is
  recorded. (`message_ts` is nullable, with NULL meaning "claimed, not yet
  posted".) **The guarantee, stated honestly:** claim-then-post closes the
  crash-*before*-post window — a re-run finds the claimed rows and posts. It
  does **not** close crash-*after*-post-before-record: that message's `ts`
  exists nowhere, so its reactions can never map to a row, and they are
  **lost by construction** — a bounded, rare window (one systemd retry wide),
  accepted rather than papered over. The re-post copy marks supersession
  ("replaces the offer above — vote here") so players move to the live
  message. What is NOT acceptable is pretending otherwise: the vote test
  asserts that votes on the *re-posted* message count, not that the orphan's
  votes survive.

## Freezing

`DailyContext` gains three fields:

```ts
interface DailyContext {
  slate, approvals, postedToday, settlements   // existing
  tickInstant: string                          // the tick's frozen instant
  modules: ModuleId[]
  rules: RuleId[]
}
```

All are **frozen into `tick_context`** by the tick's transaction, alongside the
rest of the context. This is not optional: a rule voted in on day 5 changes how
day 5 resolves, so a rerun that re-read the current catalogue would replay a
different game. (Pre-change rows are handled by the read-time backfill in
"Module state" — synthesized from the season calendar and hardcoded literals,
nothing else ever defaulted.)

**What freezing a `RuleId` means.** Rule *selection* is frozen in the context;
rule *behavior* is engine code, covered by `engineVersion` exactly like every
other engine behavior — `tick:rerun` already warns when replaying under a
changed engine and proceeds deliberately. A frozen id under a changed
implementation replays differently *with the warning*, which is the project's
existing, chosen semantics for engine drift; this spec adds no second
versioning scheme.

`modules` is stored on the season row and copied into each day's context, so a
mid-season module change is visible in the record rather than retroactive —
lifetime and refusal semantics in "The module boundary outside the engine".

## Storage

**Appended as the next migration** — the schema currently ships six (indices
0–5), so this is index 6, but the instruction is "append", not the number; more
may ship first. Never renumber or edit a shipped entry.

```sql
ALTER TABLE seasons ADD COLUMN modules TEXT NOT NULL DEFAULT '["markets","irl","veto"]';

-- One row per day per candidate offered, so the offer is reconstructable
-- and a numeral reaction maps to a rule without re-deriving the shuffle.
-- message_ts is NULL between the claim and the successful Slack post.
CREATE TABLE rule_offers (
  season_id  TEXT NOT NULL,
  day        INTEGER NOT NULL CHECK (day >= 1),
  rule_id    TEXT NOT NULL,
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 1),
  seed       TEXT NOT NULL,           -- the day's shuffle seed, for audit
  message_ts TEXT,                    -- claim-then-post; see "Voting"
  PRIMARY KEY (season_id, day, rule_id),
  UNIQUE (season_id, day, ordinal)
);

-- The RAW vote-reaction record the tally derives from (the analogue of
-- `reactions` for offers — raw events, not derived state). One row per
-- still-present numeral reaction; deleted on reaction_removed; re-adds
-- rewrite the row with the new Slack timestamp.
CREATE TABLE rule_reactions (
  season_id  TEXT NOT NULL,
  day        INTEGER NOT NULL CHECK (day >= 1),
  faction_id TEXT NOT NULL,
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 1),
  reacted_at TEXT NOT NULL,           -- ISO, via slackTsToIso at write (the
                                      -- store's convention; see "Voting")
  PRIMARY KEY (season_id, day, faction_id, ordinal)
);
```

The same migration rewrites `states.state` JSON with the pinned statement in
"Module state". There is no **derived** votes table — the tally is computed at
tick time from `rule_reactions`. `tick_context.context` already carries the
whole `DailyContext` as JSON, so `tickInstant`, `modules` and `rules` need no
columns.

## The combat dial

*Attrition* fits no soldier-flow hook: it is not a grant, not a reserve spend,
not a lock, and `validate` returns rejections rather than mutating orders.
Combat needs a dial or the catalogue is restricted to soldier-flow and locks.

It gets exactly one:

```ts
/** Step 6. Omitted fields mean the core value. */
type CombatDials = {
  /** Extra troops lost per attack MOVEMENT at departure. 0–2 after clamping. */
  attackDepartureCost: number
}
```

Values **sum** across active mechanics and clamp to **2**. What the clamp
actually constrains is stated precisely, because it is not the garrison floor —
the in-cap charge protects the floor for *any* cost (below). The clamp bounds
**who can act at all**: a 1-troop attack needs `1 + k ≤ g − 1`, so at `k = 2`
a garrison of 4 is the minimum that can attack; at `k = 3` it would be 5, and a
large fraction of border garrisons would be frozen outright. The clamp at 2 is
the largest value that keeps small-garrison play alive, which is a game-design
bound, not tuning.

The original draft's second dial, `tieGoesToAttacker`, is **deleted**: no
drafted rule used it, three reviewers found its semantics undefined (a field
battle has two attackers — "the attacker continues" names no one), and it alone
forced a two-kind merge discriminator onto the hook. It returns the day a rule
needs it, specified with a worked example, not before.

### The arithmetic, written down

The original draft charged the cost at departure, outside the validation cap.
Two reviewers independently showed that drives garrisons negative. The correct
placement, now with the merge and deduction sites specified:

- **Attacks are merged before cap accounting.** Today validation walks attack
  lines independently and combat merges duplicate `(from, to)` legs afterward.
  With a fee, that order matters: two `X→Y 1` lines charged per-line cost two
  fees where the merged `X→Y 2` costs one, so duplicate-line invariance is
  not a property that falls out — it forces **merge-then-validate**. Step 5
  merges a faction's attacks by `(from, to)` first, then validates each merged
  movement. **This changes core attack outcomes even with the dial at 0**, in
  one narrow case: duplicate-direction lines that today enjoy greedy partial
  acceptance (garrison 8, cap 7, `X→Y 5` + `X→Y 5` — today the first line
  attacks with 5; merged, `X→Y 10` exceeds the cap and the whole movement is
  rejected). All-or-nothing per direction is the deliberate choice — a merged
  movement either fits or it doesn't, and partial acceptance of an implicitly
  merged pair was an accident of line order, not a design. It is listed in
  "What this breaks", pinned by its own regression test, and the balance run
  covers it (noting the sim's policies emit one line per direction, so the
  test, not the sim, is the evidence for this case).
- **The cost is charged inside the validation cap.** Each merged movement
  consumes `count + attackDepartureCost` from the origin's cap of
  `garrison − 1` (post-allocation garrison). A movement that no longer fits is
  rejected **as a movement**: one `rejected` event naming the direction
  (`from→to`, total count) — merged granularity, not per line, because a
  merged movement has no single order line to name. (Allocation-phase claims
  keep per-item granularity; the two phases differ and both say so.)
- **Moves pay no fee.** They share the per-origin `committed` ledger — a move
  consumes `count` only. Moves validate before attacks today by deliberate
  design ("the reinforcement survives and the attack is what dies"), so an
  attack-only fee compounds that existing priority; stated so the balance run
  measures it knowingly.
- The floor survives for any cost: with consumption `c + k ≤ g − 1` and
  departure `c + k`, remaining is `g − (c + k) ≥ 1` for every `k ≥ 0`. Worked
  example: garrison 3, cost 1 — `X→Y 1` consumes 2 (cap 2, fits); `X→Z 1`
  would make 4 > 2, rejected; the survivor departs 2, origin ends at 1.
- **The deduction site changes too**: combat's departure deduction becomes
  `committed + fee` (today it deducts exactly `committed`), with the fee
  carried on the `attack` event's new optional `fee` field — separate from
  `committed`, so the event still reports the troops that actually fight.
- A veto-voided attack (target locked; troops never leave) pays **no** fee and
  consumes **no** cap — voiding happens in step 4, before validation ever
  sees it.
- Charging inside the cap **changes which attacks are legal** on dial days,
  which is a balance-relevant change independent of the allocation reordering.
  The balance run covers it.

**Explicitly not dials, now or later:** casualty ratios, defense bonuses,
adjacency changes, ownership changes, anything touching the largest-remainder
allocation. A rule wanting one of those is a rules-engine change, not a
catalogue entry.

### What the conservation invariant actually protects

The engine's shipped troop-conservation property is **one-sided**: it catches
soldiers being *created* and says nothing about soldiers being destroyed. So a
defender bonus or casualty-ratio dial would not trip it — the invariant is not
the reason to refuse them. The real objection:

The design spec makes the 1:1 loss ratio load-bearing — *"the primary brake on
snowballing"*. The discriminator is **whether a dial's effect scales with the
acting faction's existing advantage**. A multiplicative dial pays the leader
most, because the leader has the most troops to multiply. `attackDepartureCost`
is flat per movement, bounded by movement count. That is why the catalogue
takes flat dials only.

Invariant-suite changes shipping with this spec regardless of dials:

- The **new two-sided accounting test** (see "Events") — creation and
  destruction both derived from the log; this is what enforces `escrowed` and
  fee logging behaviorally.
- The garrison-non-negativity property runs **with dials active**, and the
  property-test arbitrary gains **`moves`** — it currently generates only
  deploys/attacks/wagers/protect, and the dial contends with the shared
  per-origin ledger that moves draw on, so an arbitrary without moves tests
  strictly less than the bug this exists to catch.

### Replacing the reversibility test

The draft's property test — *"diverge on day N and reconverge by day N+1"* — is
unsatisfiable and would have rejected the whole catalogue: *Boom*'s soldiers
exist on day 6, a territory taken under *Attrition* stays taken. No rule that
does anything is reversible in consequence. That was a wrong criterion.

The criterion is **bounded swing**, gated empirically:

- Run the balance suite with each rule forced active **every** day against a
  no-rules baseline, at 10,000 seasons per arm, **same pinned seeds for both
  arms** (`runSeason(policyNames, seed)` already takes the seed). The
  arithmetic, labeled correctly and for a stated configuration — the
  **8-policy roster** (null win rate p = 0.125; the p ≈ 0.25 figure below is
  the conservative 4-seat table stakes, and worst-case p = 0.5 still passes):
  at 2,000 seasons and p ≈ 0.25 the per-run SE is ≈ 0.97 points, so the SE of
  an *independent* difference is ≈ 1.4 — too close to a 3-point gate. At
  10,000 the independent-difference SE is ≈ 0.6 (worst case p = 0.5: ≈ 0.7).
  Pinned seeds are common random numbers, so the paired difference SE is
  strictly *below* that — report the **empirical paired SE** from the run
  rather than the independence formula, and the confidence interval alongside
  the point difference.
- Reject any rule moving any policy's win rate by more than 3 points. That is
  8 comparisons (the shipped policy roster); at difference-SE ≤ 0.7 the
  expected max of 8 noise draws is ≈ 1.0 point, comfortably inside the gate —
  multiplicity does not threaten it.
- Forcing a rule daily is **stress evidence, not proof** — for a nonlinear
  rule (compounding *Boom* days), daily activation explores a different regime
  than scattered single days, so the gate is a strong screen rather than a
  bound. The catalogue's flat/single-tick restriction is what keeps the
  extrapolation honest, and the vote-dynamics run (rules on, voted by policy)
  is part of the redone balance work, not skipped.

That gate is also what keeps the balance model tractable: rules stay in the
catalogue because they were measured, not because they were argued to be small.

## What this breaks

**The balance model.** Every number this project has assumes one fixed rule
set. The simulator takes a module set and a rule policy as arguments; the
committed balance run covers the season-one module set with rules off, plus the
per-rule forced runs above. The allocation reordering, the lock-before-validate
change, the in-cap dial charging, **and merge-then-validate** (which converts
greedy partial acceptance of duplicate-direction attack lines into
all-or-nothing per merged movement, even at dial 0) all change combat
outcomes, so **the balance run is redone, not re-checked.**

**The golden file.** `GameState` changes shape, so it regenerates. Regenerate
deliberately and read the diff — the tick-runner review found the current
golden season never exercises protections, so it will not catch a `veto`
regression. Extend the scripted season to eliminate a faction before trusting
it here.

**Every consumer of `pending`** — enumerated in "Module state" — the web
surfaces enumerated in "The module boundary", and the event consumers, which
gain the renderer `assertNever` and the recap coverage test. The **two-sided
accounting test is new work**, not an extension of the shipped one-sided check.

## Testing

1. **A season with no modules resolves.** Plain Risk: income, deploys, moves,
   attacks, combat. No module events; `moduleState` is `{}`.
2. **Each module in isolation.** `markets` only; `irl` only; `irl` + `veto`.
3. **Season-init validation.** `veto` without `irl` refused; unknown/duplicate
   ids refused, **per namespace** (a rule id in `season.modules` and a module
   id in the rule catalogue both refuse); an unknown module in a `Rule.needs`
   refused at catalogue load; `advance` without `escrowed` refused.
4. **Hook determinism.** Byte-identical output regardless of configured order.
5. **Allocation priority.** A deploy submitted at 20:59 cannot drop a wager
   locked at 16:00; the phantom-troop case (a deploy dropped by a senior wager
   reduces the attack cap; the dependent attack is rejected in step 5;
   garrisons stay ≥ 0; a `rejected` event names the dropped deploy's `ref`).
   The equal-`lockedAt` tie-break (mechanic id, then index) **requires a
   synthetic test mechanic** — production slate wagers can never tie a
   deploy's instant, so without one the test asserts nothing.
6. **`lockedAt` well-formedness.** Every claim's `lockedAt` parses; a
   non-parsing value refuses the tick; ordering is by parsed value; all
   fixtures ISO.
7. **Locks before validation.** A voided attack consumes no cap and no fee — a
   protected 1-troop attack plus a valid 1-troop attack from a garrison of 3
   on an *Attrition* day: the valid attack survives, and the voided one logs
   a `rejected` event (`reason: "protected"`) so the outcome is
   log-observable, not just garrison arithmetic. Lock union idempotent; veto
   parity cancels within the veto; veto's `protected` events logged; Truce
   logs no per-territory events and the recap names the rule.
8. **Freezing and lifetime.** A rule voted on day 5 replays on day 5 after
   catalogue changes (same engineVersion); a module disabled on day 6 does not
   alter day 5; disabling with `escrowed(own) > 0` refused, and the
   **permitted** path tested too: an operator change between ticks appears in
   the next day's frozen context and not the previous day's, the disabled
   module's slot is removed, and a **disable-then-re-enable** round trip
   neither resurrects escrow nor alters totals. **And backfill:**
   a pre-change `tick_context` row (no `tickInstant`/`modules`/`rules`)
   replays under the new engine via the synthesized fields — including with a
   **mutated** `season.modules`, asserting the replay still used the literal
   all-three; a context missing anything else still refuses.
9. **Voting.** Derivation from `rule_reactions`: latest still-present numeral
   wins; removal un-votes; an earlier still-present numeral resurrects; re-add
   records the new timestamp; `reacted_at` ISO-normalized at write and the
   tally's cutoff predicate enforced (`reacted_at <= ctx.tickInstant` AND
   present at read — the **delayed-tick regression**: a reaction placed after
   21:00 but stored before a late tick's transaction must not count); one vote
   per player; no votes selects nothing; ties break on lowest `RuleId`; the
   offer filter (`needs`) never offers a rule whose module is off; an
   **unmapped numeral is dropped at ingest** (it must not void a valid earlier
   vote); an **unknown `rule_id` is refused at `rule_offers` insert** (the
   catalogue-validation security claim gets its own test); the vote branch is
   reachable (a numeral reaction on the offer message survives both ingest
   gates); claim-then-post — a crash **before** post replays cleanly, and
   votes on the **re-posted** message count (the crash-after-post orphan
   window is documented as accepted loss, not asserted away).
10. **Persisted-state migration.** A real pre-migration `states.state` row
    passes through the pinned `json_set`/`json_remove` statement and loads;
    `parseState` accepts the new shape and rejects a row with neither
    `pending` nor `moduleState`.
11. **Bounded swing.** Per-rule forced runs against the pinned-seed baseline
    at 10,000 seasons per arm; reject > 3 points on any policy; report the
    empirical paired SE and CI.
12. **Conservation under the dial.** The new two-sided accounting equality at
    every dial setting, against the full source table in "Events" (win
    creates `payout − stake`, refund nets zero, loss destroys the stake;
    withdrawn survivors are not casualties; `attack.lost` and `fieldBattle`
    losses are disjoint; `defenderLost` sums to the territory's actual losses
    across a multi-leg contest; an annihilated movement's `fee` still appears
    in the log); garrisons ≥ 0 with dials active
    **and with `moves` in the property-test arbitrary**; fee charged per
    merged movement (duplicate order lines cost the same as their merged form
    — by construction, since merge precedes validation); **the
    merged-rejection regression**: duplicate-direction lines that exceed the
    cap merged are rejected whole, replacing today's partial acceptance —
    pinned so the behavior change is deliberate; moves pay no fee;
    veto-voided attacks pay no fee; `attack.fee` separate from `committed`.
13. **Event exhaustiveness, split by consumer.** Renderer: `assertNever`
    default — a new `TickEvent` variant fails the build; the missing `move`
    case ships fixed as the proof. Recap:
    `RECAP_HANDLED ∪ RECAP_IGNORED === TickEvent["t"]` with
    `RECAP_IGNORED = {"deploy"}` (the recap deliberately never renders
    deploys) — a new variant fails the suite, a deliberately-ignored one is
    on the record. The two claims are different strengths and the tests say
    which is which.
14. **Module-off surfaces.** Wager payloads rejected when markets is off;
    `/wagers` 404s; the `/` projection carries no wager fields; the pollers
    and `publish-slate` skip with exit 0.
15. **Config coupling.** `WINDOW_CLOSE_HOUR` (`src/config.ts`) equals
    `TICK_HOUR` (`src/slack/config.ts`), pinned in `config.test.ts` naming
    both symbols.
16. **Malformed hook returns.** A negative `amount`, a fractional `amount`,
    and an unknown `faction` each refuse the tick — the engine-validation
    throw path has its own test, not just the `lockedAt` case.

## Deltas against the original design

| Original spec | This design | Why |
|---|---|---|
| the pipeline hard-codes wagers and IRL | both become modules dispatched through hooks | a season should be playable without either, and the rule catalogue needs the same dispatch |
| `GameState.pending` | `GameState.moduleState[markets]` | core state should not carry one mechanic's data |
| the veto lives inside the IRL mechanic | `veto` is its own module; the dependency is a hardcoded season-init check | with IRL off the veto would silently fire ungated or vanish |
| deploys are budgeted before wagers | one allocation phase, claims honored by ascending parsed `lockedAt`, before lock resolution and attack/move validation | earlier-locked commitments are senior; seniority must resolve before any cap computed from deploys; locks must resolve before caps so voided attacks don't crowd out real ones |
| — | a voted daily rule catalogue (three traced rules; raw votes in `rule_reactions`, tally derived) | new mechanic, gated on measured swing; every entry traced through the hook surface |
| combat arithmetic is fixed | one flat dial, `attackDepartureCost`, merged-movement charging inside the validation cap, deduction `committed + fee` | *Attrition* fits no other hook; flat cost preserves the 1:1 anti-snowball brake and the garrison floor |

## Review history

**Round 1** (six seats, unanimous REVISE): allocation/validation ordering
(phantom troops), `advance` starvation, negative garrisons from the dial,
undefined `tieGoesToAttacker`, string-sorted `lockedAt` fixtures, stored
derived votes, unreachable vote reactions, missing state migration, jobs/web
gating, closed `TickEvent` union, balance-gate statistics, stale `moves`
omissions. All addressed in revision 2.

**Round 2** (Architect and Simplifier APPROVED; Executor, Auditor, and both
Skeptics REVISE on contained corrections — the Fable Skeptic's adversarial
trace of the allocation phase, including a wager-backdating attack, found it
sound). Fixed in this revision:

1. **Raw vote storage** (`rule_reactions`) — both Skeptics: the tally derived
   from rows that were never persisted, and the existing `reactions` table is
   structurally first-timestamp-wins with no emoji column. Both ingest branch
   points now named.
2. **Grant runs once** — the two-step "settle then grant" listing read as
   running every grant hook twice, double-paying settlements. One grant phase.
3. **`lock` signature** — three seats: interface said `TerritoryId[]` while
   conflict rules required `{territory, event}`. Now `LockResult[]` with an
   optional event; Truce's log behavior specified.
4. **Locks resolve before movement validation** — Auditor: a voided attack
   must not consume cap or fee.
5. **Frozen-context backfill** — Opus Skeptic: required context fields would
   brick `tick:rerun` for all historical days; Fable Skeptic: careless
   defaulting would silently alter replays. Resolved with a faithful synthesis
   (calendar tick instant, season-row modules, empty rules) and nothing else
   ever defaulted.
6. **Merge-then-validate** — per-line fee charging contradicted
   duplicate-line invariance; movement-granularity rejections specified.
7. **Deduction site and fee event** — `committed + fee` at departure;
   `attack.fee` optional field; two-sided accounting test added as new work
   (also what enforces `escrowed`).
8. **Module lifetime** — "stable" vs mid-season disable contradiction resolved
   (operator command between ticks, recorded, refused when stateful).
9. **`needs` offer filter** on `Rule`; deploy legality before claims; purity
   scan's import-boundary rewrite; recap exhaustiveness restated honestly
   (test-time, not build-time); web sweep enumerated; pinned migration SQL;
   `rejected.ref` optional; claim-then-post for offers; SE math relabeled
   (difference-SE, paired-run correction); clamp justification corrected;
   `stillOpen` gate cited as the third seniority leg; client over-budget copy;
   citation fixes (`WINDOW_CLOSE_HOUR` in `src/config.ts`, `TICK_HOUR` in
   `src/slack/config.ts`).

**Round 3** (Architect and Simplifier APPROVED; Executor, Auditor and both
Skeptics REVISE on convergent, contained corrections — three seats
independently found the accounting-derivation gap, three the claim-then-post
guarantee). Fixed in the verification revision:

1. **Accounting made computable**: `attack` gains `lost` and `defenderLost`,
   `fieldBattle` gains per-side losses, `wagerSettle` gains `stake`;
   settlement classified (win creates `payout − stake`, refund nets zero,
   loss destroys the stake — a full payout under `created` double-counted
   refunds and winning stakes); the two-sided test's source table names the
   log field for every flow; withdrawn survivors of losing attackers are not
   casualties.
2. **Backfill reads history, not the mutable season row** (Fable): `modules`
   synthesizes the literal all-three — rerun must not launder a mid-season
   module change into frozen pre-change records via `saveTickContext`.
3. **Claim-then-post guarantee stated honestly** (three seats): the
   crash-after-post-before-record window orphans that message's reactions,
   accepted and bounded; re-post marks supersession; test asserts votes on
   the re-posted message count.
4. **Disable gate is `escrowed(own) > 0`**, not slot presence (`{pending:
   []}` is structurally non-empty but semantically idle).
5. **Merge-then-validate acknowledged as a core behavior change** at dial 0
   (partial acceptance → all-or-nothing per merged direction), added to
   "What this breaks" with its own regression test.
6. **Recap coverage becomes `HANDLED ∪ IGNORED === TickEvent["t"]`** with
   `deploy` deliberately ignored (a plain HANDLED union would be red on day
   one or a hand-maintained lie).
7. **Purity-scan rewrite hardened**: bare package specifiers rejected before
   resolution (naive resolution would newly accept them).
8. **Verification-pass pins** (Executor, Auditor, and the Opus verifier's
   catches): `attack.lost` defined as target-combat-only and disjoint from
   `fieldBattle` losses; `defenderLost` attributed once per contested
   territory (lowest-`from` event); an annihilated movement still emits its
   `attack` event so its fee stays in the log; the false `dailyApprovals`
   defect claim deleted — the store normalizes via `slackTsToIso` at write,
   deliberately and correctly, and `rule_reactions` now follows that same
   convention; the tally cutoff predicate made explicit
   (`reacted_at <= ctx.tickInstant` AND present at read, with a delayed-tick
   regression test); registry validation made per-namespace with `Rule.needs`
   checked at catalogue load; the engine's internal owner-tagging of claims
   stated; a permitted disable removes the slot and re-enable starts fresh;
   honored deploys stated to land at step 3's end.
9. Also: ghost `/wagers` nav link and two both-modules-on copy lines added to
   the web sweep; projection drops `slate` alongside `wagers` (three cited
   lines); aggregate reserve budgeting explicitly moves into allocation;
   voided attacks log `rejected` with `reason: "protected"`; vote branch does
   its own roster/faction lookup (the shipped gate order differs from round
   2's description); unmapped numerals dropped at ingest; vote timestamps
   follow the store's `slackTsToIso` write convention; `pendingWagersOf`
   added to the markets helper contract for the sim; the two sim fixture
   lines pinned (`run.ts:69` ISO close,
   `run.ts:156` context gains `tickInstant`); SE figures labeled for the
   8-policy roster with the worst-case bound; migration-index citations
   corrected (the `close_time` rewrite is index 2); Truce copy says "no
   attacks landed"; tests added for malformed hook returns, the permitted
   mid-season change, unknown `rule_id` at insert, and the merged-rejection
   regression.

## Blockers

This spec depends on the tick-runner spec's `tick_context` and should not be
implemented before it. It also **supersedes the wager-economy spec's ownership
of the deploy-inflation exploit** — that fix now lives here, in the allocation
phase. The stale-price exploit remains the wager spec's.
