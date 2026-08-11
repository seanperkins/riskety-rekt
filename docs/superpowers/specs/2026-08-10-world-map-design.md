# The world map — design

**Status:** approved 2026-08-10. Supersedes the "~105-territory map" line item in
`CLAUDE.md`'s "Not built".

## The problem

`season-init` refuses a full-headcount roster. `checkDeal` requires 5–11
territories per faction, and 42 territories dealt to 15 factions is 2.8 each — a
faction holding 6 troops, eliminated by one focused attack, with no continent
ever in reach. That refusal is correct. The board is what is missing.

**A fixed larger board does not solve it.** Measured against `checkDeal`:

| board | legal rosters |
|---|---|
| 42 (`RISK_MAP`) | 4–8 |
| 75 | 7–15 |
| 105 | 10–15 |
| 165 | 15 |

A committed 105-territory map serves 10–15 and hard-refuses a season where only
eight people commit. Together with the existing 42 board it leaves a hole at
exactly 9 factions, which neither board can deal. "How big is the map" is the
wrong question; "what does the map do when eleven people show up instead of
fifteen" is the right one.

## The shape of the answer

**One committed world. A sub-map selected per season, sized to the roster that
actually joined.** The world is real-world geography at Risk's granularity —
around 170 territories in around 28 continents. A season uses a contiguous part
of it: three continents for a four-person season, eighteen for a fifteen-person
one. The selection is driven by the seed `season-init` already records, so the
same seed deals the same board forever and `tick:rerun` replays it exactly.

Five decisions, each with the reason it went that way.

**1. Real geography, not generated.** An earlier draft of this design generated
continents as small graphs and linked them with bridge edges, to control
chokepoints explicitly. Real geography already has that texture and did not need
manufacturing — Australia is a fortress because it genuinely is one, and Siam is
a chokepoint because it genuinely is one. Generated geography also forces
invented names, and "North Vellholt" is worse than "Kenya" in a game whose
output is people talking in Slack.

**2. Fresh board per season.** Nobody has map knowledge on night one, every
season is a new puzzle, and the board always fits whoever joined. Reproducibility
comes from the seed rather than from the board being fixed: re-dealing with
`--seed 4711` gives back a board the group liked.

**3. Whole continents only.** A sub-map that cut a continent in half would leave
continent bonuses meaningless — a "continent" you complete by holding three of
its six real territories is not the mechanic. Selecting whole continents keeps
every bonus a real objective and keeps each continent internally contiguous for
free.

**4. Contiguous growth from a seeded start.** The selection walks outward through
adjacent continents until the size is legal. Each season is therefore a
recognisable part of the world — a Mediterranean season, an Americas season —
rather than a scatter of disconnected regions.

**5. Continent bonuses are computed after selection.** See "Bonuses" below. This
is the one part of the design that could not have been carried in the world data.

## Units

| File | Responsibility | Depends on |
|---|---|---|
| `src/map/world.ts` | The committed world: territories, continents, land borders, sea links. Pure data. | `engine/types` |
| `src/map/coords.ts` | `COORDS: Record<TerritoryId, { lat: number; lon: number }>` | nothing |
| `src/map/validate.ts` | `validateMap(map): MapProblem[]` | `engine/types` |
| `src/map/select.ts` | `selectSubMap(world, factionCount, rng): GameMap` | world, validate |
| `src/rng.ts` | `makeRng(seed): Rng`, moved from `src/sim/policies.ts` | nothing |

`RISK_MAP` is **not** replaced. It stays in `src/engine/map.ts` as
`createSeason`'s default and as the golden file's fixture, so the engine's
regression test is untouched by anything in this design.

`validateMap` is the existing `src/engine/map.test.ts` invariants lifted into a
function. They currently run against `RISK_MAP` alone; they now have to run
against every selected sub-map, and a sub-map is generated rather than reviewed,
so they stop being a one-off check and become the thing that makes generation
safe. It returns a list rather than throwing, so a validation failure can name
every problem at once.

