# Riskety Rekt — Design

**Date:** 2026-08-09
**Status:** Revised after multi-model review (round 1)

## Overview

A Risk-like conquest game for a private group of friends, played one tick per day
over a fixed season. Players never play the game live. Each day they submit standing
orders through a web app, and the server resolves everyone's orders simultaneously at
a fixed hour.

Reinforcements come from two sources beyond baseline territory income:

1. **Real-world actions** — a workout, a healthy meal — submitted as a photo in Slack
   and approved by peer reaction.
2. **Prediction market wagers** — players stake soldiers on the outcome of 3–5 real
   markets that close that day.

The first makes the game an accountability device. The second replaces dice as the
source of variance, with uncertainty players can actually reason about.

## Goals

- A daily ritual that makes a friend group exercise more.
- Strategic depth that rewards thinking, not free time.
- Variance that creates comebacks without feeling arbitrary.
- Small enough to build and run alone.

## Non-goals

- Multi-tenancy, onboarding, or installation by other groups.
- Tamper-proof verification of real-world actions. Peer approval is a visibility and
  ritual mechanic, not a fraud check. See "Approval is social, not adversarial".
- Real-money wagering. All stakes are in-game soldiers.
- **Bot factions.** The order interface leaves room for them later, but they are out of
  scope for season one. (Distinct from the *sim policies* in Testing, which are
  offline-only and never touch the server.)

## Architecture

A pure engine surrounded by adapters.

```
              ┌──────────────────────────────────────┐
  orders ────►│              engine                  │
  context ───►│  resolve(state, orders, context)     │────► newState
              │      pure, no I/O, no deps           │
              └──────────────────────────────────────┘
                    ▲          ▲          ▲
        ┌───────────┴───┬──────┴──────┬───┴──────────┐
        │               │             │              │
  MarketAdapter   SlackIngress   SettlementPoller   Store
  (Kalshi)        (Bolt webhook) (30-min cron)    (SQLite)
```

The engine imports no adapter. It receives plain data and returns plain data. This is
what makes offline season simulation possible, and season simulation is how the economy
gets balanced.

**Stack:** TypeScript throughout. Engine is a dependency-free package. Next.js web app,
Slack Bolt bot, SQLite for state.

### Trust boundaries

The engine assumes **nothing** about its arguments. Every value crossing into it has
already been validated and authorized by the caller, and the engine re-validates anyway.
Specifically:

| Input | Trusted? | Who validates |
|---|---|---|
| `state` | yes — engine-authored | schema-checked on load from SQLite |
| `orders[].factionId` | **no** | server derives from session; never read from request body |
| `orders[].protect` | **no** | engine ignores unless faction is eliminated in `state` |
| numeric order fields | **no** | schema validator: `Number.isSafeInteger`, `>= 0` |
| territory / market ids | **no** | must be members of `state.map` / `context.slate` |
| `context.slate` prices | **no** | adapter rejects non-finite or out-of-range at fetch |
| `Market.question` text | **no** | escaped at every render sink, length-capped |

### Interfaces

```ts
interface DailyContext {
  slate:      Market[]            // today's published markets, frozen at 08:00
  approvals:  ApprovedAction[]    // approved before the tick cutoff
  settlements: Record<string, "yes" | "no" | "unsettled">
}

interface Market {
  id: string
  question: string
  priceYes: number                // finite, in (0,1)
  priceNo:  number                // stored explicitly, not derived at use time
  closeTime: string               // ISO instant
}

interface ApprovedAction {
  eventId:    string              // Slack event_ts — unique, stable, the tie-break key
  playerId:   string
  postedAt:   string              // message ts — drives Early Bird
  approvedAt: string              // second distinct approver's reaction ts
}

interface MarketAdapter {
  getCandidates(): Promise<Market[]>
  getSettlements(ids: string[]): Promise<Record<string, "yes" | "no" | "unsettled">>
}

interface Store {
  loadState(seasonId, day): Promise<GameState>
  saveState(state): Promise<void>
  loadOrders(seasonId, day): Promise<Order[]>
  saveOrder(seasonId, day, factionId, orderBody): Promise<void>   // factionId from session
  saveSlate(seasonId, day, slate): Promise<void>
  loadSlate(seasonId, day): Promise<Market[]>
  recordApproval(action): Promise<void>                            // Slack ingress writes
  loadApprovals(seasonId, day): Promise<ApprovedAction[]>
  recordSettlement(marketId, outcome, at): Promise<void>           // poller writes
  claimTick(seasonId, day): Promise<boolean>                       // false if already run
}
```

