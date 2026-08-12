# Balance run — snowballing, and the strategy the roster could not express

2026-08-12. 10,000 seasons per figure, `SEASON_LENGTH` days, seeds drawn as
`runMany` draws them, boards selected exactly as `season-init` selects them.
Run via `scripts/balance-run.ts`.

This run exists to answer the open question left by
`2026-08-11-balance-run-modules.md`: the day-3 leader converts **39.0%** against
a 16.7% baseline, and Consolidator wins 27.7%. Is that snowballing in the game,
or an artifact of a policy set in which **no policy attacks more than once per
tick**?

The answer is: the 39% is real, the cause is not the one the previous document
named, and looking for it turned up a bigger problem.

## Roster changes

Two policies, both named as follow-ups in `HANDOFF.md`:

- **`Swarm`** — the only policy that attacks on more than one front per tick.
  It costs each border origin against its softest enemy neighbour at
  `need = def + 2 - g`, funds the cheapest fronts first until the reserve runs
  out, and skips a target another front already claims. Measured over 200
  seasons it emits **3.16 attack lines per living tick, maximum 8**; every other
  attacking policy sits at 0.93, maximum 1.
- **`Ghost`** — posts nothing and plays nothing, so it actually reaches zero
  territories, then submits a kingmaker veto that the post gate must refuse.

The authoritative six reproduce the committed 2026-08-11 figures **exactly** —
27.7 / 23.7 / 14.0 / 13.8 / 11.6 / 9.2, day-3 39.0%, mean board 44.3 — so the
new instrumentation consumes no randomness and nothing below is a stream shift.

## Finding 1: the snowball is real, and it is the deal

A mixed roster cannot measure snowballing, because a strong policy is both the
likely day-3 leader and the likely winner: conversion and policy strength are
the same number wearing two hats. **Symmetric rosters remove the confound
entirely** — six seats playing identically, so any day-3 persistence is the
mechanics and nothing else.

Day-3 leader conversion, symmetric seats, board 44.3, baseline **16.7%**:

| policy on all six seats | shipped (contiguous) deal | scattered deal |
|---|---|---|
| Blitz (single-front) | **39.6%** | 25.7% |
| Consolidator (single-front) | **42.0%** | 26.1% |
| Swarm (multi-front) | **36.5%** | 20.5% |

Per-figure SE at n = 10,000 is ≈ 0.5 points, so every gap here is a
measurement.

Two things fall out, and they are the whole finding:

1. **The 39% survives a roster that can punish a leader.** Giving every seat
   multi-front capability moves conversion by −3.1 points (39.6 → 36.5). The
   original worry — that the number was an artifact of five pacifists and one
   aggressor, the same defect as the very first balance run — is **wrong**.
   Conversion sits at 2.2×–2.5× baseline no matter which policy fills the
   seats.
2. **Almost all of it is the contiguous deal.** Scattering the starting
   holdings drops conversion by 13.9 points (Blitz), 15.9 (Consolidator) and
   16.0 (Swarm), to within 4–9 points of baseline. Combat capability is a
   rounding error next to it.

### The previous document named the wrong cause

`2026-08-11-balance-run-modules.md` attributed the drift from the 2026-08-10
figures (day-3 23.4%) to the **troop-movement feature** (`855e6ea`). That
cannot be right, and the check is cheap: `855e6ea` is purely additive — the
combat and validate diffs only run when an order carries `moves` — and **no sim
policy emits a move**. The commit is behaviour-identical for every season this
simulator has ever run.

The actual cause is `ec692fd`, *deal each faction a contiguous holding*, and it
was measured at the time — in the commit message, which reads *"the day-3
leader now goes on to win 46.9% of seasons, up from 37.1%. Defensible holdings
make an early lead persist — which is the mechanic working, and also the number
to watch."* That finding never reached a doc, and a later doc guessed a
different cause for the same drift. The `--shuffled` arm now in
`scripts/balance-run.ts` is how that claim stays checkable rather than
remembered.

**So: is 39% too high?** That is a design call, not a bug, and it is the same
call `ec692fd` already made deliberately. What this run adds is the price tag
and the lever. The cheapest dial is deal contiguity — the anti-snowball
mechanisms already in the engine (the 1:1 loss ratio, the departure cost, the
underdog rules) all act on combat, which the table above shows is not where the
persistence comes from.

## Finding 2: multi-front attack is a dominant strategy

This is the more urgent result, and it is not about snowballing at all.

`Swarm` against the five other authoritative policies, six seats, board 44.3:

| policy | wins | baseline | mean territories |
|---|---|---|---|
| **Swarm** | **71.4%** | 16.7% | **15.6** |
| Consolidator | 13.2% | 16.7% | 7.9 |
| Hunter | 7.0% | 16.7% | 5.9 |
| GymRat | 3.2% | 16.7% | 5.4 |
| Slacker | 2.9% | 16.7% | 4.7 |
| Gambler | 2.3% | 16.7% | 4.9 |

4.3× baseline, and more than double an even split of the board. On the
eight-seat roster it is 71.5% against a 12.5% baseline. On a scattered deal it
reaches **86.8%** — a looser map has more borders, so more fronts to press, and
the contiguous deal is the only thing currently holding it back.

The spec's stated property is *no dominant strategy*, evidenced by a 9.1%–20.8%
spread across six policies. That evidence was measured over a policy set where
every member voluntarily attacked once per tick. Nothing in the engine required
that — `Swarm` breaks no rule, exploits no bug, and its orders draw **no cap
rejections at all** across 2,800 simulated ticks (the only rejections it sees
are protected targets, 27 of them, from attacking more often). It is simply
better play, and it is the first thing a human will find, probably on day two.

This is the cautionary tale in `HANDOFF.md` firing a second time. The first
balance run measured one aggressor against four pacifists and reported
confident numbers about nothing. This one measured six single-front players and
reported a strategy spread that did not include the strongest legal strategy.
**A simulation measures the policies you wrote.**

## Finding 3: the veto post gate now has coverage

`Ghost` ends eliminated in **40.4%** of its seat-seasons. Across the eight-seat
run it offered **16,708** vetoes, of which **15,815 were dropped by the post
gate** and the rest reached the parity rule.

Before this run the gate was effectively untested in simulation: on the
authoritative six the whole roster survived (worst elimination rate 0.8%,
Slacker), producing 696 offers and 287 gated over the same 10,000 seasons. The
`vetoesOffered` / `vetoesGated` / `protectionsApplied` counters are new on
`Report`, and `vetoesGated` is read **before** `resolve` on purpose: an offer
the gate refuses leaves no trace in the log at all, so there is nowhere else to
observe it.

## What this run does NOT cover

- **Whether `Swarm` should be nerfed, and how.** Naming the dial is out of
  scope here; the run establishes that one is needed. Candidates worth
  measuring: a per-tick attack limit, a per-faction (not per-origin) departure
  budget, or making `attackDepartureCost` a standing cost rather than a rule.
- **`Swarm` under the rule catalogue.** The bounded-swing gate
  (`2026-08-11-balance-run-rules-expanded.md`) was measured on the
  authoritative six and has not been re-run with `Swarm` seated. Note also that
  every existing policy commits its full `garrison − 1`, so on a `Leg Day`
  (`attrition`) day the departure fee rejects its attack outright — the sim's
  policies do not budget for the dial, which likely overstates that rule's
  effect for all of them.
- **The IRL channel.** Unchanged by this run; the open design call in
  `HANDOFF.md` stands.
