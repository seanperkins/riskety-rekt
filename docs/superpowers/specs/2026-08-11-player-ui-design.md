# The player UI — design

**Status:** approved 2026-08-11. Spec **C** of three; see "Prerequisites".

## The problem

Order entry is CLI-only, which means two things a season cannot start with:
whoever runs the commands can read every faction's deploys, attacks and
`protect` picks straight out of SQLite, and everybody else needs a shell.

## Prerequisites, and why this is three specs

Turning "the web app" into one document would bury the security boundary and
the data pipeline under layout decisions. They are separated:

| | Spec | Why separate |
|---|---|---|
| **A** | Session auth — `/login` slash command, magic link, cookie, `factionId` | The security boundary the whole secrecy model rests on. Everything here assumes a session yields a `factionId`. |
| **B** | Territory geometry — Natural Earth to committed GeoJSON, keyed by game id | A data pipeline with its own risks: merges (Senegal carries Gambia and Guinea-Bissau), unions (Cascadia is Washington plus Oregon), simplification budget. |
| **C** | **This document** — the pages, the map, the plan, the replay | |

This spec is designed against both and builds on neither: it can be reviewed
now and implemented once A and B land.

## Shape

Four routes on the existing `node:http` server. No bundler, no framework, no
build step — the properties that keep `node:sqlite` loadable are unchanged.

| Route | What it does |
|---|---|
| `/` | The board, your plan, the countdown |
| `/wagers` | Today's slate and your stakes |
| `/day/:n` | The night replayed |
| `/login/:token` | Consumes the magic link *(spec A)* |

### Two client dependencies, and why they are a different category

This is the first page that needs client JavaScript — map-first tapping cannot
be server-rendered — and it takes **Leaflet** for the map.

That does not break "no new runtime dependencies" in the sense that rule was
written. Leaflet is served statically to the browser: it never touches the
server, `node:sqlite`, the tick, or the test suite, and it needs no bundler
because it ships as plain UMD. A server dependency could break the store; a
client one cannot. The rule in `CLAUDE.md` is amended to say so rather than
quietly violated.

Everything else client-side is **vanilla, hand-written, served from memory** the
way `STYLE` already is. The job is small: attach handlers, hold a plan, `fetch`
to save, re-render one list.

Serving Leaflet's two files is the one new server capability — a static route
with an explicit allow-list of paths, not a directory served wholesale.

## The board

**Leaflet in its default CRS, over lat/lon GeoJSON from spec B.**

Web Mercator inflates high latitudes, so a Siberian holding *looks* larger than
it plays. That is a perception cost and not a mechanical one — territory counts
are on screen throughout — and it buys a great deal: no pre-projection step,
plain lat/lon in spec B, standard Leaflet behaviour, and the option of a real
tile basemap later.

**The debug view at `/map` keeps Equal Earth.** Not inertia: it is already
property-tested, and an unstretched high latitude is easier to audit borders in,
which is that page's entire job. The two views serve different purposes and are
allowed to differ; both are documented as deliberate.

**The map opens fitted to your territories**, zoomed so your holdings and their
borders fill the screen. Leaflet gives pan and pinch-zoom, so "show me
everything" is a gesture rather than a mode. Ownership is fill colour; garrison
counts are labels.

### Acting on it

- **Tap a territory you own** → a sheet offering deploy, attack, or protect
  where legal.
- **Tap an adjacent enemy** → attack, pre-filled with the origin you last
  selected.
- The sheet **states the action in words** and takes a count. Nothing commits
  from a tap alone; the sheet is the confirmation.

## The plan

Every action edits a plan that **saves to the server immediately** and is listed
under the map in plain words — *"attack Somalia from Kenya with 4"*. There is no
submit button to forget.

Three properties matter more than they look:

- **The header always states the deadline and what happens at it** — "resolves
  in 1h 18m". The entire game turns on 21:00 and this is where a player would
  look.
- **A failed save is loud and stays loud.** The row goes red and does not clear
  itself. A silent write failure costs a season, and it is the single worst
  outcome this page can produce.
- **After 21:00 the page is read-only and says why**, rather than accepting taps
  the server will reject.

**The client never validates.** It displays your reserve and what the plan
spends, but legality belongs to the engine — whose rejections already surface
publicly in the recap. A client that pre-validated would drift from the engine
and start lying, and the lie would be invisible until a rejection appeared in
front of the whole channel.

Saving replaces the whole order body, matching `saveOrder`. The plan is the
order; there is no merge.

## Wagers