`makeRng` moves to `src/rng.ts`. It has three consumers now — the simulator,
`season-init`'s shuffle, and map selection — and `src/jobs/season-init.ts`
importing from `src/sim/policies.ts` was already backwards.

### Coordinates live outside `GameMap`

`lat`/`lon` are **not** fields on `Territory`. They are a separate lookup keyed
by territory id.

The engine has no use for geometry, and the same rule that keeps the clock out of
the engine keeps coordinates out of it. Two concrete costs decided it: the golden
file serialises the whole map, so adding two fields to `Territory` would churn
`__golden__/season-1.json` by 84 values with no behavioural change — precisely
the "it changed but it's fine" that trains people to regenerate a golden file
without reading it. And `GameState.map` is serialised into *every* daily `states`
row, so the coordinates would be stored fifteen times per season to be read by
nothing.

The web renderer imports `COORDS` directly and projects it. That is strictly
better than the alternative it replaces — a force-directed layout over an
abstract graph — because the output is a real map.

## The world data

**Granularity is Risk's, not the UN's.** Real countries where a country is
roughly the right size; large countries split into regions the way classic Risk
splits the United States and Russia. The target is that no territory is
absurdly larger than its neighbours in play value.

**Microstates merge into a neighbour.** Monaco, San Marino, Liechtenstein,
Andorra and the Vatican are not territories. Each is absorbed into the adjacent
territory it sits inside, and its name is not preserved.

**Continents are 4–9 territories, and this is enforced.** UN M49 subregions are
the starting point but several are unusable as continents: Eastern Africa is
twenty countries, which is a continent nobody ever completes and a bonus nobody
ever collects. Those split along real internal lines — Horn of Africa, African
Great Lakes. The 4–9 band is the same one classic Risk uses for five of its six
continents, and `validateMap` rejects a world that violates it.

Target: **165–175 territories in 26–30 continents.** The exact count falls out of
authoring; the bands are what the tests assert.

**Sea links are curated, deliberate and few.** A pure land-border graph is
disconnected — Japan, Madagascar, Iceland, the United Kingdom, Indonesia,
Australia and New Zealand have no land neighbours at all. Every sea link is a
choice, exactly as `kamchatka ↔ alaska` is a choice in classic Risk, and each one
creates a chokepoint. They are listed in one place in `world.ts` with a comment
per link, not scattered through the territory records, because the set of sea
links *is* the strategic skeleton connecting the landmasses.

**Continent adjacency is derived, never stored.** Two continents are adjacent if
any territory in one borders any territory in the other. Storing it separately
would be a second source of truth that can drift from the borders.

## Selection

```
selectSubMap(world, factionCount, rng) -> GameMap

  lo, hi  = 5 * factionCount, 11 * factionCount     -- checkDeal's window
  target  = 7 * factionCount

  for attempt in 1..MAX_ATTEMPTS:
      picked = { one continent, chosen by rng }
      while size(picked) < lo  or  |picked| < MIN_CONTINENTS:
          candidates = continents adjacent to picked whose addition keeps size <= hi
          if candidates is empty: break                    -- stranded, restart
          pick the candidate whose result is nearest target; ties broken by rng
          add it
      if size(picked) in [lo, hi] and |picked| >= MIN_CONTINENTS:
          return induce(world, picked)
  throw
```

`MIN_CONTINENTS = 4`. `MAX_ATTEMPTS = 20`.

**Why 4 and not 3.** Three is already guaranteed by the size floor and would be
dead code: the smallest possible floor is `5 × 4 = 20` territories and the
largest continent is 9, so `ceil(20 / 9) = 3` continents is unavoidable. Four is
the first value that constrains anything. It is satisfiable at every roster size
— four continents span 16–36 territories, which overlaps the 20–44 window a
four-faction season allows — and it is what makes a continent race exist rather
than a scramble for one of two prizes.

Three things this has to get right, each of which is a real failure rather than a
hypothetical one.

**It can strand itself, so it restarts.** A four-faction season caps at 44
territories. A walk that starts in a dense region can reach 30 territories with
every adjacent continent being 9 — no candidate fits under 44, and the walk is
stuck below `lo`. Restarting from a different seeded start is the fix; a bounded
attempt count keeps it from looping forever; exhausting the attempts **throws
with a named error** rather than returning an illegal board.

