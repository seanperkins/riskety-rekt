# Riskety Rekt — Handoff

**Last updated:** 2026-08-11 · **Branch:** `main` · **State:** the pluggable-mechanics spec is complete — module system, rule catalogue and voting all shipped. Open question is balance, not build.

A Risk-like conquest game for a private group of friends. One tick per day, orders
resolved simultaneously. Reinforcements come from two places beyond territory income:
**real-world actions** (a workout photo in Slack, approved by peer reaction) and
**prediction market wagers** (soldiers staked on real markets closing that day).

The first makes it an accountability device. The second replaces dice as the source of
variance, with uncertainty players can actually reason about.

---

## Where to start reading

| Document | What it is |
|---|---|
| `docs/superpowers/specs/2026-08-09-riskety-rekt-design.md` | **The spec. Start here.** Every rule, and why. |
| `docs/superpowers/reviews/2026-08-09-balance-run.md` | Simulation results and what they mean |
| `docs/superpowers/reviews/2026-08-09-round1/` | Seven reviewer reports that reshaped the design |
| `docs/superpowers/plans/2026-08-09-engine-and-sim.md` | Plan 1 — the engine and simulator |
| `docs/superpowers/plans/2026-08-09-market-adapter-and-poller.md` | Plan 2 — the market adapter. Its **Spec deltas** section lists what live API data corrected |
| `docs/superpowers/plans/2026-08-09-slack-ingress-and-recap.md` | Plan 3 — Slack ingress and the recap. Its **Spec deltas** section explains why approvals are derived, not stored |

## Current state

**Done:** the pure rules engine, the offline season simulator, the Kalshi market
adapter with its slate publisher and settlement/price pollers, the Slack ingress with
its recap and slate renderers, the 21:00 tick runner with `season-init`, `tick:rerun`,
the recap ledger and CLI order entry, the world map (264 territories from Natural
Earth) with roster-sized board selection, session auth via `/login`, the player web
app (Leaflet board, autosaving orders, wagers page, nightly replay), the wager
stale-price fix (priced at placement; bounded +16% residual documented in the payout
clamp), and the **pluggable-mechanics module system**: markets/irl/veto as engine
modules, the seniority allocation phase (the deploy-inflation fix),
`GameState.moduleState`, the `seasons.modules` column with migration and
`modules:set`, module-off gating across jobs/web/Slack, and the departure-cost
combat dial — and the **rule catalogue + voting** that completes that spec:
thirteen rules across grant, lock and dial hooks, a three-slot daily ballot
drawn by seeded shuffle, the 08:05 offer job with its claim-then-post ledger,
numeral-reaction votes in `rule_reactions`, the 21:00 tally frozen into
`ctx.rules`, and the bounded-swing balance gate.
**860 tests passing**, none of which touch the network —
`test/no-network.ts` replaces `fetch` in every run, so it is enforced.

**Not built:** nothing from the pluggable-mechanics spec. The catalogue now
**passes** its bounded-swing gate — thirteen rules on a three-slot ballot move
no policy more than 1.13 points in the voted regime
(`reviews/2026-08-11-balance-run-rules-expanded.md`). The three-rule catalogue
had failed on Blitz at +4.03; expanding it diluted each rule's share of days
from ~1/3 to ~1/13 and cleared it without cutting a rule. One balance question
remains before a competitive season: the snowballing finding in CLAUDE.md's
"Not built".

```bash
npm install
npm test          # 860 tests
npm run typecheck
npm run sim       # 2,000-season balance run, ~2s
npm run sim -- Slacker Blitz GymRat    # custom roster

# market jobs — see deploy/README.md
export RR_DB_PATH=./riskety.db RR_SEASON_ID=season-1
npm run season:init -- 2026-09-01   # date is the day-0 deal
npm run publish-slate               # the 08:00 job
npm run poll-settlements            # the 30-minute job
npm run sample:kalshi               # re-derive VOLUME_FLOOR from live data

# slack — see deploy/README.md
npm run roster:add -- U01ABCDEF f1 "Ada L."
npm run roster:list
npm run slack                       # the events bot, a long-running service
```

## Architecture