`resolve` takes `(state, orders, context)`. The slate and approvals must cross the
engine boundary — without them steps 2, 5 and 6 cannot execute, and golden-file replay
is impossible because the tick's real inputs were never captured.

### Authentication

Every player authenticates via **Slack OAuth** — the roster already exists there. The
session maps to a `factionId` server-side.

- `factionId` is **absent from the wire format entirely**, not merely validated. The
  server supplies it from the session. This makes the unauthenticated form
  unrepresentable rather than merely rejected.
- The Slack Events endpoint verifies `X-Slack-Signature` using a signing secret, and the
  service **fails to boot** if that secret is missing — a missing secret must never
  degrade into an unverified handler. Requests with an `X-Slack-Request-Timestamp` older
  than five minutes are rejected as replays.
- Every Slack event is scope-checked: `team_id` matches the workspace, `item.channel`
  matches the configured channel, and both the reactor and the message author are on the
  faction roster. A 👍 in a DM counts for nothing.
- Any admin or tick-rerun endpoint requires a separate credential.

### Read-side confidentiality

Secrecy is load-bearing twice — protection picks are secret and all orders are hidden
until the tick — so no client-reachable route may ever return raw `GameState` or the
output of `loadOrders`.

Define one **public projection**: map, ownership, garrisons, own reserve, own pending
wagers, own protect pick, and opponents' reserve *totals*. Every page and API route
returns only that. A test asserts the serialized page payload contains no other
faction's `protect` field or order rows — this is the standard Next.js `__NEXT_DATA__`
leak and it is invisible without an explicit test.

## Game rules

### Map and setup

Standard Risk map: 42 territories across 6 continents. Continent bonuses are the
classic values — North America 5, South America 2, Europe 5, Africa 3, Asia 7,
Australia 2.

4–6 factions, one human each. At season start, territories are shuffled and dealt
round-robin so holdings are even to within one territory. Every territory starts with
2 troops. Every faction starts with 0 reserve.

The dealt board is **day 0**. Ticks run 1 through 21. Tick 1 has empty `pending`, so
step 1 is a no-op.

### Season

21 days, one tick per day at 21:00 America/New_York. The faction holding the most
territories after the day 21 tick wins.

Ties break on **total troops**, defined explicitly as `garrisons + reserves` — escrowed
`pending` stakes are excluded, because a day-20 wager unsettled at tick 21 would
otherwise hold soldiers in limbo during the tiebreak. If still tied, most continents
held. If still tied, the season is a draw; the recap says so.

A faction reduced to zero territories is *eliminated* — no army, no path back onto the
map — but not out of the game. See "Elimination and protection".

### State

```
GameState {
  seasonId, day
  map:       territories [{id, name, neighbors[], continent}]
             continents  [{id, bonus}]
  factions:  [{id, playerName, color}]
  ownership: territoryId → factionId
  garrisons: territoryId → troopCount        // 0 is a legal value
  reserves:  factionId → troopCount          // earned, not yet deployed
  pending:   [{wagerId, factionId, marketId, side, stake, price, placedOnDay, status}]
  log:       [TickEvent]
  engineVersion: string
}

TickEvent =
  | {t:"income",     faction, amount}
  | {t:"irl",        faction, actions, bonus}
  | {t:"deploy",     faction, territory, count}
  | {t:"attack",     from, to, attacker, committed, survivors, captured}
  | {t:"fieldBattle",a, b, destroyed, continuing}
  | {t:"protected",  territory, byCount}
  | {t:"wagerSettle",wagerId, outcome, payout}
  | {t:"rejected",   faction, field, reason}
```

`TickEvent` is **structured data only — no prose**. All string rendering lives in the
Slack and web layers. Otherwise a reworded recap breaks the golden-file replay test,
since `log` is inside `GameState`.

One `GameState` is persisted per `(seasonId, day)`. State is immutable — a tick reads
day N−1 and writes day N.

