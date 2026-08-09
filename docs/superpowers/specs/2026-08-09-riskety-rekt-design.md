# Riskety Rekt — Design

**Date:** 2026-08-09
**Status:** Approved

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
- Scripted bot players. The order interface leaves room for them later, but they are
  out of scope for season one.

## Architecture

A pure engine surrounded by four thin adapters.

```
                  ┌─────────────────────────┐
                  │        engine           │
   orders ───────►│  resolve(state, orders, │────► newState
                  │       settlements)      │
                  │   pure, no I/O, no deps │
                  └─────────────────────────┘
                        ▲             ▲
        ┌───────────────┴──┬──────────┴────────┬──────────────┐
        │                  │                   │              │
  MarketAdapter      SlackAdapter            Store        Scheduler
  (Kalshi/Manifold)  (Bolt, Events API)    (SQLite)   (systemd timers)
```

The engine imports none of the adapters. It receives plain data and returns plain
data. This is what makes offline season simulation possible, and season simulation is
how the economy gets balanced.

**Stack:** TypeScript throughout. Engine is a dependency-free package. Next.js web
app, Slack Bolt bot, SQLite for state.

### Interfaces

```ts
interface MarketAdapter {
  getSlate(day: number): Promise<Market[]>          // {id, question, priceYes, closeTime}
  getSettlements(ids: string[]): Promise<Record<string, "yes" | "no" | "unsettled">>
}

interface SlackAdapter {
  getApprovedActions(day: number): Promise<Record<PlayerId, number>>
  postRecap(state: GameState, events: TickEvent[]): Promise<void>
}

interface Store {
  loadState(day: number): Promise<GameState>
  saveState(state: GameState): Promise<void>
  loadOrders(day: number): Promise<Order[]>
  saveOrder(day: number, order: Order): Promise<void>
}
```

## Game rules

### Map and setup

Standard Risk map: 42 territories across 6 continents. Continent bonuses are the
classic values — North America 5, South America 2, Europe 5, Africa 3, Asia 7,
Australia 2.

4–6 factions, one human each. At season start, territories are shuffled and dealt
round-robin so holdings are even to within one territory. Every territory starts with
2 troops. Every faction starts with 0 reserve.

### Season

21 days, one tick per day at 21:00 America/New_York. The faction holding the most
territories after the day 21 tick wins. Ties break on total troops, then on continents
held.

A faction reduced to zero territories is *eliminated* — it has no army and no path back
onto the map — but it is not out of the game. See "Elimination and protection".

### State

```
GameState {
  seasonId, day
  map:       territories [{id, name, neighbors[], continent}]
             continents  [{id, bonus}]
  factions:  [{id, playerName, color}]
  ownership: territoryId → factionId
  garrisons: territoryId → troopCount
  reserves:  factionId → troopCount        // earned, not yet deployed
  pending:   [{factionId, marketId, side, stake, price, placedOnDay}]
  log:       [TickEvent]
}
```

One `GameState` is persisted per day. State is immutable — a tick reads day N−1 and
writes day N. A bad tick can be re-run after a fix without corrupting the season.

The `reserves` pool is the single sink both workouts and wager winnings pay into, and
the single source deploys and new wagers draw from. One number per faction.

### Orders

```
Order {
  factionId
  deploys: [{territory, count}]        // reserve → owned territory
  attacks: [{from, to, count}]         // adjacent only; count ≤ garrison(from) − 1
  wagers:  [{marketId, side, stake}]   // from reserve
  protect: territoryId | null          // eliminated factions only
}
```

Orders are freely editable until the tick locks them. There is no advantage to
submitting early or late.

### Resolution pipeline

Seven steps, always in this order:

1. **Settle yesterday's wagers.** Credit or debit reserves.
2. **Grant approved IRL actions.** Capped, see economy.
3. **Grant territory and continent income.**
4. **Apply deploys.** Reserve → garrison.
5. **Escrow new wagers.** Debit reserve, move to `pending`.
6. **Resolve protections, then all attacks simultaneously.**
7. **Check season end.**

Two consequences of this ordering are load-bearing. Wagers are escrowed *after*
deploys, so troops already committed to the map cannot also be staked. And winnings
land at the start of the *next* tick, so a winning bet funds tomorrow's offensive,
never today's.

### Combat

Deterministic. No dice. For each contested territory, sum all incoming attacks and
compare against the garrison:

- **Attack > defense** → territory captured. Surviving attackers = `attack − defense`.
- **Attack ≤ defense** → attacking force destroyed. Defender left with `defense − attack`.
- **Mutual attack** (A→B and B→A in the same tick) → the armies meet in the field.
  Both lose `min(a, b)`. Neither territory changes hands.
- **Multiple factions attacking one territory** → every attacker takes losses against
  the defender. The largest surviving force takes the territory.

The 1:1 loss ratio is the primary brake on snowballing: taking ground is expensive, so
a leader cannot cheaply convert an advantage into a runaway.

