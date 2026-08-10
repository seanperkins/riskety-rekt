> Generated: 2026-08-10 | Token-lean format for LLM context

# Engine (`src/engine/`)

Pure. Zero imports outside the folder, no I/O, no clock, no randomness, input
state never mutated. `ENGINE_VERSION = "1.0.0"`.

Barrel: `src/engine/index.ts` re-exports every symbol below plus `export * from "./types.js"`.

## The tick

```ts
resolve(state: GameState, orders: Order[], context: DailyContext): GameState
```

Seven steps, `src/engine/resolve.ts`:

| # | Step | Detail |
|---|---|---|
| 1 | Settle matured wagers | `settleAll` — **credit only** |
| 2 | IRL grants | `irlGrants(context.approvals)` |
| 3 | Territory income | `territoryIncome`, 0 for eliminated factions |
| — | **Validate** | `validateOrder` against the *post-income* reserve |
| 4 | Deploys | garrison += count, reserve −= count |
| 5 | Escrow new wagers | reserve −= total stake |
| 6 | Combat | `resolveCombat` against post-deploy garrisons |
| 7 | Season-end check | caller's job, not the engine's |

Validation runs after 1–3 on purpose: income earned this tick is spendable this
tick. Validating against yesterday's reserve rejects every deploy from a faction
that started at zero. Faction and order iteration is sorted by id throughout so
replay is deterministic. Throws if any reserve ends negative.

## Files

| File | Exports | Rules encoded |
|---|---|---|
| `types.ts` | all core types, `ENGINE_VERSION` | see `codemaps/data.md` |
| `map.ts` | `RISK_MAP` | 42 territories, 6 continents (na 5, sa 2, eu 5, af 3, as 7, au 2) |
| `setup.ts` | `createSeason`, `territoriesOf`, `continentBonusesFor` | day-0 deal: round-robin over a **pre-shuffled** id list, 2 troops each, reserves 0 |
| `income.ts` | `territoryIncome` | `max(5, floor(t/2)) + continent bonuses`; **0 territories → 0** |
| `irl.ts` | `irlGrants`, `IrlGrant` | ≤2 actions @ +1; Early Bird (first **post**) and Under the Wire (last approval); max one bonus per player |
| `wagers.ts` | `payout`, `escrow`, `settleAll`, `HOUSE_BONUS`, `REFUND_AFTER_TICKS`, `PRICE_FLOOR/CEIL` | |
| `validate.ts` | `validateOrder` | field-level rejection, never throws on player data |
| `casualties.ts` | `allocateCasualties`, `Force` | |
| `combat.ts` | `resolveCombat` | protections → field battles → simultaneous attacks |

## Wagers

```
HOUSE_BONUS = 1.1   REFUND_AFTER_TICKS = 2   PRICE_FLOOR = 0.1   PRICE_CEIL = 0.9
payout(stake, price) = round(stake / clamp(price) * 1.1)
wagerId = `${day}-${factionId}-${seq}`
```

- `round`, not `floor`: under `floor` the +10% edge only existed above `10p`;
  below that it was negative-EV, worst case ≈ −45% just above p=0.55.
- Settlement is **credit-only**. The stake left the reserve at escrow; a loss
  returns nothing. "Credit or debit" charges losers twice.
- Unsettled ≥2 ticks → stake refunded. Maturity counts ticks, not hours, so DST
  cannot move the boundary.
- Price comes from the slate by side at escrow time (`priceYes` / `priceNo`).
- The clamp equals the slate's price filter (`src/config.test.ts` asserts it), so
  it can only fire on a filter bug.

## Order validation (`validateOrder`)

Rejection is per line item — a bad entry is dropped, the rest of the order stands.
Whole-order rejection would be a griefing lever. Emits `{ t: "rejected" }` events.

| Field | Checks |
|---|---|
| `deploys` | safe non-zero int; owns territory; running total ≤ reserve |
| `attacks` | safe non-zero int; owns origin; target not friendly; target adjacent; per-origin total ≤ `postDeployGarrison − 1` |
| `wagers` | safe non-zero int; side ∈ yes/no; market on today's slate; **at most one wager per market**; total ≤ `reserve − deploys` |
| `protect` | only if `territoriesOf(state, f).length === 0`; must be a real territory |

**One wager per market per faction is not a convenience limit.** Staking `k·p`
YES and `k·(1−p)` NO returns `1.1k` on an outlay of `k` regardless of outcome —
a risk-free +10%/day compounding to 7.4× over a season.

## Combat (`resolveCombat`)

```
6a  protections   protect ∧ posted ∧ 0 territories → pick; odd pick count = protected
6b  field battles  mutual edges: smaller force dies, larger continues at a − 2·min
6c  departure      every committed troop leaves the origin, including field-battle dead
6d  targets        allied legs merge per faction; if total ≤ defense all attackers die
                   else allocateCasualties, top survivor takes the territory,
                   other factions' survivors withdraw to their origins
```

- Duplicate `(from, to)` legs merge into one movement. A protected target voids
  the attack entirely — those troops never leave home.
- **A territory defends with its post-departure garrison.** Troops ordered out
  have left.
- Mutual attack rule replaced "both lose `min(a,b)`, neither changes hands",
  which let a 1-troop feint void a 100-troop assault and froze the map.
- `allocateCasualties`: total casualties equal **exactly** `defense`, split
  pro-rata by largest-remainder rounding, ties on lower faction id. Applying the
  full defense to each attacker independently lets a 4-troop garrison kill 8 and
  breaks conservation.
- **Both halves of the protect gate live here on purpose.** The golden file only
  pins what crosses the engine boundary, so filtering `protect` in the tick
  runner would let a regression replay green forever. The veto gates on
  `postedToday`, not `approvals` — gating on approval would give living factions
  a reason to withhold the 👍 from someone whose veto they fear.

## Tests

`golden.test.ts` replays `__golden__/season-1.json` — a **fixed order script**,
not sim policies, so tuning a policy cannot break the engine's regression test.
It exercises no protections (nobody reaches zero territories in the scripted ten
days); `combat.test.ts` covers that path. `invariants.test.ts` and
`fast-check` property tests cover conservation.