The `reserves` pool is the single sink both workouts and wager winnings pay into, and
the single source deploys and new wagers draw from. One number per faction.

**Determinism.** Never iterate a map without sorting keys first. Every tie-break below
is explicit. These two rules are what make golden-file replay meaningful.

### Orders

```
Order {
  deploys: [{territory, count}]        // reserve → owned territory
  attacks: [{from, to, count}]         // adjacent only
  wagers:  [{marketId, side, stake}]   // from reserve
  protect: territoryId | null          // honored only if faction is eliminated
}
```

`factionId` is **not** part of the order body; the server attaches it from the session.

**Aggregate constraints** — each is checked in the engine, not only in the web app:

- `sum(deploys[].count) ≤ reserve`
- for each origin `T`: `sum(attacks where from == T .count) ≤ postDeployGarrison(T) − 1`
- `sum(wagers[].stake) ≤ reserve − sum(deploys[].count)`
- at most **one wager per market per faction**

The per-attack bound alone is not sufficient: a garrison of 10 sending five separate
9-troop attacks satisfies every individual check while fielding 45 troops.

**Rejection is field-level, never whole-order.** An over-budget or malformed line item is
dropped; the rest of the order stands. Deploys apply in listed order until the reserve is
exhausted, then wagers in listed order against what remains. Whole-order rejection would
be a griefing lever — a player could append a deliberately malformed attack at 20:59 to
void their own committed orders, a free undo nobody else has.

Every rejection is recorded as a `{t:"rejected"}` event and **surfaced in the recap**.
Silent validation is how a validator bug survives a whole season.

System errors still propagate. "Invalid orders never throw" must not become "engine and
database errors are swallowed and the tick is marked successful."

### Order locking

Deploys, attacks and `protect` are editable until the 21:00 lock. **Wagers lock
per-market at that market's `closeTime`** — see Wagers for why.

The lock is enforced in SQLite, not in the web app. `saveOrder` rejects writes for a day
once locked, judged by the **server clock only**. `claimTick` sets the lock and reads the
orders inside one transaction, so a submit racing the timer either lands before the read
or is rejected — never lands mid-resolution.

SQLite runs in WAL mode with a `busy_timeout`. Three processes share the file (web app,
Slack bot, tick timer), and the likeliest thing to block the tick is not an outside
system but our own second process.

### Resolution pipeline

Seven steps, always in this order:

1. **Settle matured wagers.** Credit only — see below.
2. **Grant approved IRL actions** (capped, plus timing bonuses).
3. **Grant territory and continent income.**
4. **Apply deploys.** Reserve → garrison.
5. **Escrow new wagers.** Debit reserve, move to `pending`.
6. **Resolve protections, field battles, then all attacks simultaneously.**
7. **Check season end.**

Two consequences of this ordering are load-bearing. Wagers are escrowed *after* deploys,
so troops already committed to the map cannot also be staked. And winnings land at the
start of the *next* tick, so a winning bet funds tomorrow's offensive, never today's.

**Step 1 is credit-only.** The stake already left the reserve at escrow, and a loss
returns nothing, so there is nothing to debit. Writing it as "credit or debit" invites a
double-charge that drives reserves negative. `reserves >= 0` is asserted as an engine
invariant, not merely a test.

Step 1 processes **all** matured pending wagers, not just yesterday's — a wager unsettled
for two ticks must still be caught. Maturity and refund are expressed in tick counts, not
wall-clock hours, so a DST transition cannot shift them: refund when
`day − placedOnDay >= 2` and still unsettled.

### Combat

Deterministic. No dice. Resolution of step 6, in order:

**6a — Protections.** For each territory, `protected(t)` is true when an odd number of
*eliminated* factions with an approved action today named it. Drop every attack targeting
a protected territory; those troops stay in their origin.

**6b — Field battles.** When A→B and B→A are both ordered in the same tick with sizes
`a` and `b`:

- `a > b` → B's force is destroyed; A continues toward B with `max(0, a − 2b)`
- `b > a` → symmetric
- `a == b` → both forces destroyed; neither advances

A feint therefore costs the attacker twice the feint's size rather than voiding the
assault outright. A 1-troop counter against a 100-troop assault removes 2 troops, not
100. This keeps counter-attacking meaningful without making defense absolute.

