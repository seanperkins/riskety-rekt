# Balance run — 2026-08-10, selected world boards

2,000 seasons per run, seeds 1..2000, 14 days, engine v1.0.0.

**This supersedes both earlier balance documents.** They measured the
42-territory `RISK_MAP`, and no season will use it — `season-init` selects a
sub-map of the world sized to the roster. Measuring one board while playing
another is the defect this run exists to remove.

**It is also the first measurement at a full 15-faction headcount**, which was
impossible twice over: `checkDeal(15, 42)` refused the board, and the simulator
gave every seat its policy's name as a faction id, so a roster with repeats
collided and died on the engine's reserve invariant.

## Run A — the authoritative roster, 6 seats

`Blitz, Consolidator, Hunter, Slacker, GymRat, Gambler`, the roster
`2026-08-09-balance-run.md:12` marks authoritative.

Mean board: **44.3 territories, 7.4 per faction.**

| policy | wins | baseline | 1σ | mean territories |
|---|---|---|---|---|
| Hunter | 20.4% | 16.7% | ±0.90 | 7.5 |
| GymRat | 18.9% | 16.7% | ±0.88 | 7.6 |
| Consolidator | 18.9% | 16.7% | ±0.87 | 7.7 |
| Gambler | 16.6% | 16.7% | ±0.83 | 7.2 |
| Blitz | 16.5% | 16.7% | ±0.83 | 7.4 |
| Slacker | **8.8%** | 16.7% | ±0.63 | 6.9 |

Day-3 leader converts: **23.4%** against a 16.7% baseline.

**Consolidator gained 5.4 points** against the same roster on `RISK_MAP` (13.5%
→ 18.9%), and nothing else moved much. That is the region-hunting policy, and it
follows from the board: a 6-faction selected board is 44 territories across
roughly 8 regions where `RISK_MAP` was 42 across 6, so region bonuses are more
attainable. The bonus formula is doing real work in the economy now rather than
sitting mostly idle.

## Run B — full headcount, 15 seats

The same six policies, seated 3/3/3/2/2/2. **A policy's baseline is its seat
share, not 1/15** — comparing a three-seat policy's wins against a two-seat
policy's without that correction overstates it by half.

Mean board: **106.8 territories, 7.1 per faction.**

| policy | seats | wins | baseline | 1σ | per seat |
|---|---|---|---|---|---|
| Consolidator | 3 | 28.3% | 20.0% | ±1.01 | 9.4% |
| Hunter | 3 | 22.6% | 20.0% | ±0.94 | 7.5% |
| Blitz | 3 | 13.7% | 20.0% | ±0.77 | 4.6% |
| Slacker | 2 | 13.1% | 13.3% | ±0.75 | 6.6% |
| Gambler | 2 | 11.2% | 13.3% | ±0.71 | 5.6% |
| GymRat | 2 | 11.2% | 13.3% | ±0.70 | 5.6% |

Day-3 leader converts: **10.8%** against a 6.7% baseline — a 1.6× lift, close to
the 1.4× at six seats, so an early lead is worth about the same either way.

**Consolidator runs away with it at scale**, 9.4% per seat against a 6.7%
per-seat baseline. More players means smaller holdings, and a region bonus is a
larger share of a small income. If one number in this document is worth acting
on, it is this one.

## The IRL channel, and a result that cuts both ways

`Slacker`, `Blitz` and `GymRat` share identical map play and differ **only** in
approved IRL actions per day — 0, 1, 2. They are the clean instrument for the
mechanic the whole game is built around.

**In a real field the mechanic works, emphatically.** In Run A, Slacker wins
8.8% against a 16.7% baseline — roughly half the field's rate for the sole
reason that it never posts.

**Head to head it inverts.** Seat only those three, equal seats, so per-seat
rates are directly comparable:

| | 6 seats (2 each) | 15 seats (5 each) |
|---|---|---|
| Slacker (0/day) | **35.8%** | **34.7%** |
| Blitz (1/day) | 33.6% | 33.4% |
| GymRat (2/day) | **30.6%** | **31.9%** |

Baseline 33.3%, 1σ ±1.06. The 5.2-point gap at six seats is about 3.5σ, so it is
real rather than noise.

**The mechanism is measured, not guessed.** Over 400 seasons all three end with
the same mean reserve — 5.1 — so the extra soldiers are being *spent*, not
hoarded. What differs is what the spending buys:

| | mean final territories |
|---|---|
| Slacker | 7.49 |
| Blitz | 7.36 |
| GymRat | 7.30 |

More soldiers, spent by these policies, produce **fewer** territories. The
attacks they fund lose more ground than they take.

**Read this as a statement about the policies, not about the mechanic.** These
three attack on the same rule regardless of how rich they are, so extra income
becomes extra marginal attacks. Against a strong mixed field the soldiers are
what let you survive — hence Slacker's 8.8% in Run A. Against opponents equally
poor at choosing attacks, not over-extending wins.

Two things follow. The IRL channel is not broken and does not need re-tuning on
this evidence. And **the simulator's attack selection is the weakest part of the
model** — a policy that spent a surplus better than these do would change both
runs, so every figure here is a lower bound on what a competent player does with
IRL soldiers.

## What did not move

Mean territories per faction sits at 6.9–7.7 across every policy in Run A and
7.0–7.4 in Run B — no policy is being starved or running away with the board.
That is the selector doing its job: it targets 7 per faction and every roster
size lands at 7.0–7.8.

## Reproducing

```bash
npm run sim -- Blitz Consolidator Hunter Slacker GymRat Gambler
```

Run B and the IRL instrument seat policies more than once, which the CLI does
not express; both were run through `runMany` directly. `runMany` reports
`seats` alongside `wins` precisely so the baseline is computable rather than
assumed.

The run takes about 7 seconds. `CLAUDE.md` claimed 2 seconds until this work —
that figure was stale, not a regression: the previous commit measured at 7.0s
as well.

## Caveats

- **These are policies, not people.** A policy is a fixed rule; a person adapts.
  The clearest limit is the one above — attack selection is crude, and it is
  what the IRL result turns on.
- **Wagers are simulated with a coin weighted to the snapshot price**, so the
  market channel is measured as fair. The stale-price exploit — late placement
  at the frozen 08:00 price is roughly +94% EV — is *not* modelled here, and a
  real Gambler would do better than 16.6%.
- **Boards vary between seasons.** Every figure is a mean across 2,000 different
  boards, which is the point, but it means a single season can look nothing like
  the table.