**It must not return a thin board.** Size alone would let a four-faction season
finish at three continents, where two players can hold one each and the third is
a coin flip — a continent race with almost nothing in it. `MIN_CONTINENTS` is
checked in the loop condition rather than only at the end, so the walk keeps
growing instead of returning a board it would then have to reject.

**The induced sub-map filters neighbour lists.** A territory on the edge of the
selection has neighbours that were not selected, and those references must be
dropped or the map fails its own symmetry invariant. Connectivity survives this
by construction — whole continents are internally contiguous and the walk only
ever adds adjacent ones — but `validateMap` asserts it anyway, because "by
construction" is a claim about code that can change.

## Bonuses

A continent's defensibility depends on which of its neighbours were selected.
Northern Africa with Southern Europe and Western Asia on the board has three ways
in. Northern Africa on a board with neither is a fortress. **The bonus is
therefore a property of the sub-map, not of the world**, and cannot be carried in
`world.ts`.

```
entries = territories in the continent with at least one edge leaving it
bonus   = floor(size / 2) + floor(entries / 3)
```

Calibrated against classic Risk, which it reproduces exactly on four of six:

| continent | size | entries | Risk | formula |
|---|---|---|---|---|
| Australia | 4 | 1 | 2 | **2** |
| South America | 4 | 2 | 2 | **2** |
| Africa | 6 | 3 | 3 | 4 |
| Europe | 7 | 4 | 5 | 4 |
| North America | 9 | 3 | 5 | **5** |
| Asia | 12 | 5 | 7 | **7** |

Both misses are by one and in opposite directions, so the formula is not
systematically generous or stingy. It ships as written and the simulator judges
it — the same way `VOLUME_FLOOR` was settled from measurement rather than from
argument. A formula within ±1 of hand-tuned Risk across the whole range is a
better starting point than a number defended in prose.

Bonuses feed `territoryIncome` as `max(5, floor(t / 2)) + bonuses`, so this
formula is an economy change and is covered by the balance run below.

## Integration

**`season-init`** selects the board before dealing:

```ts
const rng = makeRng(seed)
const map = selectSubMap(WORLD, members.length, rng)
const territoryIds = shuffle(map.territories.map((t) => t.id), rng)
const state = createSeason(seasonId, factions, territoryIds, map)
```

Both draws come from **one** `rng` instance, in that order. Two instances seeded
from the same number would deal a board and then shuffle it with a correlated
sequence. `createSeason` already validates that the dealt set is exactly the
map's territory set, so a selection/shuffle mismatch fails loudly at the deal.

The existing `checkDeal` call stays, and moves to *after* selection — it now
validates the selected board rather than `RISK_MAP`. Its roster-size branch still
runs first, so an out-of-bounds roster is refused before any selection work.

**The simulator** generates a board per season the same way, so balance is
measured on the boards that are actually played:

```ts
const rng = makeRng(seed)
const map = selectSubMap(WORLD, policyNames.length, rng)
```

This is deliberate and it invalidates existing figures. The alternative —
leaving the sim on `RISK_MAP` — is the same defect as `SEASON_DAYS` versus
`SEASON_LENGTH`: two constants that drift apart until every future measurement is
quietly unreproducible. Both committed balance documents are superseded and a
fresh run is part of the work, not a follow-up.

**`createSeason`** is unchanged. It already takes an optional trailing `map` and
already validates the dealt set against it.

## Testing

**Property tests over the generator** — every roster size 4–15 crossed with many
seeds, asserting for each selected map: `validateMap` returns no problems,
`checkDeal` returns null, at least `MIN_CONTINENTS` continents, every continent
4–9, and every bonus at least 1. This is what makes generated boards safe, and it
is cheap because the whole thing is synchronous and pure.

**A stranding test** that drives the selector into its restart path with a roster
size and world shape that forces it, asserting it recovers rather than throwing —
and a test that exhausting `MAX_ATTEMPTS` throws a named error rather than
returning an illegal map.