**6c — Defense value.** A territory is defended by its **post-departure** garrison.
Troops ordered out have physically left and do not defend. This is what determines the
"captured and lost in the same tick" and "protection on a territory whose owner is
attacking out of it" cases.

**6d — Attack resolution.** For each contested territory with defense `D` and surviving
attacking forces `a_1..a_k` (post-field-battle), let `A = sum(a_i)`:

- `A ≤ D` → all attackers destroyed. Defender keeps `D − A`. Ownership unchanged.
- `A > D` → territory captured. Total casualties are **exactly `D`**, allocated pro-rata
  by `a_i` using **largest-remainder rounding** (floor each `D·a_i/A`, then hand the
  shortfall one at a time to the largest fractional remainders, ties by lowest faction
  id). Survivors `s_i = a_i − c_i`, and `sum(s_i) = A − D`.
  - The largest `s_i` takes the territory and becomes its garrison.
  - Tie-break: larger original `a_i`, then lowest faction id.
  - Other attackers' survivors return to their origin territory.

Worked example: `a_1 = 3`, `a_2 = 4`, `D = 5`. `A = 7 > 5`, so capture. Raw casualties
2.143 / 2.857 → floors 2 / 2, shortfall 1 goes to the larger remainder (`a_2`) → 2 / 3.
Survivors 1 / 1. Tied, so the larger original force (`a_2` = 4) takes the territory; the
other survivor returns home.

Allocating exactly `D` — rather than letting `D` apply in full against each attacker — is
what keeps troop conservation true. Applying `D` per-attacker would let a 4-troop garrison
destroy 8 troops and silently break the conservation property test.

The 1:1 loss ratio is the primary brake on snowballing: taking ground is expensive, so a
leader cannot cheaply convert an advantage into a runaway.

Removing dice is deliberate. The variance budget is spent entirely on the prediction
markets. Two stacked random systems would make outcomes feel arbitrary rather than
earned.

The multi-attacker rule is what gives handshake alliances teeth. Two allies can take a
territory neither could take alone, both bleed for it, and only one keeps it.

### Elimination and protection

A faction with zero territories at the **start** of a tick is eliminated. It cannot
deploy, attack, or return to the map, and it earns **no territory income** (see Economy).
Instead it gains a **daily protection**: it names one territory anywhere on the map, and
every attack targeting that territory is voided.

This is a role change, not an exit. The eliminated player becomes a kingmaker that living
factions have to negotiate with.

**It requires a posted workout.** The protection fires only if that player *posted* an
action that day. It gates on the **post**, not on peer approval — deliberately. Gating on
approval would hand living factions a concrete incentive to withhold the 👍 from someone
whose veto they fear, which weaponizes the one mechanic the design insists must stay
non-adversarial. The +1 soldier still requires approval; the veto only requires showing up.

**Picks are secret.** Submitted in the normal order window, revealed in the recap.

**Blocked attacks are voided, not destroyed.** Troops stay in the origin territory.

**Protections toggle by parity.** A territory is protected if an *odd* number of
eliminated factions named it:

```
protected(t) = count(picks on t, from eliminated factions that posted today) % 2 === 1
```

Because picks are secret, eliminated players cancel each other blind. This also
self-limits board lockup late in a season.

**`protect` is authorized in the engine.** The parity count filters on
`territoryCount(factionId) === 0` in the *input* state. The field is present on every
order, so a living faction submitting `protect` must be ignored — otherwise it claims a
free veto while holding a full army.

Protection is a shield, not a stasis field: the owner can still deploy into a protected
territory and attack out of it. Any territory is a legal pick.

## Economy

### Baseline income

`max(5, floor(territories / 2))`, plus continent bonuses. **Eliminated factions earn 0.**

The floor and divisor were both corrected after review. Under the original
`max(3, floor(t/3))`, income only exceeded the floor at **twelve** territories — 29% of
the map — so in a 6-faction game (7 territories each at deal) every player would have sat
at 3 all season and the "typical 4–7" anchor described nobody. Halving the divisor also
makes each territory gain matter.

Resulting range: 5 at the deal, ~6 mid-game, ~10 for a strong leader.

### IRL actions

**Maximum 2 approved actions per day, +1 soldier each.**

