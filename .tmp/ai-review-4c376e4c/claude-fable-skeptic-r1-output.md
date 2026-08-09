# Skeptic Review — Riskety Rekt Design (r1)

Reviewed the plan as given. The repo is greenfield (docs + no source), so all findings
are against the design text itself; there are no code citations to ground.

---

## CRITICAL-1 — The wager system is a risk-free money printer, by the plan's own three rules combined

Trace the actual day, using only rules the plan states explicitly:

1. "Candidates must close **before 21:00 ET the same day**" (Market selection).
2. "**Prices are snapshotted once**, when the slate is published at 08:00, and that
   price applies to everyone regardless of when they submit."
3. "Orders are **freely editable until the tick locks them**" at 21:00 — and wagers
   are part of the Order struct.

So every slate market has *closed* — and its outcome is either publicly settled or its
price has converged to ~0/1 — **before the order lock**. A same-day market's whole
nature is that its uncertainty resolves intraday. At 20:55 a player edits their order
and stakes their entire reserve on the now-known (or near-known) outcome **at the
08:00 price**. Payout is `floor(stake / p_0800 × 1.1)` with ~100% win probability.
A market published at 0.50 that resolved YES pays a guaranteed 2.2×, daily.

Consequences:

- The variance mechanic is dead. Wagers are not bets; they are deterministic income,
  and the "comeback tool" becomes a compounding engine for whoever hoards reserve.
- It maximally rewards exactly what the design says it wants to suppress: "Strategic
  depth that rewards thinking, **not free time**." The player free to check market
  outcomes at 20:55 wins; the player who submitted at 09:00 like a chump loses.
- The plan's justification is inverted. It says pricing at submission time "would give
  whoever submits last strictly better information — they could watch a market move on
  breaking news and bet into a stale line." Pricing at *submission* means you bet at
  the current fair line; it is the **frozen 08:00 snapshot** that creates the stale
  line, and it hands the stale line to everyone, worst-informed to best-informed alike.
  Snapshotting equalizes the price players get; it does nothing to equalize the
  *information* they bet with, and the close-before-21:00 rule guarantees that
  information reaches certainty before lock.

Fair fixes, pick one:

- **Lock wagers separately and early** (e.g. wagers freeze at 09:00 or at each
  market's open), leaving deploys/attacks editable until 21:00. Cheapest fix, keeps
  the 08:00 snapshot honest.
- Per-wager lock at the market's close time (more machinery, same effect).
- Select markets that close *after* 21:00 but settle before the next 08:00 — inverts
  the window so no outcome is knowable at lock. Check Kalshi supply for this; the
  plan's sampling week should measure this cohort, not the close-before-21:00 one.

This is the one fatal flaw. Everything else below is fixable in place; this one
invalidates the economy section's central claims (variance tool, comeback mechanic,
"no advantage to submitting early or late") until resolved.

## CRITICAL-2 — The 1-troop mutual-attack spoiler makes defense strictly dominant

The mutual-attack rule as written: "A→B and B→A in the same tick → the armies meet in
the field. Both lose `min(a, b)`. **Neither territory changes hands.**" There is no
size condition. So:

- A commits 100 troops against B's territory (garrison 3).
- B counter-orders a 1-troop attack back along the same edge (legal: `count ≤ garrison − 1`).
- Resolution: both lose `min(100, 1) = 1`. Neither territory changes hands.

B voided a 100-troop assault for the price of 1 troop. If A *doesn't* attack, B's
spoiler resolves as a real 1-troop attack and dies — total insurance premium: 1
troop/day/edge, against baseline income of 4–7/day. Because combat is deterministic
(no dice to make the spoiler unreliable) and orders are simultaneous, every player
learns this within days, and the rational steady state is 1-troop counter-orders on
every threatened border. Attacks between attentive players become near-impossible;
the map freezes; the 21-day season is decided by the market exploit above instead.

Note the irony: this gives every living faction a cheaper, more reliable shield than
the elimination-protection mechanic gives eliminated ones.

Fix options: surviving attackers continue to the target after the field battle
(survivors = a − min(a,b) then resolve vs garrison normally); or field battles only
trigger when forces are within some ratio; or mutual attacks resolve as two normal
attacks against each garrison. Whichever is chosen, the spec must say it — the season
simulation (Blitz vs Turtle) will silently produce garbage balance data if the
implementer guesses.

## MAJOR-1 — Settlement fetch at tick time violates the "tick must never be blocked" invariant

The failure-modes section guarantees caching for exactly one external system: "Slack
approvals are cached as they happen... at 21:00 the tick reads local state and never
calls the Slack API." The timeline then asserts the tick reads "cached approvals and
yesterday's settlements" — but **nothing in the plan produces a settlements cache**.
The only scheduled jobs are the 08:00 publish and the 21:00 tick, and
`MarketAdapter.getSettlements()` is a network call. As designed, the 21:00 tick calls
Kalshi. A Kalshi outage, a hung TLS handshake, or a slow response at 20:59:58 stalls
or fails the tick — the exact fatality the section opens by forbidding. "Unsettled
markets roll forward" covers markets Kalshi *reports* as unsettled; it does not cover
the API being unreachable unless the adapter maps timeout/error → "unsettled", and the
plan never says so.

Fix: either add a settlement-poller job (e.g. every 30 min after each market's close,
writing to the DB, so the tick reads local state for both externals), or specify that
`getSettlements` wraps a hard timeout and maps any failure to `"unsettled"` so the
roll-forward rule absorbs outages. One sentence in the plan; a stalled season if
omitted.

## MAJOR-2 — Multi-attacker combat math is underspecified and conflicts with the base rule

