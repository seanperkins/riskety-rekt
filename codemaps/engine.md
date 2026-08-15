> Generated: 2026-08-11 | Token-lean format for LLM context

# Engine (`src/engine/`)

Pure. Zero imports outside the folder, no I/O, no clock, no randomness, input
state never mutated. `ENGINE_VERSION = "1.1.0"`. Barrel: `index.ts`.

## The tick

```ts
resolve(state: GameState, orders: Order[], context: DailyContext): GameState
```

Pipeline, `src/engine/resolve.ts` — fixed order, mechanics never reorder it:

| # | Step | Detail |
|---|---|---|
| 1 | grant | core `territoryIncome` (0 for eliminated), then every active module's `grant` hook, ONCE — settlement payouts live inside markets' grant |
| 2 | claims | `validateOrder` (shape/legality only) + module `validate` hooks; then the claim list: one core claim per deploy (`lockedAt = ctx.tickInstant`) plus every `spend` hook's claims |
| 3 | allocate | ALL claims by ascending **parsed** `lockedAt` (ties: mechanic id — core is `""` — then index); a claim that no longer fits DROPS with a `rejected` event carrying `ref`; honored deploys LAND here |
| 4 | locks | union of `lock` hooks (`LockResult[]`); engine logs each first-seen territory's event; attacks into locked territories void in combat — no cap, no fee |
| 5 | movement validation | inside `resolveCombat`, against POST-ALLOCATION garrisons: moves per line (fee-free, moves-first), attacks **merged by (from,to) then capped** — each movement consumes `count + attackDepartureCost` from the shared `garrison − 1` ledger; over-cap merged movements reject whole |
| 6 | combat | reinforcements → field battles → simultaneous attacks, parameterized by the merged dial |
| 7 | advance | each stateful module returns its complete next `moduleState[id]`, seeing ITS OWN honored claims |

`active` = `validateModules(ctx.modules)` ∪ `validateRules(ctx.rules)`, id-sorted.
Modules are season-scoped, rules day-scoped; dispatch is identical.

Why this order (all panel-reviewed, all pinned by tests):

- **Allocation before movement validation**: caps derive from post-deploy
  garrisons; a deploy dropped after validation leaves an attack legal for
  troops that never arrived (phantom troops).
- **Seniority is the deploy-inflation fix**: a wager locks at its market's
  close (strictly < tick; `WINDOW_CLOSE_HOUR = 21 < 24` since the boundary
  moved to midnight, asserted as an inequality in
  `config.test.ts`), so a 20:59 deploy can no longer evict a locked wager.
- **Locks before caps**: a voided attack must not crowd out a valid one.
- Malformed hook returns (negative/fractional amount, unknown faction,
  unparseable `lockedAt`) THROW — the tick refuses.
- Faction/order/mechanic iteration is id-sorted throughout; replay is exact.

## The Mechanic contract (`mechanics.ts`, `registry.ts`, `modules/`)

```ts
Mechanic { id, grant?, spend?, validate?, lock?, combatDials?, advance?, escrowed? }
Contribution { faction, amount, event }          // amount: non-negative int
SpendClaim   { faction, amount, lockedAt, ref, event? }  // event logged only when honored
LockResult   { territory, event? }               // veto: protected+byCount; a whole-map lock omits events
CombatDials  { attackDepartureCost }             // sum across mechanics, clamp 0..MAX_DEPARTURE_COST(2)
```

