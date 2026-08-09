# Skeptic review — Riskety Rekt design

Reviewed against `/Users/sean/sites/riskety-rekt/docs/superpowers/specs/2026-08-09-riskety-rekt-design.md`
(the plan text is byte-identical to that file; line numbers below refer to it).
No source code exists yet — `find` over the repo returns exactly that one file — so
the plan cites no code identifiers, and there were no fabricated citations to report.
All arithmetic below was computed in this session.

---

## CRITICAL

### C1. The 1.1× payout is a risk-free money printer via proportional hedging

Line 288: `floor(stake / p * 1.1)`. Lines 300–302: **no stake cap**. Nothing forbids
staking both sides of the same market.

Stake `k·p` on YES and `k·(1−p)` on NO, total outlay `k`. Exactly one side wins:

- YES wins: `floor(k·p/p · 1.1)` = `1.1k`
- NO wins: `floor(k·(1−p)/(1−p) · 1.1)` = `1.1k`

**Guaranteed `1.1k` return on a `k` outlay, at every price, with zero variance.**
Verified across p = 0.10/0.20/0.35/0.50/0.75/0.90 with k=100: every case returns 110
on both branches. This is not band-limited and does not depend on a wide spread — it
is the house edge collected without taking the risk it was meant to price.

Compounding the whole reserve daily: `1.1^21 = 7.40×` over the season, on 3–5 markets
a day (so it can be spread across markets, and the per-market integer rounding loss is
≤1 soldier per side).

This inverts three of the plan's own stated properties:

- Line 291–293 "Fair odds would make expected value exactly zero, which makes wagering
  a *variance* tool" — the dominant line has **zero** variance.
- Line 293 "the leader should sit out" — the leader should hedge maximally; it is free
  compounding income with no downside.
- Line 300–302 "self-balancing without a cap: … hoarding means leaving the map thin" —
  this argument prices the *opportunity cost* of hoarding, not the *return*. At 10%/day
  risk-free, hoarding pays for itself in well under the season.

**Fix options** (any one closes it): charge the edge on the net position per market
rather than per stake; reject orders that stake both sides of one market; or set the
multiplier below 1.0 and subsidize the "ritual" with a flat daily participation soldier
instead. Whichever you pick, the sim (§Testing item 4) must include an **`Arbitrageur`**
policy — none of Turtle/Blitz/Gambler/Slacker/Gym Rat (lines 386–389) hedges, so the
simulation as specified will not find this.

### C1b. Sub-finding: the `floor()` makes small stakes negative-EV

Same formula. `EV = p·floor(1.1·s/p) − s ∈ (0.1s − p, 0.1s]`, so the intended +10% only
exists for **`s > 10p`**. Measured values:

| p | s=1 | s=2 | s=3 | s=5 | s=9 |
|---|---|---|---|---|---|
| 0.56 | **−0.44** | −0.32 | −0.20 | +0.04 | +0.52 |
| 0.60 | −0.40 | −0.20 | 0.00 | +0.40 | +0.60 |
| 0.90 | −0.10 | −0.20 | **−0.30** | +0.40 | +0.90 |

Worst case is ≈ **−45% of stake** just above p = 0.55. So line 295's claim that the
multiplier makes "engaging with the slate mildly correct every day even for a
comfortable leader" is false precisely for the leader's use case — a small, safe hedge
bet on a favorite. `round()` instead of `floor()`, or a payout floor of `stake + 1`,
fixes it.

### C2. Mutual attack: a 1-troop feint cancels an arbitrarily large assault

Lines 167–168: "**Mutual attack** (A→B and B→A in the same tick) → the armies meet in
the field. Both lose `min(a, b)`. Neither territory changes hands."

Take A→B with 10 and B→A with 1. `min = 1`. A is left with 9 survivors, B with 0. And
"neither territory changes hands" — so A's nine surviving troops accomplish nothing and
B's garrison was never engaged. **One soldier neutralized a ten-soldier offensive.**

Every player will send a 1-troop counter-attack at whichever neighbor looks threatening,
every day. Attacking becomes irrational, which collides head-on with the goal on line 27
("Variance that creates comebacks") and makes the Turtle-vs-Blitz sim question (line 390)
meaningless.

The rule needs to say what happens to the surplus: either the survivors continue into
the target and fight the garrison normally (in which case "neither territory changes
hands" is wrong and must be deleted), or they return to origin (in which case the feint
exploit is real and the rule needs a cost — e.g. the smaller force is destroyed
entirely and the larger continues at `a − 2·min`). Pick one and state it.

