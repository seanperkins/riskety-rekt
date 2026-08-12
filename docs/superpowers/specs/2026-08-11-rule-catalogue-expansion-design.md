# Rule Catalogue Expansion — Design

**Date:** 2026-08-11 · **Status:** Drafted, awaiting review
**Extends** `2026-08-10-pluggable-mechanics-design.md`. Depends on the shipped
rule catalogue and voting (plan `2026-08-11-rule-catalogue-and-voting.md`).

## Why

Two reasons, and the second is the load-bearing one.

1. Three rules is the minimum the spec's own kill criterion tolerates
   ("if the catalogue ever holds fewer than three rules, delete the apparatus").
   A catalogue sitting exactly on its floor has no margin: cutting one rule for
   balance would unwind the whole vote system.
2. **The shipped catalogue fails its bounded-swing gate.**
   `reviews/2026-08-11-balance-run-rules.md` measures Blitz at **+4.03 points
   (CI [3.12, 4.94])** in the voted regime, past the 3-point gate. No single
   rule causes it — it is composition, mostly Truce. Expanding the catalogue
   dilutes every rule's share of days, which is the remedy that costs no rule.

## What the hooks can express

Bounded before any candidate was written, by tracing `resolve.ts`. A rule has
**three** levers:

| Lever | Signature | Reach |
|---|---|---|
| `grant` | `(state, ctx) → Contribution[]` | adds soldiers to reserves |
| `lock` | `(state, orders, ctx) → LockResult[]` | blocks attacks into territories |
| `combatDials` | `(state, ctx) → {attackDepartureCost}` | 0–2, summed then clamped |

Four constraints follow, and each killed at least one candidate:

- **`grant` receives no orders.** No rule can reward or punish what a player
  declared today with soldiers.
- **`lock` DOES receive orders.** Lock-based rules can react to today's
  declarations. This is where *No Man's Land* comes from.
- **`amount` is a non-negative integer** (`checkContribution`). No rule can
  reduce income. "Tax the leader" must be expressed as "pay everyone else".
- **`validate` is not a lever.** `resolve.ts:87` acts only on `protect`-field
  rejections; anything else a `validate` hook returns is logged and ignored.
  Every "you may only attack from one territory today" rule is therefore
  unimplementable — the *Amnesty* failure mode, rediscovered.

One further pure input: **`state.log` on entry is yesterday's event log**,
which makes history-aware rules reachable.

The dial set stays closed. Casualty ratios, defense bonuses, adjacency and
ownership changes are not dials, now or later.

## The ten rules

Each is a pure function of its arguments, adds no `TickEvent` variant, and
needs no engine change. Grants log through the existing generic `grant` event,
so the two-sided conservation accounting counts them with no new work.

| # | Rule | Hook | Behavior | Determinism |
|---|---|---|---|---|
| 1 | **Underdog** | `grant` | the fewest-territory faction(s) gain 3 | min over non-eliminated factions; every tie paid |
| 2 | **Tribute** | `grant` | every faction except the leader(s) gains 2 | max territory count; all tied leaders excluded. If every surviving faction is tied, nobody is paid — the rule is a no-op that day, deliberately, since there is no leader to tax |
| 3 | **Peace Dividend** | `grant` | factions that logged no attack yesterday gain 3 | `state.log` `attack.attacker` set; day 1 pays everyone (empty log) |
| 4 | **Conscription** | `grant` | every surviving faction gains 3 | flat; skips zero-territory factions like core income |
| 5 | **Sanctuary** | `lock` | territories holding exactly 1 troop cannot be attacked | garrisons read post-allocation |
| 6 | **Ceasefire** | `lock` | one region is closed to attacks | region with most distinct owners, region-id tiebreak |
| 7 | **Fortress** | `lock` | each faction's largest garrison is locked | per faction max garrison, territory-id tiebreak |
| 8 | **No Man's Land** | `lock` | the most-attacked territory *today* is locked | attack count per `to` across orders, territory-id tiebreak. A day with no attacks locks nothing and logs nothing |
| 9 | **Rally** | `grant`, `needs:["irl"]` | factions that posted a workout gain 2 | `ctx.postedToday` |
| 10 | **Bull Run** | `grant`, `needs:["markets"]` | factions holding a pending wager gain 1 | `pendingWagersOf(state)`, the markets module's exported helper |

**Sanctuary's timing is deliberate and must be documented in its own comment.**
`lock` runs at step 4, *after* allocation, so garrisons include today's
deploys. Deploying into a sanctuary forfeits its protection, and a player who
wants the protection must leave the territory at one troop. That is a real
decision, not a quirk — but it is the kind of thing a later reader "fixes".

