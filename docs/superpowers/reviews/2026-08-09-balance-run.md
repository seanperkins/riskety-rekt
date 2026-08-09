# Balance run — 2026-08-09, engine v1.0.0

First simulation output after the multi-model review fixes. 2,000 seasons per roster,
21 days each, seeds 1..2000.

## Full roster

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

## Arbitrageur head-to-head

```
roster: Blitz, Arbitrageur

  Blitz          100.0%   mean territories  37.7
  Arbitrageur      0.0%   mean territories   4.3
```

## No attacker in the roster (isolates the IRL channel)

```
roster: Turtle, GymRat, Slacker, Gambler
day-3 leader goes on to win: 99.2%

  GymRat          99.2%   mean territories  11.0
  Turtle           0.9%   mean territories  11.0
  Slacker          0.0%   mean territories  10.0
  Gambler          0.0%   mean territories  10.0
```

## Answers to the spec's five questions

**Does the Arbitrageur outperform? — NO. Green.**
0.0–0.1% across every roster, including head-to-head against the only competent
policy. All four exploits it probes are dead: the both-sides hedge, the
over-committed multi-attack from one origin, the over-deploy beyond reserve, and
the live-faction `protect` claim. This is the single most important signal in the
run, and it confirms the review fixes hold.

**Does GymRat beat Blitz? — NO. Green.**
0% vs 100%. The IRL grant is not too strong.

More precisely, in the no-attacker roster GymRat and Turtle finish with *identical*
mean territories (11.0 each); GymRat's 99.2% win rate there comes entirely from the
`garrisons + reserves` tiebreak. So the IRL channel differentiates players only when
nothing else does — exactly the "participation floor, not the deciding lever" the
spec asks for.

**Does Gambler ever win? — NO, but this run cannot answer the question.**
The Gambler policy stakes its whole reserve and never deploys or attacks, so it
loses on the map for reasons unrelated to wager variance. This tests the policy, not
the economy.

**How often does the day-3 leader win? — 87.4%, well past the spec's concern threshold.**
But confounded: see below.

**How often does a protection void a winning attack? — not yet measured.**
No policy in the current set is ever eliminated early enough to exercise it
meaningfully.

## The real finding: the policy set is too weak to judge pacing

Blitz wins 100% of seasons because it is the **only policy that attacks**. Turtle,
GymRat and Slacker never attack by construction; Gambler never deploys; and every
one of Arbitrageur's attacks is correctly rejected as an over-commit. A real season
has four to six humans all attacking.

So the 87.4% day-3 figure measures "an attacker beats four pacifists, and does so
early," not "the season is decided too early." The pacing question — and the
snowball question behind it — stays open until the policy set can produce a
competitive game.

## Follow-up before trusting any pacing conclusion

1. Add a second attacking policy that is not a Blitz clone — something that
   consolidates continents or targets the leader — so attackers face real opposition.
2. Give Gambler a map game, so its wagering is measured against a baseline that can
   hold territory.
3. Add an eliminated-player policy that exercises `protect`, to answer the fifth
   question at all.
4. Re-run, and only then judge the day-3 rate and the 1:1 attrition brake.

Blitz's mean of 25.2 territories out of 42 against passive opponents is not by
itself evidence that snowballing is unchecked — it is what a lone aggressor should
achieve. Whether the brake holds between two aggressors is untested.