Removing dice is deliberate. The variance budget is spent entirely on the prediction
markets. Two stacked random systems would make outcomes feel arbitrary rather than
earned, and would drown out the thing that makes the market layer interesting — that
its uncertainty is reasoned rather than noise.

The multi-attacker rule is what gives handshake alliances teeth. Two allies can take a
territory neither could take alone, both bleed for it, and only one of them keeps it.

### Elimination and protection

A faction with zero territories is eliminated. It cannot deploy, attack, or return to
the map. Instead it gains a **daily protection**: it names one territory anywhere on the
map, and every attack targeting that territory is voided.

This is a role change, not an exit. The eliminated player becomes a kingmaker that
living factions have to negotiate with, which in practice means more Slack conversation
than they had while playing.

Four rules govern it:

**It requires a workout.** The protection only fires if that player has at least one
approved IRL action that day. No photo, no veto. This is what keeps elimination inside
the accountability loop rather than turning it into free power for doing nothing — the
whole reason the mechanic exists.

**Picks are secret.** Submitted in the normal order window, revealed in the recap. If
picks were public, attackers would simply route around them and the veto would be a
mild inconvenience. Secrecy makes it a real threat that shapes how everyone plans.

**Blocked attacks are voided, not destroyed.** A cancelled attack leaves its troops in
the origin territory. Combined with secrecy, a blocked attack costs a tempo rather than
an army — the difference between a fun surprise and a season-ending gotcha. Destroying
armies on a hidden condition would feel arbitrary and punishing.

**Protections toggle by parity.** A territory is protected if an *odd* number of
eliminated factions named it. Two picks cancel out, three protect again:

```
protected(t) = count(picks on t, from factions with an approved action today) % 2 === 1
```

Because picks are secret, eliminated players cancel each other blind. Two allies of
opposing living factions can neutralize each other without knowing it, and a living
faction can lobby one eliminated player into cancelling another's shield. This also
self-limits board lockup late in a season, when several eliminated players might
otherwise freeze a territory each.

Protection is a shield, not a stasis field: the owner can still deploy into a protected
territory and still attack out of it. Only incoming attacks are affected. Any territory
is a legal pick, not just ones the eliminated faction used to own.

Mechanically this sits at the head of step 6 — resolve parity, then drop every attack
targeting a protected territory, then sum what remains.

## Economy

### Baseline income

`max(3, floor(territories / 3))` plus continent bonuses. Typical mid-game is 4–7 per
day. Everything else is sized against this anchor.

### IRL actions

**Maximum 2 approved actions per day, +1 soldier each.**

Deliberately small. A max-effort player earns roughly 25–40% more than someone who
posts nothing — a real advantage that good play can overcome. Over a 21-day season
that is about 42 extra soldiers: meaningful, never decisive.

Effort is a participation floor, not the lever that decides the game. Strategy and
wagers decide the game.

### Approval is social, not adversarial

An action counts when a player posts a photo in `#riskety-rekt` and two *other*
players react with 👍 before the tick cutoff. You cannot approve your own.

Among friends, everyone will approve everything. Design as if that is true. The real
job of peer approval is making people see each other's workouts, which is the part that
drives the habit. Do not add complexity trying to make this tamper-proof; it cannot be
and does not need to be.

### Wagers

Each morning, 3–5 markets closing that day are published as the slate. Players stake
soldiers from their reserve on YES or NO.

**Payout on a win:** `floor(stake / p * 1.1)`, where `p` is the snapshotted price of
the chosen side. A loss returns nothing.

Fair odds would make expected value exactly zero, which makes wagering a *variance*
tool rather than an income stream — the right property for a comeback mechanic. The
player who is behind should take underdog bets; the leader should sit out. The 1.1×
multiplier is a small house bonus so that engaging with the slate is mildly correct
every day even for a comfortable leader, since the daily ritual is half the point.

`p` is clamped to `[0.05, 0.95]` as a safety net against absurd payouts, though slate
filtering should prevent extreme prices from appearing at all.

**No stake cap.** All-in is allowed and the chaos is intended. This is self-balancing
without a cap: reserves are only *undeployed* soldiers, so building a large stake means
hoarding, and hoarding means leaving the map thin. The all-in is already paid for.

**No slate on the final day.** Wagers placed on day N pay out at tick N+1, so a day 21
stake could never be spent. Publishing no slate on the last day avoids burning reserves
on nothing.

### Market selection

Candidates must close before 21:00 ET the same day, clear a volume floor so they cannot
be cheaply moved, and be priced between 0.10 and 0.90. Pick 3–5.

The volume floor is set from observed data rather than guessed: during implementation,
sample a week of Kalshi same-day markets and set the floor at the median. Store it as
config so it can be raised without a deploy.

**Prices are snapshotted once**, when the slate is published at 08:00, and that price
applies to everyone regardless of when they submit. Pricing at submission time would
give whoever submits last strictly better information — they could watch a market move
on breaking news and bet into a stale line.