The slate is 3–5 markets. Each shows its question, both prices, its close time,
and your stake.

**A market locks at `min(closeTime, settlement observed_at)`** — the existing
rule, because `can_close_early` means an outcome can be public hours before the
stated close. A locked market renders locked, with the reason, rather than
taking a stake the server will refuse.

Stakes are part of the same plan and save the same way.

## The day replay

`/day/12` plays the night back: each event in turn, narrated beside the map,
with the board changing as it goes.

### It recomputes nothing

The obvious implementation replays events forward, recomputing ownership and
garrisons — a **second implementation of the engine's bookkeeping**, which is
exactly the kind of duplicate that drifts until the picture and the game
disagree.

Instead the replay animates the log **against two known states**: day N−1 as the
start, day N as the end, both already persisted. Each event highlights
territories and flips ownership where `attack.captured` is true. Nothing is
derived that the engine did not already record.

That yields an invariant worth testing: **the replay's final ownership must
equal the saved day-N state.** A test asserts it across every day of a simulated
season. If they ever disagree, the replay is lying and the test says so.

### What a step looks like

The tick's `log` is already an ordered `TickEvent[]` inside each day's
`GameState`, so the script exists. It is presented in three acts:

1. **Reinforcements** — one opening summary, not fifteen steps. Territory
   income, IRL grants and settled wagers all arrive as **soldiers in the bank**,
   itemised: *"+5 income, +2 workout, +7 from Kalshi — 14 soldiers."* Treating a
   wager payout as anything other than soldiers arriving would make the game
   feel like two systems instead of one.
2. **The map** — deploys, then field battles, protections and attacks, each its
   own step. *"Kenya attacks Somalia with 4 — captured."*
3. **Rejections** — anything the engine refused, in plain words, last. They are
   already public in the recap; hiding them here would be a second version of
   the truth.

### Controls

Play, pause, step, and a scrubber. **Auto-plays the first time you open a given
day** and starts paused thereafter — fun once, irritating on the fifth visit.
"Seen" is per-day in `localStorage`, so it costs no server state and a cleared
browser simply gets the animation again.

## Security

Three rules, all inherited rather than invented here:

- **`factionId` is never in a request.** Not validated — *absent from the wire
  format*. The server reads it from the session.
- **The page contains only your projection.** Ownership and garrisons are
  public; your reserve and pending wagers are yours; **no other faction's
  deploys, attacks or protect pick is serialised into the HTML at all.** Not
  hidden with CSS, not present. `protect` matters most: it is legal only for an
  eliminated faction, so leaking it tells the table who is about to be knocked
  out.
- **Every interpolated value is escaped**, without exception. Market questions
  are third-party text from Kalshi and player names come from Slack.

## Testing

Page rendering stays a pure function from projection to HTML, so page tests need
no browser.

Three that carry real weight:

- **No foreign plan in the output.** Given a state where every faction has
  orders, assert no other faction's deploys, attacks or `protect` appear
  anywhere in the rendered HTML. This is the leak that would matter most and the
  one no type checks.
- **The replay ends where the day ended.** Final ownership equals the saved
  day-N state, across a simulated season.
- **A locked market renders locked.** Both branches — past `closeTime`, and
  settled early with `closeTime` still ahead.

The client JavaScript is deliberately thin enough to be verified by using it.
Anything in it worth a unit test is a sign it is holding logic the server should
own.

## Rejected

**A list-first UI with the map as reference.** Recommended and declined: the
map is the reason people care, and Leaflet removes the tap-target problem that
motivated the alternative.

**Equal Earth for the player map.** Correct on the merits — equal-area matters
when territory count is the win condition — and declined for implementation
cost. Leaflet would need a custom CRS with an *inverse* projection, and Equal
Earth's inverse is iterative. Kept in the debug view where it earns its place.

**Recomputing state during the replay.** Covered above: a duplicate of engine
bookkeeping that drifts.

**Client-side validation.** It would drift from the engine and lie.

**A framework and a bundler.** Costs the `node:sqlite` property that
`createRequire` exists to protect, for a page whose client logic is a few
hundred lines.

## Out of scope

- **Standings and a season archive.** `/day/:n` answers "what happened last
  night", which is the question people actually ask. A season history is worth
  building when a season has been played.
- **Posting workouts or reacting.** Stays in Slack, where the social mechanic
  lives. An app that duplicates the channel makes the channel quieter, and the
  IRL mechanic needs it lively.
- **The wager economy's stale-price exploit.** Still unfixed, still its own
  spec, and still the thing that most clearly blocks a competitive season.