An action counts when a player posts a photo in `#riskety-rekt` and two *distinct other*
players react with 👍 before the tick cutoff. You cannot approve your own.

### Timing bonuses

- **Early Bird** — the first player to *post* an approved action that day: +1
- **Under the Wire** — the last approved action before cutoff: +1

Maximum one timing bonus per player per day. If one player holds both ends, they take
Early Bird, and Under the Wire passes to the latest *different* player with an approved
action; if there is none, it is not awarded.

Early Bird keys on **post** time, not approval time. Keying on approval would reward
having friends awake rather than exercising early, contradicting the mechanic's whole
purpose.

Ties on any timestamp break on Slack `event_ts`, then player id. The tick filters
approvals by Slack `event_ts`, never by database write time — otherwise a reaction at
20:59:59 delivered at 21:00:01 silently voids an eliminated player's veto.

### What the IRL channel is actually worth

Peak IRL income is 3/day (2 actions + 1 timing bonus), or 63 over a season.

Against baseline income that is **+60% for a floor player and +30% for a leader**. This
is deliberately **regressive** — the channel is worth most to whoever is behind, which
makes it a rubber-band rather than a runaway multiplier. It is not the "uniformly small"
effect an earlier draft claimed; that framing was wrong and the arithmetic never
supported it.

These attach to workout photos and **never to order submission**. Order timing must stay
neutral: a bonus for submitting last would pay the position that already holds the most
information, and one for submitting first would reward having a free 8am — the
schedule-flexibility advantage the action cap exists to suppress.

If Early Bird is won by the same early riser every day and goes stale, make it a rotating
exclusion — no player may take it twice in a row.

### Approval is social, not adversarial

Among friends, everyone will approve everything. Design as if that is true. The real job
of peer approval is making people see each other's workouts. Do not add complexity trying
to make it tamper-proof; it cannot be and does not need to be.

This is why the elimination veto gates on posting rather than approval — see above.

### Wagers

Each morning, 3–5 markets are published as the slate. Players stake soldiers from their
reserve on YES or NO.

**At most one wager per market per faction.** This is not a convenience limit — it is what
closes a risk-free arbitrage. Staking `k·p` on YES and `k·(1−p)` on NO of the same market
returns `1.1k` on an outlay of `k` no matter which way it resolves: guaranteed +10% per
day, zero variance, compounding to `1.1²¹ = 7.4×` over a season. That inverts every stated
property of the wager system — the "variance tool" would have no variance, and the correct
play for a leader would be to hedge maximally rather than sit out.

**Payout on a win:** `round(stake / p * 1.1)`, where `p` is the snapshotted price of the
chosen side. A loss returns nothing.

`round`, not `floor`. Under `floor` the intended +10% only exists for `stake > 10p`;
below that the bet is negative-EV, worst case ≈ −45% of stake just above p = 0.55 —
precisely the small safe hedge the 1.1× was meant to make attractive.

Fair odds would make expected value exactly zero, which makes wagering a *variance* tool
rather than an income stream. The 1.1× is a small house bonus so engaging with the slate
is mildly correct every day.

**No stake cap.** All-in is allowed and the chaos is intended. This is self-balancing:
reserves are only *undeployed* soldiers, so building a large stake means hoarding, and
hoarding means leaving the map thin.

**Wagers lock per-market at that market's `closeTime`.** Deploys, attacks and `protect`
stay editable until 21:00. Without this, every slate market has closed — and its outcome
is publicly known — before the order lock, so a player edits at 20:55 and stakes their
whole reserve on a certainty at the 08:00 price. The web app shows each market's
remaining window and greys out locked ones.

**No slate on the final day.** Day-21 wagers would pay out at a tick that never runs. The
08:00 job checks `day < seasonLength` and publishes nothing on the last day.

### Market selection

Candidates must close after 09:00 and before 21:00 ET the same day (a market closing at
exactly 21:00:00 is excluded), clear a volume floor, and be priced in `[0.10, 0.90]`. Pick
3–5, ordered deterministically by market id.

The volume floor is a constant in the engine config, set from observed data: during
implementation, sample a week of Kalshi same-day markets and set it at the median.