### C3. A territory's defense value at step 6 is never defined

Lines 162–170 define combat in terms of "the garrison," but attacks and deploys resolve
simultaneously and troops leave their origin. If T holds 10 and orders an attack out
with 9, is T defended by **10** or by **1** when someone attacks T in the same tick?

The plan never says. This is not a corner case — it determines the outcome of three
cases the plan itself lists as tests:

- "a territory captured and lost in the same tick" (line 377) — expected value is
  underdetermined
- "A protection on a territory whose owner is also attacking out of it" (line 381) —
  same
- any 3-cycle A→B→C→A

Almost certainly the answer is post-departure (the troops physically left), but the sim
results and the entire risk calculus of attacking swing on it. State it in the combat
section, and state where surviving attackers sit after a *failed* attack (lines 165–166
imply the origin loses them permanently, but never says so positively — only the
protection rule on line 204 says troops stay home, and only for voided attacks).

---

## MAJOR

### M1. `max(3, …)` pays eliminated factions 3 soldiers a day, forever

Line 233: income is `max(3, floor(territories / 3))`. Line 185: "A faction with zero
territories is eliminated… no army and **no path back onto the map**."

`max(3, floor(0/3))` = **3**. Nothing in step 3 (line 149) excludes eliminated factions.
An eliminated player accrues 3/day indefinitely, and nothing stops them wagering it
(line 185 forbids deploy/attack/return, not wagers) — so combined with C1 they compound
a growing pile they can never spend. Add an explicit `territories == 0 → income 0`
carve-out, and decide explicitly whether eliminated factions may wager. Add a test.

### M2. The IRL-vs-baseline percentages are wrong on the plan's own anchor

Line 233 anchors baseline at "4–7 per day." Line 240 claims a max-effort player earns
"roughly 25–40% more." Against 4–7 the actual figure is **2/7 = 28.6% to 2/4 = 50%** —
so the stated band should be 29–50%, not 25–40% (25–40% corresponds to a 5–8 baseline).

Worse, the "4–7" anchor itself does not describe the typical player. Computed:

| territories | 7 | 8–11 | 12 | 15 | 18 | 21 |
|---|---|---|---|---|---|---|
| income | 3 | 3 | 4 | 5 | 6 | 7 |

Territory income only exceeds the floor of 3 at **12 territories** — 29% of the map. In
a 6-faction game the even deal is 7 each (line 93), so every player starts at the floor
and stays there until they hold 12+. "4–7" describes the leaders; the modal player is
at **3** (continent bonuses can lift this, but they are not the default). Against 3, two
actions is **+67%**.

### M3. "The balance sizing above is unchanged" (line 256) is provably false

Line 242: "about 42 extra soldiers" over the season = 2 × 21 ✓. But that figure predates
the timing bonuses added at lines 249–252, which line 254 explicitly stacks "on top of
the 2-action cap." Peak becomes 3/day = **63 soldiers** — a 50% increase in the IRL
channel, not "unchanged."

For the floor player (M2), season territory income is 3 × 21 = **63**. So a max-effort
floor player draws **half their entire economy from workout photos**. That is not the
"participation floor" line 244 claims. Either accept it and rewrite the framing, or cap
total IRL income (e.g. timing bonuses replace, not stack with, the second action).

### M4. Multi-attacker casualty split is undefined and contradicts the aggregate rule

Line 162 says "sum all incoming attacks and compare against the garrison"; line 165 gives
survivors = `attack − defense`. Line 169 then says "**every attacker** takes losses
against the defender."

If the defender's D applies in full against each attacker (a1=5, a2=5, D=4 → survivors
1 and 1), a 4-troop garrison has destroyed 8 troops and the property test on line 384
("troops are conserved") fails. If D is split pro-rata, the split rule and its **integer
rounding** are never given, and they determine "the largest surviving force takes the
territory" (line 170). Worked example: a1=3, a2=4, D=5 → aggregate survivors 2, pro-rata
casualties 2.14/2.86 → survivors 0.857/1.143. Round how, preserving sum = 2?

And: **ties for largest surviving force have no rule**. There is no RNG by design (line
175), so the engine cannot break it. Specify a deterministic tie-break (largest force by
total committed, then faction id) — line 375's "exact ties" test only covers attack vs.
defense, not attacker vs. attacker.