```
src/engine/    pure, zero dependencies, no I/O, no clock, no randomness
src/sim/       drives thousands of synthetic seasons through the engine
src/adapters/  the only code that speaks HTTP; parsing split from networking
src/slate/     pure slate selection
src/store/     SQLite (node:sqlite, WAL) — slates, settlements, Slack ingest
src/slack/     Bolt ingress, approval derivation, and Block Kit rendering
src/jobs/      the 08:00 publish, the 30-minute poll, the recap, and their CLI
```

The tick never touches the network. Both external systems are cached to SQLite ahead of
it — that is why the engine can stay pure and offline.

The engine is one function: `resolve(state, orders, context) → GameState`. It imports
nothing outside its own folder — `src/engine/types.test.ts` enforces that, along with a
ban on `Date.now()`, `Math.random()` and `new Date()`.

That purity is the whole reason the simulator works, and the simulator is the only
reason we know the economy isn't broken. Do not weaken it.

**Randomness and time enter as arguments.** `createSeason` takes an already-shuffled
territory list. The tick takes a `DailyContext` carrying the slate, approvals and
settlements. If you find yourself wanting to call a clock inside the engine, the answer
is a new field on `DailyContext`.

## Rules a newcomer will get wrong

These are all load-bearing and all counterintuitive. Most exist because a reviewer found
the alternative was exploitable.

**One wager per market per faction.** Not a convenience limit. Staking `k·p` on YES and
`k·(1−p)` on NO returns `1.1k` on an outlay of `k` regardless of outcome — guaranteed
+10%/day, compounding to 7.4× over a season. The per-market limit is what kills it.

**Wagers lock per-market at each market's close time**, while deploys and attacks stay
editable until 21:00. Otherwise every slate market has closed — outcome public — before
the order lock, and you bet a certainty at the morning's price.

**Orders are validated *after* pipeline steps 1–3, not before.** Deploys draw from the
reserve as it stands at step 4, so income earned this tick is spendable this tick.
Validating against yesterday's reserve silently rejects every deploy from a faction that
started at zero.

**Combat: casualties total exactly `D`, split pro-rata by largest-remainder rounding.**
Applying the full defense against each attacker independently lets a 4-troop garrison
destroy 8 troops and breaks conservation.

**A territory defends with its post-departure garrison.** Troops ordered out have left.

**Mutual attacks: smaller force dies, larger continues at `a − 2·min`.** The original
rule ("both lose `min(a,b)`, neither territory changes hands") let a 1-troop feint void
a 100-troop assault for free. Every player finds that within days and the map freezes.

**Settlement is credit-only.** The stake left the reserve at escrow; a loss returns
nothing. "Credit or debit" charges losers twice.

**Eliminated factions earn 0 income.** `max(5, floor(t/2))` would otherwise pay a
territory-less faction 5/day forever.

**`protect` is authorized in the engine**, filtered on `territoryCount === 0` in the
*input* state. The field is on every order; a living faction claiming a veto while
holding a full army is close to season-breaking.

**The elimination veto needs a *post*, not an approval.** `DailyContext` carries
`postedToday` alongside `approvals` because the two mechanics gate differently: the +1
soldier needs two distinct other players to react, the veto needs only that the player
showed up. Gating the veto on approval would give living factions a concrete reason to
withhold the 👍 from someone whose veto they fear. Both halves of the condition live in
`combat.ts` on purpose — the golden file only pins what crosses the engine boundary, so
filtering `protect` in the tick runner would let a regression replay green forever.

**An approved action is derived, never stored.** The store holds raw posts and
reactions; `dailyApprovals` computes `ApprovedAction` at read time. Storing approvals
would make `reaction_removed` a state machine — it has to retract an approval that may
or may not have existed. Deriving makes removal one `DELETE`.

**Payout uses `round`, not `floor`.** Under `floor` the intended +10% only existed for
stakes above `10p`; below that it was negative-EV, worst case ≈ −45% just above p=0.55.

