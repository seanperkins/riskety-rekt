# Balance run — the pluggable-mechanics module system

2026-08-11. Authoritative roster `Blitz, Consolidator, Hunter, Slacker, GymRat,
Gambler`, selected world boards, 14 days, seeds drawn as `runMany` draws them.
Run via `scripts/balance-run.ts`.

## The headline: the module system is behavior-identical

The migration to module dispatch — the allocation phase, seniority ordering,
merge-then-validate, locks-before-validation, the moduleState move — was
verified **behavior-neutral for the simulated game** by direct comparison:

- New engine, 2,000 seasons: Consolidator 29.0, Hunter 21.8, GymRat 14.4,
  Blitz 13.1, Gambler 12.2, Slacker 9.6; day-3 leader converts 39.3%.
- **Old engine (main at `855e6ea`), same seeds: byte-identical results.**

Two probes back this up:

1. Inverting claim seniority (deploys senior, the pre-fix ordering) changed
   **nothing** — the sim's policies budget wagers inside their reserve, so the
   allocation ordering never fires in simulated play. The seniority fix
   matters exactly where it was designed to: a human deliberately
   over-committing at 20:59, which the engine tests pin
   (`resolve.test.ts` "seniority" and the phantom-troop case).
2. Merge-then-validate's all-or-nothing rejection never fires either — every
   policy emits at most one attack line per direction. Its regression test
   (`dial.test.ts`) is the evidence for that behavior change, not this run.

## The committed record, 10,000 seasons

| policy | wins | baseline | mean territories |
|---|---|---|---|
| Consolidator | 27.7% | 16.7% | 8.7 |
| Hunter | 23.7% | 16.7% | 7.8 |
| Blitz | 14.0% | 16.7% | 7.3 |
| GymRat | 13.8% | 16.7% | 7.1 |
| Gambler | 11.6% | 16.7% | 6.8 |
| Slacker | 9.2% | 16.7% | 6.6 |

Mean board 44.3 territories. Day-3 leader converts **39.0%** against a 16.7%
baseline. At n = 10,000 the per-run SE is ≈ 0.35–0.45 points per policy, so
these figures are measurements, not noise.

## A finding about the PREVIOUS document, not this change

`2026-08-10-balance-run-world.md` reports Hunter 20.4 / GymRat 18.9 /
Consolidator 18.9 / Gambler 16.6 / Blitz 16.5 / Slacker 8.8 and day-3
conversion 23.4%. Today's numbers differ by up to +10 points (Consolidator)
and +16 points (day-3 conversion) — **and none of that is this change**, since
old and new engines agree exactly. The drift happened on `main` between that
document and HEAD: the **troop-movement feature** (`855e6ea`, landed the day
after the doc) changed combat outcomes broadly — movers arrive before combat
and defend the destination — and the balance run was never redone for it.

Consequences worth acting on, carried forward to the rule-catalogue plan's
balance work:

- **Consolidator at 27.7% and day-3 conversion at 39%** are real, current
  properties of the game as shipped, not artifacts of this refactor. The
  anti-snowball question deserves a fresh look before a competitive season.
- The 2026-08-10 document should be read as describing the pre-moves game.

## What this run does NOT cover

Per-rule forced runs (the 3-point bounded-swing gate) belong to the
rule-catalogue plan — no rules exist yet. The gate's method is specified in
the design doc: 10,000 seasons per arm, same pinned seeds both arms, report
the empirical paired SE.