### M5. Players cannot compute their own reserve at submission time; under-funding is undefined

Pipeline order (lines 147–152): settle wagers → grants → income → **deploys** → **escrow
wagers**. Deploys and wagers draw the same pool. But step 1 settlement is unknown when
the order is written, so a player with a pending wager literally cannot know their
step-4 reserve. Over-ordering deploys is the *normal* case, not an error.

The plan never says what happens when `sum(deploys) > reserve`. Line 359's "invalid orders
are dropped, never thrown" does not specify **granularity** — whole order, or offending
line item? If whole-order, one over-ambitious deploy silently kills that player's attacks
and their protection pick too. Same question for `sum(wagers) > remaining reserve`, and
for a living faction that submits a `protect` field (line 136 says eliminated only).

Needs: an explicit rule (suggest apply deploys in listed order until reserve is exhausted,
drop the remainder, never drop the whole order), plus a test. **No test in §Testing covers
this at all.**

### M6. Nothing constrains the sum of attacks leaving one territory

Line 134: `attacks: [{from, to, count}] // adjacent only; count ≤ garrison(from) − 1`.
The constraint is **per attack**, and `attacks` is a list. With garrison 10, `(T→A, 9)`
and `(T→B, 9)` each satisfy it — 18 troops from a 10-troop territory. The property test
on line 384 would catch the symptom, but the *rule* is what's wrong. State: sum over all
attacks from a territory ≤ garrison − 1, evaluated against the **post-deploy** garrison
(the comment's `garrison(from)` is ambiguous about which step, which also means the web
app's validation and the engine's will disagree for anyone deploying into a launch point).

### M7. No authentication story, and secrecy is load-bearing

Line 132: `Order { factionId, … }` — the faction is a **field in the client-submitted
payload**, and `Store.saveOrder(day, order)` (line 81) takes it at face value. The plan
never mentions auth anywhere. Lines 200–202 make secret protection picks a core mechanic
("Secrecy makes it a real threat that shapes how everyone plans"), and all orders are
hidden until the tick.

With no access control, any participant can submit orders as another faction and read
others' secret picks. "Private group of friends" is not an access-control design. Even a
shared-link-per-player token would do — but it has to be stated, because the mechanic
depends on it.

### M8. `Store` has no slate persistence — and the 08:00→21:00 handoff crosses a process boundary

`Store` (lines 77–82) has `loadState/saveState/loadOrders/saveOrder`. There is no
`saveSlate`/`loadSlate`, and `GameState` (lines 109–119) has no `slate` field. But the
slate and its **snapshotted prices** are created by the 08:00 systemd unit (line 406) and
consumed by the 21:00 unit, the web app, and the escrow step — three separate processes.
Line 317 makes the snapshot integrity the whole basis of fairness. Losing or re-fetching
it silently changes everyone's payouts.

Same gap for approvals: line 350 says the bot "writes reaction events to the DB
continuously," but the write path has no home in any of the four interfaces —
`SlackAdapter.getApprovedActions` (line 73) is read-only.

### M9. `TickEvent` is referenced three times and never defined — and it breaks the golden test

`TickEvent` appears at line 74 (`postRecap`) and line 118 (`log: [TickEvent]`). It is
never defined. Because `log` is inside `GameState`, and line 399 says the golden-file
replay asserts **identical output**, any change to recap wording will fail the golden
test. Define `TickEvent` as structured data (event type + ids + numbers, no prose), and
keep all string rendering in the Slack/web layer.

### M10. Determinism gaps make the golden-file replay flaky

Line 399's replay test requires a fully deterministic engine. Four unresolved
non-determinisms:

1. Largest-surviving-force tie (M4).
2. Timing-bonus timestamp tie — line 383 lists "two approvals sharing a timestamp" as a
   test but **no tie-break rule exists**. `ApprovedAction {playerId, approvedAt}` (line 73)
   needs a unique, stable key (Slack `event_ts`), not a second-granularity time.
3. Final standings three-way tie on territories, troops, *and* continents (lines 100–101)
   — no terminal rule.
4. **Approval read-race at the cutoff.** Line 252's "last approved action before the tick
   cutoff" and line 195's protection precondition both depend on which approvals are in
   the DB at 21:00. If the tick filters on DB *write* time rather than Slack *event*
   timestamp, a reaction at 20:59:59 delivered at 21:00:01 silently voids an eliminated
   player's veto and shifts Under the Wire. Filter on `event_ts` and run the tick with a
   small lag. (The *magnitude* of Slack delivery latency is a HYPOTHESIS I did not verify;
   the write-time-vs-event-time ordering bug is not — it is a plain logic choice.)