**The day's rule is derived too, and its cutoff has two parts.** `rule_reactions`
holds raw numeral reactions; the tally computes the winner at 21:00 and freezes it
into `ctx.rules`. A row counts only if it is present when the tick's transaction
reads AND `reacted_at <= tickInstant` — without the second half, a tick delayed to
22:00 counts votes cast after the deadline. It is a separate table from `reactions`
because that one structurally cannot hold a vote: no emoji column (a vote is *which*
numeral), one row per player per message (changing your vote needs two live rows),
and `INSERT OR IGNORE` first-wins semantics (votes are latest-wins). An unmapped
numeral — `nine` on a three-candidate day — is dropped at ingest rather than stored,
or it would become the player's "latest" reaction and void a valid earlier vote.

**Rule selection is frozen; rule behavior is not.** A rerun replays the frozen id
from `tick_context`, never a re-derived tally, so deleting the votes afterwards
cannot change the replay. Behavior changes ride `engineVersion` like every other
engine change — `tick:rerun` warns and proceeds. There is deliberately no second
versioning scheme for rules.

**The offer's crash window is accepted, not closed.** Claim-then-post means a crash
*before* the post replays cleanly (the next run finds claimed rows and posts them,
marked as superseding). A crash *after* the post but before the ts is recorded
orphans that message: its ts exists nowhere, so its reactions can never map to a
row. That loss is by construction and one systemd retry wide. The test asserts votes
on the *re-posted* message count — it does not pretend the orphan's votes survive.

**The kill criterion.** The vote apparatus exists to ship a catalogue. If the
catalogue ever holds fewer than three rules, delete the apparatus and keep the module
system — the machinery must keep re-earning its weight.

## What the simulation says

Full detail in the balance-run doc. Headlines:

- **The exploit fixes hold.** The `Arbitrageur` policy probes all four known exploits
  and wins 0.1% of seasons. If that number ever moves, something regressed.
- **Pacing is fine.** Day-3 leader converts 19.5% against 16.7% chance.
- **No dominant strategy.** 9.1%–20.8% across six policies; mean territories 6.4–7.2
  against an even split of 7.0.

**A cautionary tale worth internalizing:** the first balance run said the day-3 leader
won 87.4% of seasons and Blitz won 100%. Both numbers were artifacts — Blitz was the
only policy that attacked, so the run measured one aggressor against four pacifists. A
simulation measures the policies you wrote. A weak policy set produces confident numbers
about nothing.

## Open decision: how strong should the IRL channel be?

At identical map play, IRL actions move win rate **23.2% → 34.1% → 42.8%** for 0 / 1 / 2
actions per day. Max-effort wins about **1.85×** as often as zero-effort.

Territory only moves ~9%. The win-rate gap is larger because seasons end near-tied and
the `garrisons + reserves` tiebreak is exactly where banked IRL soldiers land.

The spec calls this "a participation floor, not the lever that decides the game." 1.85×
is more than a floor. But the entire point of the project is motivating exercise, so a
channel that did nothing would be pointless. **This is a design call, not a bug.**

Cheapest lever if you want it weaker: drop reserves from the season tiebreak, since
that's where the effect concentrates.

Also: the spec's own test — "does GymRat beat Blitz? If yes the grant is too strong" —
is now malformed. Those policies differ *only* in IRL actions, so it's tautological.
Replace it with an explicit target such as "max-effort wins no more than 1.5× as often
as zero-effort at identical strategy."

## What's next

**Plan 2 — Market adapter + settlement poller. Done.** Kalshi client, slate selection,
SQLite persistence and the 30-minute poller all exist and are tested offline against
recorded fixtures. See the plan's "Spec deltas" section — several spec rules were
corrected against live API data, most importantly that the volume floor cannot be the
median (two thirds of same-day markets never trade) and that slate selection must take
at most one market per series or it publishes five rungs of one crypto ladder.

**Plan 3 — Slack ingress + recap. Done.** Bolt events app, roster, idempotent post and
reaction persistence, approval derivation, and pure Block Kit renderers for the recap
and the 08:00 slate. Every listed hazard is handled and tested: fail-boot on a missing
*or empty* signing secret, Bolt's five-minute replay window (verified against
`requestTimestampMaxDeltaMin` in its source), `team_id` and channel scope checks,
dedupe on `event_id` including for dropped events, `reaction_removed`, message
deletion, and emoji normalization.

Plan 4's tick runner needs to call `dailyApprovals(store, seasonId, day)` for **both**
`context.approvals` and `context.postedToday`, then `runPostRecap` after saving state —
in that order, so a Slack outage cannot stall a tick.

