# Balance run — 2026-08-10, season length 21 → 14

> **Superseded 2026-08-10.** Measured on the 42-territory `RISK_MAP`, which no season
> uses — the board is now selected from the world and sized to the roster. See
> `2026-08-10-balance-run-world.md`.

2,000 seasons per run, seeds 1..2000, engine v1.0.0.

The spec's season-length decision rests on a measurement, and a reviewer cannot
check a number that exists only in a chat log. Both runs are recorded verbatim.

**Roster: `Blitz, Consolidator, Hunter, Slacker, GymRat, Gambler`** — the one
`2026-08-09-balance-run.md:12` labels authoritative. The CLI-default roster is
marked superseded there (`:112`) and is not used here. An earlier draft measured
21-vs-14 on the superseded roster, in which `Turtle` wins 0.0%, so the day-3
conversion rate was largely a statement about a policy that never wins.

## These numbers supersede the ones in the plan

The plan predicted 19.5% at 21 days and 22.8% at 14, from a measurement taken
before `makeRng` was fixed (`9cdd36e`). That generator's first draw was nearly
linear in the seed — 2,000 of 2,000 seeds produced a first draw in the bottom
quarter — and the simulator seeds seasons sequentially, so **every** simulated
season's first decision was drawn from the same sliver. Every number below is a
re-measurement on the corrected generator. The conclusion is unchanged; the
figures moved by about a point.

## Run A — 21 days

```
seasons: 2000   roster: Blitz, Consolidator, Hunter, Slacker, GymRat, Gambler
day-3 leader goes on to win: 20.9%

  Hunter          21.1%   mean territories   7.0
  GymRat          20.2%   mean territories   7.2
  Gambler         17.8%   mean territories   7.0
  Consolidator    16.6%   mean territories   7.1
  Blitz           14.8%   mean territories   7.1
  Slacker          9.4%   mean territories   6.5
```

## Run B — 14 days (the change)

```
seasons: 2000   roster: Blitz, Consolidator, Hunter, Slacker, GymRat, Gambler
day-3 leader goes on to win: 23.8%

  Hunter          21.6%   mean territories   7.1
  GymRat          19.3%   mean territories   7.2
  Gambler         18.9%   mean territories   7.0
  Blitz           16.3%   mean territories   7.0
  Consolidator    13.5%   mean territories   7.0
  Slacker         10.4%   mean territories   6.7
```

## Reading it

**The runs are paired.** Identical seeds, and a 14-day season is a strict prefix
of the 21-day one through day 13 — same deal, same policy decisions, same market
outcomes — so the day-3 leader is the same faction in both runs for every seed.
Only the stopping point differs. The day-3 leader distribution is measured, not
assumed:

```
Consolidator 25.4%  Blitz 20.0%  GymRat 17.0%  Gambler 15.6%  Hunter 12.5%  Slacker 9.5%
```

**Standard error.** At n = 2,000, 1σ is ±0.91 pp at p = 0.209 and ±0.95 pp at
p = 0.238. Treating the two runs as independent — the conservative choice, since
pairing can only shrink the variance of a difference — 1σ on the difference is
±1.32 pp. The observed +2.9 pp is therefore about 2.2σ: real, but not
comfortably so, and the per-policy win rates below it are individually within
about 2σ of each other.

**The judgement.** Shortening the season makes an early lead convert more often,
by roughly 3 points against a 16.7% six-player baseline. **23.8% is not
"usually".** A day-3 leader still loses three times in four. The shortening was
chosen for the group's attention span, not for competitive balance, and the
measurement's job is to show it does not *break* balance — which it does not.

**What did not move.** Mean final territories sit at 7.0–7.2 for five of six
policies in both runs; only `Slacker`, the zero-IRL-action policy, sits lower
(6.5 → 6.7). The IRL channel remains the clearest signal in the roster:
`Slacker`, `Blitz` and `GymRat` differ *only* in actions per day (0 / 1 / 2) and
finish 9.4 / 14.8 / 20.2 at 21 days and 10.4 / 16.3 / 19.3 at 14. The ordering
holds at both lengths, which is the property that matters — the shorter season
does not blunt the mechanic the whole design is built around.

`Consolidator` is the one policy the shortening clearly hurts (16.6% → 13.5%):
continent bonuses need time to assemble, and 14 days is less of it. That is the
expected cost and it is within 2σ, but it is the number to watch if the season
is ever shortened again.

## Reproducing

```bash
npm run sim -- Blitz Consolidator Hunter Slacker GymRat Gambler   # Run B, 14 days
```

For Run A, set `SEASON_LENGTH = 21` in `src/config.ts` and re-run. There is only
one length constant now — `src/sim/run.ts` imports it — so the simulator and the
jobs cannot drift apart and silently measure different seasons.