**Prices are snapshotted once**, at 08:00, and stored in the persisted slate. Both
`priceYes` and `priceNo` are stored explicitly — never derived at use time. Kalshi quotes
per-side with a spread, so `1 − priceYes` is not the NO price; snapshot the mid of each
side. If the two sides were snapshotted independently and summed below 1.0, the hedge
profit above would grow beyond 10%.

`p` is validated at the adapter boundary as a **finite** number in `(0,1)`; markets
failing that are dropped before they reach the slate. Note that
`Math.max(0.05, Math.min(0.95, NaN))` is `NaN` — a clamp does not filter `NaN`, and a
`NaN` reserve persists to disk and poisons every subsequent tick. The runtime clamp
matches the slate filter at `[0.10, 0.90]`, so it only ever fires on a filter bug.

The escrow step takes `price` from the **persisted slate**, never from the order body, and
rejects any `marketId` not on today's slate. Otherwise a player wagers on a market that
settled three days ago at a price from when it was still uncertain — and an arbitrary
`marketId` string flows into a URL path, which is an SSRF and path-traversal vector.

**Sources:** Kalshi only, in production. Manifold is a development and fixture source; it
is deliberately *not* a production fallback, because a dead market source is already
handled by publishing an empty slate, and a second live adapter would buy a second network
dependency and a second settlement format for a day already accepted as survivable.

Polymarket is not used — its UMA optimistic oracle has a challenge window running hours to
days, incompatible with a daily tick.

### Untrusted text

`Market.question` is third-party text (Manifold questions are user-written), and
`playerName` is player-supplied. Both reach three sinks and each needs its own encoding:

- **Slack** — use Block Kit `plain_text`, which does not parse mrkdwn. Otherwise a
  question containing `<!channel>` pings the workspace daily.
- **SVG** — escape `&`, `<`, `>`, `"` in all text nodes. If the renderer builds SVG by
  concatenation and the web app injects it via `dangerouslySetInnerHTML`, `</text><script>`
  in a label is stored XSS with the session cookie right there. Build the board as React
  elements so JSX escaping applies, or serve the SVG as a separate `image/svg+xml`
  response. `dangerouslySetInnerHTML` is banned in the board component.
- **Web** — React escapes by default; the only risk is the path above.

Cap question length at 200 characters — a 5,000-character title wrecks the recap layout
even when correctly escaped.

## Daily timeline

| Time | Event |
|---|---|
| 08:00 | Fetch candidates, filter, pick 3–5, snapshot both side prices, persist slate, publish to web and Slack (skipped on the final day) |
| every 30 min | Settlement poller writes resolved outcomes to the DB |
| all day | Players post workout photos and react; players submit and revise orders. Each market's wagers lock at its own close time. |
| 21:00 | `claimTick` locks the day and reads orders in one transaction. Read approvals and settlements from local state. Run the pipeline. Save state. Post recap. |

The map image is generated server-side by rendering the board to SVG from the public
projection and rasterizing it to PNG. The same renderer backs the web board, so there is
one source of truth for how the map looks.

The recap deserves real effort. It is the daily artifact everyone actually sees — who
attacked whom, whose bet paid off, who posted their workout, and which orders were
rejected.

## Failure modes

**The tick never touches the network.** Both external systems are cached ahead of it:

- **Slack approvals** are written continuously by the Events webhook.
- **Settlements** are written by a 30-minute poller. The tick reads only settlements
  already persisted before lock. An earlier draft had the tick calling `getSettlements()`
  directly, which made a Kalshi outage or a hung TLS handshake at 20:59 able to stall the
  season — the exact failure this section forbids.

**No market slate → the day runs as plain Risk.** Publish an empty slate, post a note,
carry on.

**Unsettled markets roll forward**, and are refunded when `day − placedOnDay >= 2`.
Adapter timeouts and errors map to `"unsettled"` so outages are absorbed by this rule.

**Slack event handling** dedupes on event id (Slack redelivers on retry), counts
*distinct* reactors, honors `reaction_removed` and message deletion, and normalizes emoji
names — `+1`, `thumbsup` and `+1::skin-tone-3` are distinct strings in the API.