**Plan 4 — Web app + renderer + deployment.** Also carries two Plan 3 loose ends:
Caddy must route `/slack/events` to port 3001, and Slack's Event Subscriptions cannot
be registered until that endpoint answers a public HTTPS `url_verification` challenge —
so the bot is unusable, and its round trip untestable, until this plan ships. Slack OAuth; `factionId` absent from the
wire format entirely (not merely validated); the public projection with a test asserting
no other faction's `protect` leaks into `__NEXT_DATA__`; SQLite in WAL mode with
`claimTick` for idempotency; systemd timers. Deploy to a DigitalOcean droplet — **not**
App Platform, whose ephemeral filesystem wipes SQLite on redeploy.

Smaller follow-ups, all in the balance-run doc: report a protection counter from the
runner, and add a policy that attacks more than once per tick.

## Gotchas

- **Remote is `origin` → https://github.com/seanperkins/riskety-rekt** (public). `main`
  tracks `origin/main`, so a normal branch-and-PR flow works.
- **Wagers must lock at `min(closeTime, settlement observed_at)`**, not at `closeTime`
  alone. Every Kalshi market sampled carries `can_close_early`, so an outcome can become
  public before the stated close — the same exploit the per-market lock exists to close,
  arriving by a different door. The `settlements.observed_at` column exists for this;
  Plan 4's web app has to use it.
- **`node:sqlite` is loaded via `createRequire`, not a static import.** Vite builds its
  builtin list with `builtinModules.filter(id => !id.includes(":"))` and Node lists this
  module only as `node:sqlite`, so a static import resolves to bare `sqlite` and every
  store test fails to load. No vitest config option reaches that path. It also prints an
  `ExperimentalWarning`, which is expected — it is why the project still has zero runtime
  dependencies. Rows come back with a `null` prototype, so spread them rather than
  calling `Object.prototype` methods.
- **A market closing at exactly 21:00 ET is excluded, and this matters more than it
  looks.** In one live check it dropped 2,440 markets — Kalshi uses 21:00 ET as a
  standard daily close. Kalshi's `min_close_ts`/`max_close_ts` are inclusive, so the
  parser re-checks the window strictly.
- **`npm run publish-slate` late in the ET day legitimately publishes nothing.** Judge it
  by an 08:00 run.
- **`.tmp/` is gitignored** — it holds debate-plugin scratch. It was committed by
  accident once and untracked in `a397764`.
- **The golden file pins engine behavior via a fixed order script**, not via sim
  policies. It used to use policies, which meant tuning a policy broke the engine's
  regression test for unrelated reasons. Keep it that way.
- **`noUncheckedIndexedAccess` is on.** Deliberate — territory and faction lookups are
  exactly where the bugs were. Expect `!` and `?? 0` at lookup sites.
- **The project has runtime dependencies now.** `@slack/bolt` and `@slack/web-api`,
  added in Plan 3 because the spec names Bolt. Only `src/slack/app.ts` imports Bolt and
  only `src/slack/post.ts` imports the Web API client; everything else in `src/slack/`
  is pure, which is what keeps the suite offline.
- **Bolt's `App` is always built with `deferInitialization: true`.** Without it the
  constructor calls `auth.test`, and every test that builds an app becomes a network
  test. `src/slack/cli.ts` calls `await app.init()` itself.
- **The golden file does not exercise protections.** No faction reaches zero territories
  in the scripted ten-day season, so no order in it can legally carry a `protect` pick.
  Its doc comment claimed otherwise until Plan 3 corrected it. `combat.test.ts` covers
  that path directly.
- **The sim cannot observe the post gate either.** `Slacker` is the only policy with
  `irlActionsPerDay: 0`, and it ends eliminated in 0 of 2,000 seasons. A `Ghost` policy
  that posts nothing *and* plays weakly would give the gate real coverage.
- **`exactOptionalPropertyTypes` is on.** Passing `correction: undefined` is not the same
  as omitting the key — spread a conditional object instead.
- **The design spec has a "Rejected review findings" section.** Check it before acting
  on a suggestion that seems obviously right; it may already have been considered and
  declined for a stated reason.