**Sources:** Kalshi is primary. Same-day settlement is its core product, so a reliable
supply of markets closing on a given day exists. Manifold is the development and
fallback source; its API is open and unauthenticated.

Polymarket is explicitly not used. Its UMA optimistic oracle has a proposal-and-
challenge window that can run from hours to days, which is incompatible with a daily
tick.

## Daily timeline

| Time | Event |
|---|---|
| 08:00 | Fetch candidates, filter, pick 3–5, snapshot prices, publish slate to web and Slack |
| all day | Players post workout photos to Slack and react; players submit and revise orders on the web app |
| 21:00 | Lock orders. Read cached approvals and yesterday's settlements. Run the pipeline. Save state. Post recap to Slack with a rendered map. |

The map image is generated server-side by rendering the board to SVG from `GameState`
and rasterizing it to PNG for Slack. The same SVG renderer backs the web app's board
view, so there is one source of truth for how the map looks.

The recap deserves real effort. It is the daily artifact everyone actually sees — who
attacked whom, whose bet paid off, who posted their workout. In a friend group that
drives return visits more than the web app does.

## Failure modes

**The tick must never be blocked by an outside system.**

- **Slack approvals are cached as they happen.** The bot writes reaction events to the
  DB continuously via the Events API. At 21:00 the tick reads local state and never
  calls the Slack API, so a Slack outage at tick time is harmless.
- **No market slate → the day runs as plain Risk.** If the market source is unreachable
  at 08:00, publish an empty slate, post a note, carry on. A missing market day is a
  disappointment; a stalled season is fatal.
- **Unsettled markets roll forward.** A market not settled at tick time carries to the
  next tick. Still unsettled after 48 hours, the stake is refunded.

**Invalid orders are dropped, never thrown.** Validate in the web app for good UX, and
again in the engine — but the engine silently discards a malformed order rather than
aborting. One player's bad attack must never take down everyone's tick.

**No order submitted** is a valid state: nothing happens, reserves accumulate.

**Recovery.** Because state is immutable per day, a bad tick is fixed by correcting the
code and re-running from day N−1.

**Time.** Everything is pinned to `America/New_York`. No ambiguity about what "today"
means.

## Testing

In priority order:

1. **Combat edge cases.** Mutual attacks, three factions on one territory, exact ties,
   an attack that wins with zero survivors, a territory captured and lost in the same
   tick. This is where the bugs live.
2. **Protection edge cases.** Parity with one, two, and three picks on the same
   territory. A pick from an eliminated player with no approved action that day (must
   not count toward parity). A protected territory that is also mutually attacked. A
   protection on a territory whose owner is also attacking out of it.
3. **Property tests.** Troops are conserved (in = out + casualties). Reserves never go
   negative. Every territory always has exactly one owner.
4. **Season simulation.** Run several thousand synthetic seasons with scripted
   policies: *Turtle* (never attacks), *Blitz* (always attacks the weakest neighbor),
   *Gambler* (stakes heavily daily), *Slacker* (zero workouts), *Gym Rat* (max workouts,
   mediocre strategy). Answer the questions the economy hinges on:
   - Does Gym Rat beat Blitz? If yes, the IRL grant is too strong.
   - Does Gambler ever win? If never, variance is too weak to produce comebacks.
   - How often does the day-3 leader win? If usually, the season is decided too early.
   - How often does a protection actually void an attack that would have succeeded? If
     near zero the mechanic is decorative; if it decides most late-season territory
     changes, eliminated players have too much say over a game they cannot win.

   This is the reason for the pure-engine architecture. Discovering that the 1.1×
   payout is wrong costs nothing in simulation and costs the whole season on day six.
5. **Golden-file replay.** Record one real season's orders, replay, assert identical
   output. Catches regressions when tuning numbers between seasons.
6. **Adapter tests against recorded fixtures.** Saved Kalshi and Slack responses on
   disk. Tests never hit the network.

## Deployment

A single DigitalOcean droplet. SQLite on an attached volume, systemd timers for the
08:00 publish and 21:00 tick, Next.js served behind Caddy or nginx.

App Platform is rejected: its filesystem is ephemeral, so SQLite would be wiped on
every redeploy. Using it would require managed Postgres, which is unnecessary cost and
complexity for a database that holds a few hundred kilobytes.

## Deferred to future seasons

These are recorded as considered-and-deferred, not as open questions blocking
implementation.

- **Interlocked economy variant.** Approved actions set daily *wager capacity* rather
  than granting soldiers. Effort would buy access to the market game instead of buying
  army. More elegant, easier to get wrong; revisit after season one produces real
  balance data.
- **Scripted bot factions.** The order interface already accommodates them. Useful for
  filling out a small roster.
- **Respawn on elimination.** Superseded for season one by the daily protection, which
  keeps eliminated players engaged without letting them re-enter the map. Revisit only
  if protections turn out not to hold their interest.
