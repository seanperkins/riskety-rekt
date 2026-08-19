# The map

How the board gets from Natural Earth onto a player's screen, and the traps
that cost a day. Written after a run of bugs that were all invisible to a green
test suite and obvious in a browser — the symptoms are recorded alongside the
rules, because the symptom is how you will recognise one again.

## The pane stack

Leaflet draws panes in z-index order and **SVG has no z-index within a pane** —
inside one pane, later-added elements paint over earlier ones. Both facts have
bitten us, so ordering is expressed as panes wherever it matters.

| Pane | z | Contents | Why there |
|---|---|---|---|
| `backdrop` | 200 | the rest of the world, one canvas shape | Behind everything. Off unless `?backdrop=1` |
| `bridges` | 350 | sea crossings | Behind the land they connect, so a bridge passes *under* a coastline |
| `overlay` | 400 | the 70 playable territories | Leaflet's default vector pane |
| `highlight` | 450 | the hovered region's outline | Above territories. At 350 it sat *under* the heavier stroke on owned territories and vanished exactly where it mattered |
| `marker` | 600 | garrison counts, region badges | Leaflet's default; labels sit over everything |

`shadow` (500), `tooltip` (650) and `popup` (700) are Leaflet's and unused by us.

**Only the board's territories are interactive.** Everything else is
`interactive: false`, including every label — a label that swallows the tap
meant for the territory beneath it is worse than no label. The one exception is
the region badge, which is deliberately hoverable and is only safe because it
sits *outside* the region's bounding box and so covers no playable ground.

## What the build generates

`npm run build:shapes` writes **all** of `src/map/shapes.ts`. Never hand-edit it.

| Export | What it is |
|---|---|
| `SHAPES` | coarse rings, ~16.6k points, the whole world |
| `SHAPES_FINE` | the same territories at ~3× detail, board only in the projection |
| `LABELS` | where a garrison count goes |
| `LABEL_BOXES` | the room it has, as `[w, s, e, n]` |
| `REGION_OUTLINES` | each region's outer boundary, internal borders dissolved |

Source is Natural Earth **admin-1 10m**, cached at `.cache/admin1-10m.geojson`
(39 MB, gitignored). Absent, the build falls back to Voronoi cells and says so.

**Everything comes from one dataset, and that is load-bearing.** Territories
used to be a mix — carved ones from 10m admin-1, plain ones from the 110m
country file — and a province boundary at 10m is simply a different line from a
country boundary at 110m. 101 adjacent pairs shared no vertex for that reason
alone. A plain country is now just a country with **one** claimant, so its
provinces merge back into the country from the same arcs its neighbours use.
Seven need an explicit name in `ADMIN1_NAMES` because admin-1 spells out what
the 110m file abbreviates.

**Simplification happens once, in topology space.** Simplifying each territory
alone leaves gaps: two neighbours simplify the same border independently and
keep different vertices. In TopoJSON a shared border is a single arc, simplified
once, so both sides read back identical geometry and the seam closes by
construction. Thresholds are **area weights, not distances** — 0.05 coarse,
0.004 fine — found by measuring point counts, not reasoned from degrees.

Gaps went from 39% of adjacent pairs to 8% of land borders.

**Adjacency is now derived from the same geometry, not authored beside it.** The
build emits `src/map/adjacency.ts` and `world.ts` consumes it. The pairs this
section used to shrug at (`andalusia|catalonia`, `provence|switzerland`) are gone
from the graph because they are gone from the picture, and the reverse case is
gone too: the drawn `gauteng` had absorbed North West province and plainly
bordered Botswana while the hand-authored list said it did not, so a player could
not attack across a border on their screen. 77 pairs were drawn touching but
unreachable, 39 reachable with no shared edge.

It comes from **two** sources, and conflating them hides where the judgement is:

- **Shared arcs**, for all but eight pairs. An arc belongs to one boundary, so
  sharing one is sharing a stretch of drawn edge. This is a fact about the data.
- **The 0.1° seam rule**, for the remaining eight, exported as `SEAM_BORDERS`.
  Where a Voronoi-carved shape meets an admin-1 one the same border is drawn
  twice from two datasets and shares no arc; two or more vertices within 0.1°
  spanning real distance links them. That recovers Bohemia, Baluchistan and
  Chukotka, which shared no arc with anything and were cut off entirely. Measured:
  every real pair spans 1.4–11.4°, every false one has a single vertex and zero
  span. This is a heuristic, which is why it ships as a separate, reviewable list.

Two costs, both deliberate:

- **A corner touch is not a border.** A junction ends an arc rather than sharing
  one, so `namibia|zimbabwe` is no longer adjacent.
- **A border absent from the source topology is lost.** Botswana and Zambia have a
  real frontier at Kazungula — about 135 m, the shortest on Earth — but Natural
  Earth's admin-1 10m source represents it as one shared vertex and zero shared
  segments before this script simplifies anything. The arc pass has nothing to
  derive. A board that needs that crossing gets a `SEA_LINKS` entry.