Two rules are given for contested territories: (a) "sum all incoming attacks and
compare against the garrison... surviving attackers = attack − defense"; (b) for
multiple factions, "**every attacker takes losses against the defender**. The largest
surviving force takes the territory." These don't compose:

- If each attacker separately "takes losses against" defense D, total casualties can
  be up to k×D for k attackers — breaking the plan's own property test "troops are
  conserved (in = out + casualties)" relative to rule (a), where casualties are
  exactly D.
- If instead losses are shared, the allocation (proportional? largest-first?
  floor/rounding?) is unstated, and rounding decides who is "the largest surviving
  force" in close fights — precisely the alliance-betrayal moment the design cares
  most about.
- Ties for largest surviving force are unresolved ("exact ties" appears in the test
  list, but a test cannot assert an unspecified outcome).

The plan calls combat "where the bugs live" and then leaves its hardest case to
implementer discretion. Write the formula.

## MAJOR-3 — Garrison accounting for simultaneous in/out attacks is unspecified

If a faction sends `garrison − 1` out of territory t while t is itself attacked, does
the incoming attack resolve against the pre-departure garrison or the 1 troop left
behind? "Resolve all attacks simultaneously" doesn't answer it, and the two readings
produce opposite strategy: one makes attacking safely costless, the other makes every
attack a defensive gamble. This also determines the mutual-attack semantics in
CRITICAL-2 and the conservation property in the tests. One sentence fixes it; its
absence means the season simulator and the engine can silently implement different
games.

## MAJOR-4 — The protection mechanic weaponizes the approval system the plan declares non-adversarial

"Approval is social, not adversarial... Among friends, everyone will approve
everything. Design as if that is true." Then Elimination attaches a veto to approval:
an eliminated player's protection "only fires if that player has at least one approved
IRL action that day," and approval requires two *other* players to react. A living
faction fearing tonight's veto now has a concrete strategic incentive to **withhold
the 👍** — with a 4–6 player roster, two abstentions are easy to arrange. The one
mechanism the plan insists must stay non-adversarial is handed the game's only
adversarial gate. Among friends this probably surfaces as an awkward "why didn't you
react to my push-up pic" — which is worse for the accountability ritual than any
balance bug. Consider: eliminated players' protection gates on *posting* the photo
(timestamped by Slack, no reactions required), while the +1 soldier still requires
approval. UNVERIFIED that the group would actually play approval-denial games — but
the design shouldn't create the incentive and then assume it away.

## MINOR findings

- **M1 — "An attack that wins with zero survivors" is impossible under the stated
  rules.** Capture requires `attack > defense`, so survivors = attack − defense ≥ 1.
  Either the test case is dead or it references the unspecified multi-attacker math
  (MAJOR-2); reconcile.
- **M2 — Reaction removal and photo deletion.** The bot "writes reaction events to the
  DB continuously." If it doesn't also process `reaction_removed` (and message
  deletion), an un-reacted approval stays approved. Also unspecified: `approvedAt` is
  presumably the second reaction's timestamp — say so, since Early Bird / Under the
  Wire hang off it; and reactions from workspace members who aren't players must not
  count toward the two.
- **M3 — Tiebreak ambiguity at season end.** "Ties break on total troops" — does that
  include reserves and `pending` escrow? A day-20 wager unsettled at the day-21 tick
  holds soldiers in limbo during the tiebreak; the 48-hour refund lands after the
  season is decided. Define "total troops" and the treatment of pending stakes at end
  of season.
- **M4 — Re-run recovery re-fires side effects.** Recovery is "re-run from day N−1,"
  but the tick also posts the Slack recap. Re-running a fixed tick double-posts (or
  posts a recap contradicting the earlier one). Make `postRecap` explicitly separate
  from and optional to resolution, and note that a re-run recap should be marked as a
  correction.
- **M5 — Deploy/wager both drawing reserve in one order form.** Deploys apply at step
  4, wagers escrow at step 5; an order spending the same reserve twice is "dropped" —
  but is the wager list dropped wholesale or trimmed? Deterministic partial-application
  order (deploys first, then wagers in listed order until reserve exhausted) should be
  specified, since "invalid orders are dropped, never thrown" currently reads as
  all-or-nothing.
- **M6 — Zero-garrison territories.** An exact-tie defense (`attack = defense`) leaves
  the defender owning a 0-troop territory. Legal state? Still earns income? Any
  1-troop attack takes it next tick. Probably fine — but the state invariant
  ("garrisons: territoryId → troopCount") should say whether 0 is admissible, since
  the property tests need to know.
- **M7 — Protected territory + mutual attack** is listed as a test case but, like M1,
  has no specified outcome to assert: if B is protected and A→B is voided, does B→A
  still resolve as a normal attack on A? (Presumably yes — "voided, not destroyed"
  implies A's troops stay home and B's attack proceeds — but say it.)
- **M8 — Under the Wire rewards late posting and late reacting.** The bonus goes to
  the last *approval* before cutoff, so the optimal play is posting at 20:40 and
  friends timing their reactions — mildly contradicting the "rewards actually
  exercising in the morning" story told for photo timing, and giving approvers a
  reason to sit on reactions (same family as MAJOR-4). Acceptable as flavor, but know
  it's there.

## What the plan gets right (so it stays)

The pure-engine/adapter split, immutable per-day state with re-run recovery, the
empty-slate degradation, engine-side re-validation with drop-not-throw, and the
season-simulation-before-season-one discipline are all exactly right, and the
simulation harness is what will catch CRITICAL-1/2 cheaply — provided the combat and
wager-lock rules are pinned down first so the simulator implements the same game the
server does.

---

VERDICT: REVISE — concerns above should be addressed first