### M11. The "zero-survivor win" test case is impossible under the stated rules

Line 376 lists "an attack that wins with zero survivors." Under lines 165–166, `attack >
defense` ⟹ survivors ≥ 1, and `attack ≤ defense` ⟹ attackers destroyed, defender keeps
`defense − attack` ≥ 0. **There is no branch producing a capture with zero survivors.**
Either the intended rule is `attack ≥ defense → capture` (which contradicts line 166), or
the test case is wrong. Resolve — this is exactly the ambiguity that ships as a bug.

### M12. `priceYes` → per-side price is unspecified, as are the snapshot semantics

`Market` carries `priceYes` (line 68); `pending` stores `price` (line 117); line 288 says
`p` is "the snapshotted price of **the chosen side**." The derivation of the NO price is
never given. `1 − priceYes` is only right for a fee-free, perfectly complementary book;
Kalshi quotes per-side bid/ask with a spread. Nor does the plan say *which* price is
snapshotted — last trade, mid, bid, or ask.

This matters beyond tidiness: if the two side-prices are snapshotted independently and
sum below 1.0, the C1 hedge profit grows above 10%. Manifold (line 323, the dev/fallback
source) has much wider spreads than Kalshi. Specify: snapshot the mid, derive the
complement, store both.

### M13. Third-party text reaches the SVG renderer and Slack

`Market.question` (line 68) is author-controlled text from Kalshi/Manifold — Manifold
questions are user-written on an open unauthenticated API (line 324). `playerName`
(line 113) is also free text. Both flow into the recap and into the server-side **SVG**
render (lines 338–340), which is XML: an unescaped `<`, `&`, or `"` breaks the render or
injects markup. Line 340 notes the same renderer backs the web app's board view, so if
that SVG is inlined into the DOM this is a stored XSS path, not just a broken PNG.

Escape at every render boundary (SVG text nodes and Slack mrkdwn — the latter also
prevents `<!channel>` injection via player names), and add a hostile-string fixture to
the adapter tests (line 401). No shell/SQL/eval paths are visible in the plan; if the
SVG→PNG rasterization shells out, keep the filename engine-derived and parameterize all
SQLite queries.

### M14. The tie-break "total troops" is undefined across three pools

Line 100: "Ties break on total troops." Troops live in **garrisons**, **reserves**, and
escrowed **pending** stakes. Which count? It changes outcomes — a hoarding Turtle vs. a
player who committed everything to the map can flip on this. Related boundary: a wager
placed on day 20 that is still unsettled at tick 21 is neither paid nor refunded when the
season ends; if `pending` counts toward the tie-break, that's a live edge case.

---

## MINOR

- **N1.** Line 357: "Still unsettled after 48 hours, the stake is refunded." Ticks are 24h
  apart, so the boundary lands exactly on a tick instant — refund at tick N+2 or N+3?
  Also, a season spanning a US DST transition has a 23h or 25h day, so wall-clock hours
  and tick counts diverge. `pending` already carries `placedOnDay` (line 117) — express
  it as `day − placedOnDay >= 2`. (Checked: systemd `OnCalendar` at 08:00/21:00 fires
  exactly once on DST-transition days, so the timers themselves are fine.)
- **N2.** Line 249 "Two extra soldiers are available each day" overstates: if one player
  holds both the first and last approval, line 254's per-player cap awards only 1, and the
  plan never says whether Under the Wire falls through to the next-latest *different*
  player. Line 383's single-approval test also asserts "one bonus, not both" without the
  rule saying *which* one — matters for the recap and for determinism.
- **N3.** Day indexing is undefined. Is the dealt board day 0 or day 1? Line 122 says a
  tick reads N−1 and writes N; line 304 says a day-21 stake can never be spent. Both work
  with initial state = day 0 and ticks 1..21, but say so, and note that tick 1 has an
  empty `pending` (step 1 is a no-op).
- **N4.** Line 304's "no slate on the final day" lives only in prose. Season length appears
  nowhere in `GameState` (lines 109–119) and the 08:00 row of the timeline table (line 334)
  has no conditional. This will be missed and will burn everyone's reserve on day 21.
- **N5.** `Store.loadState(day)` / `loadOrders(day)` (lines 79–80) take no `seasonId`, yet
  `GameState` carries one (line 110). Pick one.