**Ticks are idempotent.** `claimTick` returns false if day N already has a saved state, so
a double-fired timer, a retry, or an operator rerun cannot double-pay. Recovery from a bad
tick means correcting the code and re-running from day N−1 — and because orders are frozen
at lock and append-only, a rerun cannot pick up orders edited by players who now know the
outcome. Each state row is stamped with `engineVersion` and a run timestamp, and any rerun
posts a visible correction note to Slack.

**`postRecap` is separate from resolution** and is not re-fired by a rerun except as an
explicitly marked correction.

**Time.** Everything is pinned to `America/New_York` via systemd `OnCalendar`, which fires
exactly once on DST-transition days.

**Secrets** live in a systemd `EnvironmentFile` at mode 0600 outside the repo tree. The
service asserts at boot that no secret-named variable begins with `NEXT_PUBLIC_` — Next.js
inlines those into the client bundle. Exception text never reaches the Slack recap; log
locally, post a generic failure note.

## Testing

In priority order:

1. **Combat edge cases.** Mutual attacks at `a>b`, `a<b`, `a==b`; the `a−2b` feint case;
   three factions on one territory; `A == D` exactly; a territory captured and lost in the
   same tick; a 3-cycle A→B→C→A; post-departure defense when a territory attacks out and
   is attacked.
2. **Casualty allocation.** The largest-remainder split, including the worked example
   above; attacker-vs-attacker survivor ties; that total casualties equal exactly `D`.
3. **Protection and timing edge cases.** Parity at one, two and three picks; a pick from
   an eliminated player who did not post; **a pick from a living faction (must be
   ignored)**; a protected territory also mutually attacked; a day with exactly one
   approved action; a day with zero; two approvals sharing a timestamp.
4. **Order validation.** Multiple attacks sharing one origin exceeding the garrison;
   deploys exceeding reserve; wagers exceeding post-deploy reserve; two wagers on one
   market; negative, fractional, `NaN` and string-typed numeric fields; unknown territory
   and market ids; a wager on a market not on today's slate.
5. **Property tests.** Troop conservation (in = out + casualties). Reserves never negative.
   Every territory has exactly one owner. Paired with an assertion that dropped line items
   appear in the log — otherwise a clamping bug passes trivially.
6. **Season simulation.** Several thousand synthetic seasons with scripted policies:
   *Turtle*, *Blitz*, *Gambler*, *Slacker*, *Gym Rat*, and **`Arbitrageur`** — which
   attempts every hedge and boundary exploit it can express. The original policy set would
   not have found the both-sides hedge; a policy set that cannot express cheating cannot
   detect it. Answer:
   - Does Gym Rat beat Blitz? If yes, the IRL grant is too strong.
   - Does Gambler ever win? If never, variance is too weak for comebacks.
   - How often does the day-3 leader win? If usually, the season is decided too early.
   - How often does a protection void an attack that would have succeeded?
   - Does Arbitrageur outperform anyone? If yes, the wager economy is still broken.
7. **Confidentiality.** The serialized page payload contains no other faction's `protect`
   or order rows.
8. **Golden-file replay.** Record one season's orders and full `DailyContext`, replay,
   assert identical output.
9. **Adapter tests against recorded fixtures**, including hostile strings in
   `Market.question` and malformed prices. Tests never hit the network.

## Deployment

A single DigitalOcean droplet. SQLite in WAL mode on an attached volume, systemd timers
for the 08:00 publish, the 30-minute settlement poll and the 21:00 tick, Next.js behind
Caddy.

App Platform is rejected: its filesystem is ephemeral, so SQLite would be wiped on every
redeploy, and using it would require managed Postgres for a database holding a few hundred
kilobytes.

Order submission is rate-limited per session with a cap on revisions per day. If the web
app ever displays workout photos, it proxies them server-side — the Slack bot token and
signed Slack file URLs never reach the browser.

## Deferred to future seasons

- **Interlocked economy variant.** Approved actions set daily *wager capacity* rather than
  granting soldiers. Revisit after season one produces real balance data.
- **Bot factions.** The order interface accommodates them.
- **Respawn on elimination.** Superseded by the daily protection.

## Rejected review findings

Recorded so they are not re-litigated:

- **Delete the timing bonuses** (Simplifier). They are an explicit product requirement.
  The reviewer's balance concern was real and is addressed instead by correcting the
  baseline income formula and restating the IRL channel's true worth.