`validateModules(enabled, MODULE_REGISTRY)`: unknown/duplicate ids refused,
`veto` without `irl` refused (hardcoded, no `requires` field), `advance`
without `escrowed` refused (the one-sided invariant can't see uncounted escrow).

## Rules (`rules/`) — the voted daily catalogue

```ts
Rule extends Mechanic { id, name, description, needs? }   // needs = OFFER filter
```

A rule is a mechanic with a one-day lifetime. `resolve` merges
`validateRules(ctx.rules, RULE_REGISTRY)` into `active` and id-sorts the union,
so rules dispatch through the same hooks as modules — the only engine change.
Namespaces are separate registries and validated separately: a module id in
`ctx.rules` is an "unknown rule", and `buildCatalogue` refuses a rule id that
collides with a module id.

Thirteen rules ship. **Ids are permanent** — frozen into
`tick_context.context.rules` and logged as `grant.source` — while `name` and
`description` are read from the registry at render time and may change freely.
That is why the first three keep bland ids under witty names.

| id | Name | Hook | Effect |
|---|---|---|---|
| `boom` | Quantitative Easing | grant | recomputes core `territoryIncome` and grants it again |
| `attrition` | Leg Day | combatDials | `{attackDepartureCost: 1}` — the one flat dial |
| `truce` | Log Off | lock | every territory, no per-territory events |
| `underdog` | Participation Trophy | grant | +3 to the fewest-territory faction(s); EVERY tie paid |
| `eat-the-rich` | Eat the Rich | grant | +2 to everyone but the leader(s); no-op when all tied (no leader to tax) |
| `touch-grass` | Touch Grass | grant | +3 to factions with no `attack` in YESTERDAY's `state.log`; empty log = day 1 = everyone |
| `bring-a-friend` | Bring a Friend | grant | +3 flat to every survivor |
| `sole-survivor` | Sole Survivor | lock | garrisons of exactly 1 — read POST-allocation, so a deploy forfeits it |
| `regional-manager` | Regional Manager | lock | the region with the most distinct owners, region-id tiebreak |
| `too-big-to-fail` | Too Big to Fail | lock | each faction's largest garrison, territory-id tiebreak |
| `main-character` | Main Character Energy | lock | today's most-attacked territory (reads ORDERS), with its `protected` event |
| `gains` | Gains | grant, `needs:["irl"]` | +2 to factions in `ctx.postedToday` |
| `diamond-hands` | Diamond Hands | grant, `needs:["markets"]` | +1 to factions holding a pending wager, via `pendingWagersOf` |

Only `main-character` supplies a lock event — it locks exactly one territory.
The other lock rules stay silent because a whole-map or whole-region lock would
bury the log; the recap names the rule instead.

**`grant` receives no orders; `lock` does.** That asymmetry is why
`main-character` is a lock and why no rule can pay out on today's declarations.
`grant` also cannot subtract (`amount` is a non-negative integer), so "tax the
leader" is written as "pay everyone else".

`buildCatalogue` runs at import and throws on: duplicate id, module-id
collision, empty name, description outside 1..`RULE_DESCRIPTION_MAX_CHARS`
(100), or a `needs` entry naming an unregistered module — an unknown `needs`
refuses at catalogue load rather than silently filtering the rule out of every
offer forever. `eligibleRules(modules)` is the offer filter; the engine itself
never reads `needs`.

| Module | Hooks | State |
|---|---|---|
| `markets` | grant (settlements, losses log at amount 0), spend (`lockedAt` = slate close), advance (keep unsettled + append HONORED escrow only), escrowed | `{ pending: PendingWager[] }` |
| `irl` | grant (`irlGrants`: ≤2 actions @ +1, Early Bird + Under the Wire, one bonus/player) | — |
| `veto` | lock (parity over eliminated POSTERS), validate (protect legality) | — |

Module-owned helpers (`modules/index.ts`): `marketsStateOf` (validating
parser), `marketIdsOf` (jobs' settlement set), `pendingWagersOf` (sim's read
view). "Owner-only access" = only module code interprets the slot, wherever
called from. `moduleState` is rebuilt from ACTIVE modules each tick, so a
disabled module's slot drops at the next tick; re-enable starts fresh.

## Combat (`combat.ts`)

```
void    locked targets drop first: rejected{reason:"protected", ref} — no cap, no fee
moves   per line vs shared ledger; then all departures sum before any arrival lands
merge   attacks by (from,to); cap each movement: count + fee ≤ remaining(garrison − 1)
6b      field battles on mutual edges: smaller dies, larger continues at a − 2·min
6c      departure: garrison −= committed + fee (fee troops are casualties)
6d      per target (post-departure defense): total ≤ defense → all attackers die;
        else allocateCasualties (exactly D, largest-remainder), top survivor takes it,
        losing factions' survivors withdraw home (ALIVE — not casualties)
```

Event accounting (feeds the two-sided invariant):

- EVERY departed movement emits its `attack` event — one annihilated in a
  field battle keeps zero strength so its `fee` stays in the log.
- `attack.lost` = target-combat casualties only (per-faction split across legs
  largest-remainder by leg size); field-battle deaths live in
  `fieldBattle.aLost/bLost` exclusively.
- `attack.defenderLost` logs ONCE per contested territory, on the surviving
  arrival with the lexicographically-first `from` (else legs × defense).

## Wagers (`wagers.ts`)

```
HOUSE_BONUS = 1.1   REFUND_AFTER_TICKS = 2   PRICE_FLOOR = 0.1   PRICE_CEIL = 0.9
payout(stake, price) = round(stake / clamp(price) * 1.1)     // round, not floor
```

Settlement is **credit-only** (the stake left at escrow); unsettled ≥2 ticks
refunds; `wagerSettle` events carry `stake`, `faction` and `marketId` so the
recap can name who/which and accounting can classify
win (`payout − stake` created) / refund (net zero) / loss (`stake` destroyed).
Price comes from the WAGER when present (placement price), else the slate.

## Order validation (`validate.ts`)

Shape and legality only; field-level rejection, never throws on player data.
Deploys: count + ownership. Moves/attacks: count, ownership, adjacency, target
side. Wagers: count, side, slate membership, **one wager per market** (the
both-sides hedge is risk-free +10%/day). NOT here anymore: reserve budgeting
(→ allocation), movement caps (→ combat), protect legality (→ veto module).

## Tests

`golden.test.ts` replays `__golden__/season-1.json` from a fixed order script —
20 days, phase 2 hunts f4 to ELIMINATION and the finale exercises the parity
veto, so `protected` and voided-attack events are pinned. `invariants.test.ts`:
garrisons/reserves ≥ 0 (with a dial-active variant and `moves` in the
arbitrary), the one-sided creation bound, and the **two-sided accounting
equality** `totalOf(next) === totalOf(before) + created − destroyed` with
`totalOf` summing garrisons + reserves + each module's `escrowed`.
`modules/dial.test.ts` carries the review panel's worked cases;
`modules/matrix.test.ts` the isolation matrix and hook-refusal paths.