- **N6.** Line 297 clamps `p` to `[0.05, 0.95]` while line 311 filters the slate to
  `[0.10, 0.90]`. The clamp only ever fires on a filter bug — at which point it authorizes
  an **22×** payout instead of the in-band max of **11×**. Match the clamp to the filter.
- **N7.** Line 147, step 1: "Credit **or debit** reserves." There is never a debit at
  settlement — the stake left the reserve at escrow (step 5, line 151), and a loss simply
  returns nothing (line 289). As written this invites a double-charge bug that the
  "reserves never go negative" property test (line 385) would catch only intermittently.
  Settlement is credit-only (payout, or refund on timeout).
- **N8.** Line 310: markets must "close before 21:00 ET the same day" — a market closing at
  exactly 21:00:00 is a boundary the filter must pin.
- **N9.** Naming collision: line 36 lists "Scripted bot players" as a non-goal, while
  Testing item 4 (lines 386–389) requires scripted policies. Different things; use
  distinct words ("sim policies" vs. "bot factions").
- **N10.** Line 385's "reserves never go negative" passes trivially if the engine clamps —
  it cannot distinguish "resolved correctly" from "silently ate the order." Pair it with an
  assertion that the count of dropped line items is reported in the `log`.

---

## Consistency sweep — what I checked and found clean

Not asserting "clean" without enumerating. Verified in this session:

- **Risk map constants (lines 89–91).** Territory counts NA 9 + SA 4 + EU 7 + AF 6 +
  AS 12 + AU 4 = **42** ✓. Bonuses 5+2+5+3+7+2 = 24, and each matches the classic values ✓.
- **Round-robin dealing (line 93).** 4 factions → 10/11 each; 5 → 8/9; 6 → 7 exactly. Even
  to within one in all three ✓.
- **Starting continent monopoly.** Computed P(any one faction is dealt all 4 of Australia):
  4 factions 1.18%, 5 factions 0.56%, 6 factions 0.19%. Rare enough that no "no complete
  continent at deal" rule is warranted — worth a sim assertion, not a rule.
- **Parity formula (line 213).** Boundaries 0→false, 1→true, 2→false, 3→true ✓. `protect` is
  singular (line 136), so each eliminated faction contributes at most 1 to the count — the
  parity is well-defined and cannot be stuffed ✓.
- **Protection ordering (lines 226–227).** "Resolve parity, then drop, then sum" *does*
  determine the "protected territory that is also mutually attacked" test (line 380): the
  incoming attack is dropped first, so the counter-attack resolves as a plain one-sided
  assault. This one is correctly specified — good.
- **Escrow-after-deploy (lines 151, 155–157).** The ordering does deliver the claimed
  property: troops deployed at step 4 are out of the reserve before step 5 can stake them ✓.
- **Per-player IRL peak (line 254).** 2 actions + 1 timing bonus = 3 ✓. Line 242's
  2 × 21 = 42 ✓ (correct as stated, but incomplete — see M3).
- **Garrison non-negativity.** Holds for every stated combat branch (lines 165–168); the
  only exposure is the unspecified multi-attacker split (M4).
- **Elimination timing.** A faction dropped to zero at tick N gets its first protection at
  tick N+1 (status is read before step 6), and its recap tells it in time to submit a pick.
  Consistent — but state explicitly that "eliminated" means status at the *start* of the tick.

## Test coverage gaps (no test would catch a regression)

Beyond those noted inline: under-funded deploys/wagers (M5), attack-sum overflow from one
territory (M6), attacker-vs-attacker tie (M4), eliminated-faction income (M1), the entire
unsettled-rollforward and 48h-refund path (N1), the empty-slate/market-source-down day
(line 353), order-drop granularity (M5), season end with unsettled `pending` (M14), and
the both-sides hedge (C1 — add an `Arbitrageur` policy to the sim).

---

## Bottom line

The architecture (pure engine, immutable per-day state, adapters at the edges) is the
right call and makes all of the above cheap to fix before code exists — which is the point
of reviewing now. The protection mechanic is the most carefully specified part of the
document and mostly holds up. The problems are concentrated in two places: the wager
economy has a risk-free arbitrage that inverts its stated purpose (C1), and the combat
rules leave three outcomes undetermined that the plan's own test list already asks for
(C2, C3, M4). The IRL economy is also sized against an income anchor that most players
never reach (M2/M3).

VERDICT: REVISE — concerns above should be addressed first
