# Balance run — 2026-08-09, engine v1.0.0

> **Superseded 2026-08-10.** Measured on the 42-territory `RISK_MAP`, which no season
> uses — the board is now selected from the world and sized to the roster. See
> `2026-08-10-balance-run-world.md`.

2,000 seasons per roster, 21 days each, seeds 1..2000.

Run twice: first against the original policy set, then against a competitive set
after the first run turned out to be measuring the policies rather than the game.
**The second run reverses the first run's main conclusion**, which is recorded below
rather than deleted.

---

## Run 2 — competitive roster (authoritative)

Five of six policies attack. `Slacker`, `Blitz` and `GymRat` share identical map
play and differ *only* in IRL actions per day (0 / 1 / 2), which turns that trio
into a clean instrument for measuring the IRL channel. `Consolidator` fights for
continent bonuses, `Hunter` targets whoever is leading, `Gambler` diverts half its
reserve into wagers.

```
roster: Blitz, Consolidator, Hunter, Slacker, GymRat, Gambler
day-3 leader goes on to win: 19.5%     (chance for 6 players = 16.7%)

  Hunter          20.8%   mean territories   7.0
  Gambler         19.4%   mean territories   7.2
  GymRat          18.6%   mean territories   7.2
  Consolidator    16.6%   mean territories   7.1
  Blitz           15.6%   mean territories   7.1
  Slacker          9.1%   mean territories   6.4
```

### Arbitrageur against the competitive roster

```
  GymRat          30.6%      Gambler         15.6%
  Hunter          24.7%      Blitz            9.4%
  Consolidator    19.6%      Arbitrageur      0.1%   mean territories 3.5
```

### IRL ladder — identical map play at 0 / 1 / 2 actions

```
roster: Slacker, Blitz, GymRat            (chance for 3 players = 33.3%)

  GymRat  (2/day)  42.8%   mean territories  14.5
  Blitz   (1/day)  34.1%   mean territories  14.2
  Slacker (0/day)  23.2%   mean territories  13.3
```

---

## Answers to the spec's five questions

**Does the Arbitrageur outperform? — NO. Green.**
0.1% against the competitive roster; 0.0–0.1% everywhere. All four probed exploits
stay dead: the both-sides hedge, the over-committed multi-attack from one origin,
the over-deploy beyond reserve, and the live-faction `protect` claim. This is the
most important signal in the run and it is unambiguous.

**How often does the day-3 leader win? — 19.5%, against 16.7% chance. Green.**
The season is **not** decided early. Run 1 reported 87.4% and that was an artifact:
Blitz was the only policy that attacked, so the figure measured "an aggressor beats
four pacifists, early" rather than a snowball problem.

**Is there a dominant strategy? — NO. Green.**
Win rates span 9.1%–20.8% across six policies, and mean final territories span
6.4–7.2 against an even split of 7.0. The 1:1 attrition brake holds: no policy
runs away with the board.

**Does Gambler ever win? — YES, 19.4%, second place. Green.**
With a policy that also plays the map, wagering is competitive — it beats the
equal-effort pure-map policy (Blitz, 15.6%). Expected, since the 1.1× multiplier
makes wagering mildly +EV, and it is within the pack rather than ahead of it.

**How often does a protection void a winning attack? — now exercised, not yet counted.**
Every policy submits a kingmaker protect once eliminated, shielding the weakest
surviving faction. The engine handles it, but the runner does not yet report a
counter. Add one before drawing conclusions about the mechanic.

---

## The one number worth a decision: the IRL channel is stronger than "a floor"

At identical map play, IRL actions move win rate **23.2% → 34.1% → 42.8%** for
0 / 1 / 2 actions per day. A max-effort player wins about **1.85×** as often as
someone who never posts.

The territorial effect is much smaller — 13.3 vs 14.5 mean territories, about 9%.
The win-rate gap is larger than the territory gap because seasons frequently end
near-tied, and the `garrisons + reserves` tiebreak is exactly where banked IRL
soldiers land.

Whether this is too strong is a design call, not a bug:

- The spec calls the IRL grant "a participation floor, not the lever that decides
  the game." A 1.85× win-rate swing is more than a floor.
- But the entire point of the project is to make a friend group exercise. A channel
  that does not move the needle would not motivate anyone.

If you want it weaker, the cheapest lever is excluding reserves from the season
tiebreak, since that is where the effect concentrates — territory alone moves only
9%. Dropping the per-action value to +1 for the *first* action only would also work.

**Note the spec's own threshold is now malformed.** It says "Does GymRat beat Blitz?
If yes, the IRL grant is too strong." Those two policies now differ *only* in IRL
actions, so GymRat beating Blitz is tautological — it just restates that the grant
does something. Replace that test with an explicit target, e.g. "max-effort should
win no more than 1.5× as often as zero-effort at identical strategy."

---

## Run 1 — original policy set (superseded, kept for the record)

```
roster: Turtle, Blitz, GymRat, Slacker, Gambler, Arbitrageur
day-3 leader goes on to win: 87.4%

  Blitz          100.0%   mean territories  25.2
  Arbitrageur      0.1%   mean territories   4.5
  Turtle           0.0%   mean territories   3.3
  GymRat           0.0%   mean territories   3.3
  Slacker          0.0%   mean territories   3.2
  Gambler          0.0%   mean territories   2.5
```

Blitz won 100% because it was the only policy that attacked: Turtle, GymRat and
Slacker never attacked by construction, Gambler never deployed, and every one of
Arbitrageur's attacks was correctly rejected as an over-commit. The 87.4% day-3
figure and the apparent snowball both dissolved once the opposition could fight
back.

The lesson generalizes: **a simulation measures the policies you wrote, and a weak
policy set produces confident numbers about nothing.** The Arbitrageur result was
trustworthy in Run 1 only because that policy was written to probe specific known
exploits rather than to play well.

## Remaining follow-ups

1. Report a protection counter from the runner, so question five can be answered.
2. Decide the IRL strength question above, then re-run the ladder to confirm.
3. Consider a policy that makes multiple attacks per tick — every current policy
   attacks at most once, which likely understates how fast a real board moves.