**Determinism** — the same seed and roster size produce an identical map, and
different seeds produce different ones.

**World data invariants** — `validateMap(WORLD)` is clean, continent sizes are in
band, `COORDS` has an entry for every territory and no entries for territories
that do not exist, and every latitude is in [-90, 90] and longitude in
[-180, 180].

### What the tests cannot cover

**Geographic accuracy.** "Chad borders Egypt" is symmetric, connected, in-band
and wrong. No invariant catches it. The world data needs a human review pass
against a real map, and that pass is part of the work rather than an optional
extra. Stating it here so it is not discovered in season one.

**This is what the viewer is for.** A bogus border is invisible in a data file
and obvious as a line jumping across Sudan on a map. See "The viewer" below —
it is the instrument that makes this review pass possible, not a presentation
layer bolted on afterwards.

**Whether the boards are fun.** The property tests prove a board is legal, not
that it plays well — a legal board can still be a chain of continents with one
path through it. The balance run is the only evidence on that, and it measures
outcomes rather than shape.

## Rejected

**Generated geography with invented names.** Superseded during design. Real
geography supplies chokepoints and defensible corners without manufacturing
them, and real names are worth more in a game played through conversation.

**Relaxing `checkDeal` instead of building a map.** Widening the 5–11
territories-per-faction band would let 15 factions onto the 42 board. The upper
bound is where income leaves the `max(5, floor(t/2))` floor, so raising it
changes the economy — it trades a board-building job for an economy-rebalancing
job and still leaves everyone with 3 territories.

**A committed set of boards, one per roster size.** Twelve generated boards,
picked and committed, so the group learns them. Rejected in favour of fresh
boards: map knowledge is a real pleasure but twelve committed data files that are
dead weight until a matching roster appears is a poor trade against a seed that
reproduces any board on demand.

**Variety-weighted starts.** Biasing the start away from recently used regions
would stop three Mediterranean seasons in a row. Rejected because it requires
cross-season state and breaks the property that the seed alone determines the
board — which `tick:rerun` depends on.

**`lat`/`lon` on `Territory`.** Costs given above: golden-file churn with no
behaviour change, and coordinates stored in every daily state row to be read by
nothing.

## The viewer

A single self-contained HTML page, generated from the world data, that draws a
selected sub-map: territories at their real coordinates, borders as edges,
continents by colour, with controls for roster size and seed.

**Its first job is verification, not presentation.** It is how the geographic
accuracy pass above actually happens, and how "does this board play well" gets
looked at before a balance run rather than after. Both are questions the
property tests are structurally unable to answer.

Requirements, all of them consequences of that job:

- **Real projection.** Equirectangular from `COORDS`, so a wrong border is
  visibly wrong. A force-directed layout would place Chad next to Egypt because
  they are adjacent in the data, hiding the exact defect being hunted.
- **Re-roll in the page.** Roster size 4–15 and an editable seed, with selection
  running client-side, so many boards can be eyeballed without a rebuild. This
  requires the selector to be portable to the browser — no Node APIs in
  `src/map/select.ts`, which it has no reason to use anyway.
- **The numbers alongside the picture.** Territory and continent counts, each
  continent's size, entry count and computed bonus, and the `checkDeal` verdict.
  The bonus formula is the part of this design most likely to be wrong, and
  seeing its output across many boards is the cheapest way to find that out.
- **Self-contained.** World data inlined, no network, no dependencies —
  consistent with the rest of the project, and it means the page can be opened
  from disk or published without a server.

It is a development instrument, not the web app. It renders a generated board;
it does not know about seasons, factions, ownership or orders.

## Out of scope

- **The web app.** Session-derived `factionId`, order entry, the public
  projection and the live board with ownership on it. The viewer shares no code
  with it beyond `src/map/`, and deliberately: it draws a map, not a game.
- **The wager economy's stale-price exploit.** Unrelated and still the more
  urgent blocker on a competitive season.
- **Pluggable mechanics.** Its own draft spec, and it regenerates the golden
  file for unrelated reasons.
