# Balance run — the expanded rule catalogue

**Date:** 2026-08-11 · **Status:** Current. **Supersedes**
`2026-08-11-balance-run-rules.md`, whose figures describe the three-rule
catalogue on a three-of-three ballot.
**Command:** `npm run sim:rules` (`src/sim/rule-gate.ts`)
**Scale:** 10,000 seasons per arm, fourteen arms, 8-policy roster
(Turtle, Blitz, Consolidator, Hunter, Gambler, Slacker, GymRat, Arbitrageur)

## Verdict

**PASS.** Thirteen rules on a three-slot daily ballot move no policy's win rate
by more than 3 points in the voted regime. The catalogue is shippable, and
*Truce* — the cut the expansion design held in reserve — is **not** cut.

| policy | base % | voted % | diff | ±CI95 |
|---|---|---|---|---|
| Turtle | 0.01 | 0.02 | +0.01 | 0.03 |
| Blitz | 16.84 | 17.57 | **+0.73** | 0.85 |
| Consolidator | 25.82 | 24.69 | −1.13 | 0.98 |
| Hunter | 19.39 | 19.24 | −0.15 | 0.88 |
| Gambler | 13.27 | 13.34 | +0.07 | 0.77 |
| Slacker | 10.86 | 11.60 | +0.74 | 0.70 |
| GymRat | 13.74 | 13.36 | −0.38 | 0.80 |
| Arbitrageur | 0.07 | 0.18 | +0.11 | 0.09 |

Largest movement 1.13 points, comfortably inside the gate and inside its own CI
on six of eight policies.

## The finding this run was commissioned to test

The three-rule catalogue failed on **Blitz at +4.03 (CI [3.12, 4.94])**. No
single rule caused it — it was composition, and *Truce* contributed most.
The expansion's thesis was that diluting each rule's share of days would clear
it without cutting anything: with 3 rules on a 3-slot ballot a given rule wins
~1/3 of days; with 13 rules it wins ~1/13.

**The thesis held.** Blitz: **+4.03 → +0.73**, a CI that now straddles zero.
The same dilution pulled every other policy toward baseline as well —
Consolidator −14.20 (Truce forced) and −0.64 (3-rule voted) becomes −1.13.

## Forced-daily diagnostics

Forced arms are diagnostics, not the verdict — the previous run established
that they do not upper-bound the voted regime (Blitz's voted movement exceeded
every forced arm). They identify which rules carry weight.

**Eight rules pass forced-daily outright**, every policy inside 3 points:
`boom`, `bring-a-friend`, `diamond-hands`, `gains`, `main-character`,
`touch-grass`, `eat-the-rich`, `underdog`.

**Five have at least one forced failure:**

| rule | worst policy | diff | reading |
|---|---|---|---|
| `truce` | Turtle | **+49.30** | a permanent no-attack game; Turtle 0.01% → 49.31% |
| `attrition` | Turtle | **+43.68** | taxing every attack, every day, approaches the same thing |
| `regional-manager` | Consolidator | −4.04 | closing the most contested region blocks region completion |
| `sole-survivor` | Consolidator | +3.61 | protecting one-troop territories preserves partial regions |
| `too-big-to-fail` | Consolidator | −3.56 | locking each faction's capital denies the decisive target |

The three new lock rules all land on **Consolidator specifically**, and in both
directions — `sole-survivor` helps it, the other two hurt it. That is coherent
rather than alarming: Consolidator is the only policy whose objective is
completing regions, so rules that gate access to territory bear on it hardest.
None approaches the magnitude of `truce` or `attrition`, and all three sit
inside the gate once diluted to a 1/13 share.

`truce` and `attrition` remain the catalogue's heavy rules, and their
redistribution still runs **anti-snowball** — the leader-most policies lose and
the passive one gains, the opposite of the amplification the gate exists to
catch.

## A defect this run exposed

The first attempt at this measurement was **void and was killed mid-run.** The
simulator's voted arm drew a **nine**-rule ballot while production had just
moved to **three**. Since each rule's share of days is the entire balance
argument for expanding, the gate would have cleared the catalogue on a dilution
the season never applies — the same class of defect as measuring balance on a
map no season is dealt from.

`RULES_PER_OFFER` now lives in `src/config.ts` and both the offer job and the
simulator read it. `src/config.test.ts` fails if either re-hardcodes a slice
width. The figures above come from the corrected run.

## Method

Unchanged from the previous run except where noted:

- Every arm is **paired** with baseline on the same seeds (common random
  numbers). The vote draw uses a separate RNG stream so all arms consume the
  main stream identically — the board, deal, prices and settlement coins are
  the same season in every arm.
- The reported SE is the **empirical** sd of per-season win-indicator
  differences over √n, not the independence formula. CI is 1.96·SE.
- **New:** baseline is computed once and shared across all fourteen arms
  (`baselineWinners`), turning 28 sweeps into 15. `src/sim/run.test.ts` pins
  that cached and recomputed baselines give identical `GateResult`s.
- **Vote model:** each seat abstains with probability ½, else picks uniformly
  among the day's three; plurality wins, ties to the lowest rule id.

## Limitations

- **The vote model is uniform-random, not strategic.** This is the largest
  unmodelled factor and it cuts both ways: real players would concentrate votes
  on whichever rule helps them, which could push a rule's realised share well
  above 1/13 on the days it matters most. The dilution this verdict rests on is
  a property of *random* voting. A coordinated group could reproduce something
  closer to the forced-daily arms for a rule they all want, and nothing here
  measures that.
- One roster (8 policies), one season length (`SEASON_LENGTH = 14`).
- Forced-daily remains stress evidence, not a bound, for nonlinear rules.
- `needs`-gated rules (`gains`, `diamond-hands`) were measured with all modules
  enabled. In a markets-off or irl-off season they leave the ballot, which
  changes every other rule's share — unmeasured.
