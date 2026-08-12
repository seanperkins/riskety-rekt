# Balance run — the rule catalogue's bounded-swing gate

**Date:** 2026-08-11 · **Status:** Current for the three-rule catalogue
**Command:** `npm run sim:rules` (`src/sim/rule-gate.ts`)
**Scale:** 10,000 seasons per arm, four arms, 8-policy roster
(Turtle, Blitz, Consolidator, Hunter, Gambler, Slacker, GymRat, Arbitrageur)

Measures the catalogue shipped by
`docs/superpowers/plans/2026-08-11-rule-catalogue-and-voting.md` against the
bounded-swing criterion in
`docs/superpowers/specs/2026-08-10-pluggable-mechanics-design.md`
("Replacing the reversibility test"): **reject any rule moving any policy's
win rate by more than 3 points.**

## Method

Every arm is **paired** with baseline on the same seeds (common random
numbers). The reported SE is the **empirical** standard deviation of the
per-season win-indicator differences divided by √n, not the independence
formula — the spec's own correction. CI is 1.96·SE.

Pairing is load-bearing and was initially wrong. The first implementation drew
the daily vote from the season's main RNG, which shifted the board, the deal,
every slate price and every settlement coin, so the voted arm differed from
baseline mostly for reasons unrelated to rules. The vote now draws from a
separate stream (`makeRng((seed ^ 0x5bf03635) >>> 0)`), so all four arms
consume the main stream identically. `src/sim/run.test.ts` pins this by
asserting the same board and seats across arms. **Any voted-arm figure
produced before that fix is void.**

**Vote model:** each seat abstains with probability ½, else picks uniformly
among the day's offer; plurality wins, ties to the lowest rule id.
Deliberately strategy-free — real players vote strategically, and that is the
largest unmodelled factor in this document.

## Results

### Forced daily — each rule active every day

| Rule | Turtle | Blitz | Consolidator | Hunter | Gambler | Slacker | GymRat | Arbitrageur |
|---|---|---|---|---|---|---|---|---|
| baseline % | 0.01 | 16.84 | 25.82 | 19.39 | 13.27 | 10.86 | 13.74 | 0.07 |
| **boom** | 0.00 | −0.50 | −0.07 | +0.24 | +0.36 | +1.19 | −1.34 | +0.12 |
| **attrition** | **+43.68** | +0.34 | **−15.39** | **−15.98** | **−9.53** | **−10.58** | **−11.59** | **+19.05** |
| **truce** | **+49.30** | +2.72 | **−14.20** | **−16.01** | **−9.34** | **−10.58** | **−11.62** | **+9.73** |

All CIs ≤ ±1.05. **Boom passes on every policy** (max |diff| 1.34).
Attrition and Truce fail on seven of eight.

### The voted regime — drawn and voted daily

| policy | base % | voted % | diff | ±CI95 | verdict |
|---|---|---|---|---|---|
| Turtle | 0.01 | 0.80 | +0.79 | 0.18 | pass |
| **Blitz** | 16.84 | 20.87 | **+4.03** | 0.91 | **FAIL** |
| Consolidator | 25.82 | 25.18 | −0.64 | 1.04 | pass |
| Hunter | 19.39 | 17.69 | −1.70 | 0.92 | pass |
| Gambler | 13.27 | 12.24 | −1.03 | 0.79 | pass |
| Slacker | 10.86 | 9.74 | −1.12 | 0.71 | pass |
| GymRat | 13.74 | 12.57 | −1.17 | 0.83 | pass |
| Arbitrageur | 0.07 | 0.91 | +0.84 | 0.19 | pass |

## Findings

**1. Forced-daily does not upper-bound the voted regime.** Blitz's largest
single forced effect is +2.72 (Truce), yet the voted regime moves it +4.03 —
larger than any rule forced on every day. Scattered rule days are *worse* for
this policy than constant ones. The spec anticipated that forced activation
"explores a different regime" for nonlinear rules; it did not anticipate the
direction. **Do not read the forced arms as a conservative envelope.** The
voted arm is the measurement that counts, and it must be run per catalogue.

**2. The voted regime is not mild.** With 3 rules offered and 8 seats
abstaining at ½, some rule wins on ~99.6% of days. "Voted" therefore means
*a rotating rule every day*, not *a rule occasionally*. That is why its
effects are comparable to the forced arms rather than a fraction of them.

**3. Attrition and Truce forced daily are a different game, and the
redistribution runs anti-snowball.** Turtle — which never attacks and wins
0.01% of baseline seasons — takes 43–49% of seasons when attacking is taxed or
banned outright every day, while every aggressive policy collapses. This is
the *opposite* of the amplification the gate exists to catch: the spec's
discriminator is "whether a dial's effect scales with the acting faction's
existing advantage," and here the advantaged lose. It is nonetheless a game
nobody wants to play, which is what the 3-point gate is really objecting to.

**4. Boom is clean under every measurement.** Maximum movement 1.34 points
forced daily, inside its own CI on most policies.

**5. The catalogue overall compresses the field except at Blitz.** In the
voted regime the two strongest baseline policies fall (Consolidator −0.64,
Hunter −1.70) and the two dead ones rise (Turtle +0.79, Arbitrageur +0.84).
Blitz is the lone outlier, and it is the pure-aggression policy — it profits
when *other* factions' aggression is taxed while its own tempo is unchanged.

## Verdict

**The three-rule catalogue as shipped fails the gate**, on Blitz, in the only
regime a real season can produce. Boom is unconditionally safe; the failure is
a property of the catalogue's *composition*, not of any single rule — no
individual rule moves Blitz by 3 points.

This is recorded as a **failing measurement, not an accepted exception.** The
open decision is between retuning the catalogue (the obvious lever is Truce,
which contributes most of Blitz's gain) and expanding it, since the expansion
already under design changes this measurement structurally: with 13 rules on a
3-per-day ballot, each rule is offered on ~3/13 of days and wins on ~1/13,
diluting per-rule contribution by roughly 4×. **The voted arm must be re-run
against the expanded catalogue before a competitive season**, and this
document's verdict superseded by that run.

## Limitations

- The vote model is uniform-random, not strategic. Real kingmaking could
  amplify or dampen every figure here; the spec calls the vote a strategic
  surface deliberately, and nothing in this run measures that.
- One roster (8 policies), one season length (`SEASON_LENGTH = 14`).
- Baseline is recomputed per arm. Correct but wasteful — four arms cost eight
  arms of compute. Caching it across arms halves the run.
- The engine fix in `7daf232` (a whole-map lock no longer suppresses the
  veto's `protected` events) changes only which events are **logged** — the
  lock set, garrisons, ownership and combat arithmetic are untouched — so the
  figures above are unaffected by it.