Water crossings **without a shared source edge** cannot be derived, so `SEA_LINKS`
stays hand-authored with a named strait per entry and is the only adjacency a
person still writes. It is also **excluded from the seam rule**: 0.1° is 11 km at
the equator and the Strait of Messina is 3 km, so six listed crossings clear that
bar on distance alone. They are adjacent through `SEA_LINKS` regardless — a
heuristic must not be what says water is land. A different case is a source arc
drawn across a narrow strait: Ceuta, Northern Ireland, Kanmon and Tsugaru are
genuinely edge-sharing in this data. `world.ts` joins those pairs to `SEA_LINKS`
and de-duplicates.

### Labels

A garrison count is placed at the centre of the **largest label-shaped
rectangle that fits inside** the territory, and hidden when that rectangle is
too small on screen for the digits. One computation answers both questions.

Found by scanline-rasterising the largest ring into a 96×96 grid and running
largest-rectangle-in-a-binary-matrix over row histograms, scored by how large a
*label-shaped* box fits rather than by area — a tall narrow rectangle has plenty
of area and is useless for a number wider than it is tall. Corners are the
**centres of the corner cells**; taking cell edges overshoots by half a cell and
put a corner of 221 of 264 boxes outside the coastline.

Do not use the territory's **bounding box** for the fit test. Norway's is
enormous while its interior is a few kilometres wide, so the number passed and
then sat in the sea.

## Traps

Each of these shipped. The symptom is listed because that is what you will see.

**A label that will not move when you zoom.** `el.className = "..."` wipes
Leaflet's own classes, `leaflet-zoom-animated` among them, and that class is
what repositions a marker. Symptom: correct on load, drifting off and bunching
after any zoom. Use `classList.toggle`.

**A blank board.** The client is a **string**, so a `ReferenceError` in it never
reaches the type checker or the suite. Symptom: nothing renders at all, tests
green. `src/web/client.test.ts` now runs the client against DOM and Leaflet
stubs, and asserts the wiring exists rather than only that it survives.

**A stray backtick.** `CLIENT` is a `String.raw` template, so a backtick
anywhere inside it — including in a comment — ends it early.

**A badge with no hit area.** `L.divIcon` **defaults to `iconSize: [12, 12]`**
and writes it as an inline width/height that beats the stylesheet. Omitting the
option is not enough; pass `iconSize: null`. Symptom: text renders normally and
hover does nothing, which looks exactly like a missing listener.

**Islands punched out as holes.** `L.polygon` reads a flat array of rings as
outer-then-holes. Every ring in `SHAPES` is a separate landmass, so each must be
wrapped in its own array. Symptom: swiss cheese — Nunavut lost 20 Arctic
islands.

**A bar straight across the map.** Two causes. A ring spanning the antimeridian
(Fiji, stored -180..+180) and a Voronoi sliver — 29° wide, 0.5° tall, four
points. `MIN_AREA` cannot catch the second: 14 square degrees is hundreds of
times the threshold. Area is the wrong test; **shape** is. Both are now
invariants in `shapes.test.ts`.

**An invisible map.** `.stage svg` as a *descendant* selector also matched
Leaflet's overlay SVG, whose parent pane is a 0×0 absolutely positioned element.
Symptom: every path reports a correct bounding box and nothing is visible —
SVG geometry does not depend on the outer element having layout size, so
scripted checks pass. Use `.stage > svg`.

**Deleting neighbouring code.** Twice, replacing a span between two markers ate
functions living inside it. Once nothing threw and four features silently
ceased to exist. Make targeted edits.

## Performance

The board is small — 92 SVG paths, ~2.8k points — so geometry has never been the
cost. What has:

- **Forced layout.** Measuring 70 paths with `getBoundingClientRect` on every
  frame of a zoom. Label sizing is now pure `latLngToLayerPoint` arithmetic and
  runs on `zoomend` only.
- **Path count.** The backdrop was 451 SVG polygons against the board's 70. One
  canvas shape instead: a single draw call.
- **Zoom cycles.** `zoomSnap: 0` makes every wheel notch a distinct fractional
  zoom, each interrupting the last animation. It is now used *only* for the
  opening `fitBounds` — which is what fills the frame — and set to 0.25
  immediately after.

`fitBounds` runs exactly twice: once on load, once when a player row is clicked.

## Query switches

For comparing without a redeploy: `?backdrop=1`, `?zoomsnap=N`, `?zoomanim=0`.

## A note on verifying

Several of these were mis-diagnosed first because the check looked right. SVG
path bounding boxes resolve even when nothing is painted; synthetic
`WheelEvent`s do not drive Leaflet's scroll zoom at all; `requestAnimationFrame`
does not fire in a backgrounded tab, so frame timing cannot be measured from an
automation session. **A screenshot is the only check that sees what a person
sees.** When one is unavailable, say the verification is unavailable rather than
substituting a weaker proxy.