**Event volume.** *Sanctuary*, *Ceasefire* and *Fortress* can lock many
territories, so like *Truce* they supply **no** per-territory events; the recap
names the rule. *No Man's Land* locks exactly one and supplies its `protected`
event. This depends on commit `7daf232`: event suppression is keyed on
already-logged territories, not lock-set membership, so an eventless whole-map
lock no longer swallows the veto's `protected` events.

**Rules 9 and 10 are the first consumers of `needs`**, which has had none. They
exercise the offer filter in a real season: with `markets` off, *Bull Run* is
never offered rather than offered-and-inert.

### Cut, with reasons

- ***Revenge*** — "factions that lost a territory yesterday gain troops."
  **Unimplementable.** Yesterday's `attack` event carries `attacker` and `to`
  but not who owned `to`, and `state.ownership` is already post-capture. The
  victim of a capture is not derivable from any pure input. *Peace Dividend*
  is the surviving rewrite, keyed on what is attributable.
- ***Total War*** — departure cost 2. Traces cleanly, cut deliberately:
  *Attrition* at cost 1 already moves win rates 15+ points forced daily, so
  cost 2 spends 20k seasons confirming a predictable failure.
- ***Drought / Famine*** — halved income. `grant` cannot subtract. Expressible
  only as a `spend` claim, which would destroy soldiers with no `escrowed`
  slot to account for them and would break the two-sided conservation test.

## The ballot

`RULES_PER_OFFER = 3` replaces the hardcoded `.slice(0, 9)` cap in
`publish-rules.ts`. Everything else about the offer is unchanged: the seeded
per-day draw, claim-then-post, and the recovery path that replays the
**stored** draw rather than redrawing.

Why 3 and not "all eligible":

- With ~13 rules and 8 players, a 9-option ballot decides most days by one or
  two votes with ties falling to the lowest rule id, and 4 rules are truncated
  away every single day.
- Three options against ~8 voters produce real pluralities.
- Scarcity becomes strategy: "Underdog is on today's ballot" is itself an
  event.
- Over 14 days each rule appears on ~3 ballots. About a 2.6% chance a given
  rule never appears in a season — texture, not a defect.

## Balance

**The voted arm is the verdict. Forced arms are diagnostics.** This is a
change of standing from the original spec, forced by a measurement: Blitz's
voted movement (+4.03) exceeded every per-rule forced arm (max +2.72), so
forced-daily does **not** upper-bound the voted regime and a per-rule forced
pass cannot clear a catalogue. Forced arms stay worth running — they identify
which rule is hot — but they do not decide.

Gate unchanged otherwise: 10,000 seasons per arm, pinned seeds, paired
difference with the **empirical** SE and a 95% CI, reject beyond 3 points on
any policy.

**Success criterion for this work: the expanded catalogue's voted arm passes
on all eight policies.** If it does not, cut *Truce* first — it contributes
most of Blitz's gain — and re-measure. That fallback is recorded now so it is
not relitigated under time pressure later.

**Baseline caching.** `runGate` recomputes a fresh baseline per arm. At 14 arms
that is 28 arm-runs where 15 suffice. The seeds are identical, so the cached
baseline is the same computation — roughly three hours becomes ninety minutes,
with identical numbers.

## Testing

1. **Per-rule unit tests**, one per rule, asserting the traced behavior and its
   tiebreak: every tie paid (*Underdog*), all tied leaders excluded
   (*Tribute*), empty-log day 1 pays everyone (*Peace Dividend*), post-allocation
   garrisons (*Sanctuary* — a deploy into a 1-troop territory forfeits it),
   most-contested region (*Ceasefire*), per-faction max with id tiebreak
   (*Fortress*), most-attacked-today with id tiebreak (*No Man's Land*).
2. **Catalogue validation** still refuses duplicates, module-id collisions,
   over-long descriptions and unknown `needs` — now with 13 entries.
3. **The `needs` filter with real consumers**: a markets-off season never
   offers *Bull Run*; an irl-off season never offers *Rally*. This replaces the
   synthetic rule the current test needs.
4. **Ballot size**: an offer holds exactly `RULES_PER_OFFER` rows; the draw is
   deterministic per (season seed, day); a recovery re-post replays the stored
   draw rather than redrawing.
5. **Zero engine change** is itself an assertion: the golden file must not
   move, and `npm test` must stay green without regenerating it.
6. **The gate refactor is behavior-preserving**: cached-baseline and
   fresh-baseline runs return identical `GateResult`s at small N.
7. **The expanded voted arm at 10k**, recorded in a new balance review doc that
   supersedes `2026-08-11-balance-run-rules.md`.

## What this breaks

- **The current balance review doc is superseded** the moment the catalogue
  changes; its voted-arm figures describe a 3-rule catalogue on a 3-of-3
  ballot.
- **The offer message changes shape** from up-to-9 rows to exactly 3. The
  renderer needs no change; its test's expectations do.
- Nothing else. No engine change, no migration, no store change, no
  `TickEvent` change, no golden regeneration.
