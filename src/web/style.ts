/**
 * The stylesheet, as a string.
 *
 * There is no bundler and no static-asset pipeline — `tsx` runs TypeScript
 * directly, which is the property that keeps `node:sqlite` working, since
 * bundlers strip the `node:` prefix and the module exists under no other name.
 * So the stylesheet is a module export served from memory rather than a file
 * read at request time: one less path to get wrong in production, and it cannot
 * drift from the code that references its class names.
 */
export const STYLE = `/*
 * Palette: a nautical chart. Deep chart blue, brass-sand accent, neutrals
 * biased blue-green toward the ground rather than a default grey.
 *
 * Themed at token level for all three viewer states. The bare :root is the
 * complete light palette; the media query is guarded with
 * :not([data-theme="light"]) so an explicit light choice beats a dark OS; the
 * [data-theme="dark"] block wins the other direction. Nothing below the token
 * blocks names a colour literal — a colour defined only inside a media query
 * never applies in the un-stamped default state, which renders one theme's text
 * on the other theme's ground.
 */
:root {
  --ground: #efeae0;
  --surface: #ffffff;
  --ink: #14232b;
  --muted: #5d7480;
  --rule: #d3cabb;
  --accent: #a8641f;
  --sea: #dfe6e6;
  --edge: #9fb0b8;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0b1a24;
    --surface: #132630;
    --ink: #dfe9ee;
    --muted: #7c98a6;
    --rule: #23404e;
    --accent: #d99a4e;
    --sea: #0f2029;
    --edge: #3c5665;
    color-scheme: dark;
  }
}

:root[data-theme="dark"] {
  --ground: #0b1a24;
  --surface: #132630;
  --ink: #dfe9ee;
  --muted: #7c98a6;
  --rule: #23404e;
  --accent: #d99a4e;
  --sea: #0f2029;
  --edge: #3c5665;
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
}

body {
  background: var(--ground);
  color: var(--ink);
  font:
    15px/1.55 ui-sans-serif,
    system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;
  -webkit-font-smoothing: antialiased;
}

.wrap {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  height: 100vh;
}

.stage {
  background: var(--sea);
  overflow: hidden;
  /* Grid items floor at min-content; without this a wide board forces the
     column wider than the viewport instead of shrinking. Desktop only -- the
     narrow layout overrides it below with a definite height. */
  min-height: 0;
}

/*
 * Narrow layout: map stacked above the rail. This block MUST come after the
 * .stage rule above, and it must set height, not min-height.
 *
 * It used to sit before it and set min-height: 70vh, which lost the cascade to
 * min-height: 0 at equal specificity -- so on every phone-sized viewport the
 * stage computed to 0px and the board was invisible. Leaflet still initialised
 * and still drew all 44 paths into the zero-height box, which is why nothing
 * looked broken to script: the same trap the .stage > svg comment further down
 * describes, arriving through the cascade instead of through a selector.
 *
 * height rather than min-height because #map is height: 100%, and a percentage
 * height resolves against the parent's height -- against auto it collapses to
 * zero however tall min-height makes the box.
 */
@media (max-width: 860px) {
  .wrap {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
  .stage {
    height: 70vh;
  }
}

/*
 * Direct child ONLY. This sizes the debug map's hand-built SVG, which /map
 * renders straight into .stage.
 *
 * As a descendant selector it also matched Leaflet's overlay SVG on the player
 * board, and that SVG's parent -- .leaflet-overlay-pane -- is an absolutely
 * positioned 0x0 element. 100% of nothing is nothing, so the whole board
 * collapsed to an invisible 0x0 SVG while every path inside it still reported
 * a correct bounding box, because SVG geometry does not depend on the outer
 * element's layout size. The board looked fine to script and was blank to a
 * human. Leaflet sizes and positions its own SVG; nothing here may touch it.
 */
.stage > svg {
  display: block;
  width: 100%;
  height: 100%;
}

.rail {
  padding: 28px 24px;
  background: var(--surface);
  border-left: 1px solid var(--rule);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

@media (max-width: 860px) {
  .rail {
    border-left: 0;
    border-top: 1px solid var(--rule);
  }
}

.title {
  font-family: "Iowan Old Style", Palatino, Georgia, serif;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: -0.01em;
  margin: 0;
  text-wrap: balance;
}

.sub {
  color: var(--muted);
  font-size: 13px;
  margin: 4px 0 0;
}

.h2 {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 650;
  color: var(--muted);
  margin: 26px 0 8px;
}

.t {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.t td {
  padding: 3.5px 0;
  vertical-align: baseline;
}

.t td.n {
  text-align: right;
  padding-left: 10px;
  white-space: nowrap;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.sw {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: 8px;
}

.note {
  color: var(--muted);
  font-size: 12px;
  margin: 26px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--rule);
}

.note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: var(--accent);
}

.edge {
  stroke: var(--edge);
  stroke-width: 1.1;
}

.terr {
  stroke: var(--sea);
  stroke-width: 1.6;
}

.terr:hover,
.terr:focus-visible {
  stroke: var(--ink);
  stroke-width: 2.2;
}

.label {
  fill: var(--muted);
  pointer-events: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.terr.dim { opacity: .42; }
.label.dim { opacity: .45; }

.rail a { color: inherit; text-decoration: none; border-bottom: 1px solid transparent; }
.rail a:hover, .rail a:focus-visible { border-bottom-color: var(--accent); color: var(--accent); }
.t tr.on td { font-weight: 650; }
.t tr.on a { color: var(--accent); }
.sub a { color: var(--accent); }

.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 6px; }
.chip {
  display: inline-block; min-width: 26px; padding: 3px 7px; text-align: center;
  border: 1px solid var(--rule); border-radius: 4px; font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums; color: var(--muted);
}
.rail a.chip { border-bottom: 1px solid var(--rule); }
.rail a.chip:hover, .rail a.chip:focus-visible {
  border-color: var(--accent); color: var(--accent);
}
.rail a.chip.on {
  background: var(--accent); border-color: var(--accent); color: var(--ground);
  font-weight: 650;
}
/* Plan rows: the text, then the controls that change it. Every order is built
   one soldier at a time, so minus and plus are the primary controls and the
   remove is the escape hatch. */
.prow { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 2px 0; }
.pbtns { display: flex; gap: 2px; flex: none; }
.prow button {
  min-width: 20px; padding: 0 4px;
  background: none; border: 1px solid var(--rule); border-radius: 3px;
  color: var(--muted); cursor: pointer;
  font: 600 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.prow button:hover, .prow button:focus-visible { color: var(--accent); border-color: var(--accent); }
/* Hovering a saved order lights its ground on the map, and draws its arrow if
   it moves soldiers. The row needs to say it is doing that -- without a cue on
   this side the map appears to light up on its own. Inset rather than a plain
   background so the padding stays even with the rows above and below. */
.prow[data-order]:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 12%, transparent);
  border-radius: 2px;
}

.chip:disabled { opacity: 0.45; cursor: default; }
.chip:disabled:hover { border-color: var(--rule); color: var(--muted); }
/* ---- the replay ----------------------------------------------------------
   Territory flashes. Applied to the polygon's own element, so they ride on top
   of Leaflet's fill without touching the styles Leaflet rewrites on zoom --
   the same reason paintCounts uses classList and never className. */
.lit-own   { animation: rp-pulse .9s ease-out; }
.lit-hit   { animation: rp-hit .9s ease-out; }
.lit-taken { animation: rp-taken .9s ease-out; }
.lit-shield{ animation: rp-shield .9s ease-out; }
@keyframes rp-pulse  { 0% { stroke-width: 1; } 35% { stroke: #e8c56a; stroke-width: 4; } 100% { stroke-width: 1; } }
@keyframes rp-hit    { 0% { stroke-width: 1; } 35% { stroke: #e5534b; stroke-width: 4; } 100% { stroke-width: 1; } }
@keyframes rp-taken  { 0% { stroke-width: 1; } 35% { stroke: #fff; stroke-width: 5; } 100% { stroke-width: 1; } }
@keyframes rp-shield { 0% { stroke-width: 1; } 35% { stroke: #6ad1e8; stroke-width: 5; } 100% { stroke-width: 1; } }
@media (prefers-reduced-motion: reduce) {
  .lit-own, .lit-hit, .lit-taken, .lit-shield { animation: none; }
}

/* The wagers sheet. Overlays the whole app rather than sitting in the rail:
   five markets with their own controls do not fit a 300px column, and on a
   phone the rail is below the map entirely. */
.sheet { position: fixed; inset: 0; z-index: 900; background: rgba(4, 12, 18, 0.6);
  display: grid; place-items: center; padding: 20px; overflow-y: auto; }
.sheet[hidden] { display: none; }
.sheet-in { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px;
  padding: 20px 22px; max-width: 62ch; width: 100%; max-height: 86vh; overflow-y: auto; }
.sheet-in .h2 { margin-top: 0; display: flex; align-items: center; justify-content: space-between; }
ul.wagers { list-style: none; margin: 10px 0 0; padding: 0; }
ul.wagers .wager { padding: 10px 0; border-top: 1px solid var(--rule); }
ul.wagers .wager b { font-weight: 650; }
ul.wagers .wager .hint { display: block; margin-top: 2px; }

/* ---- placing a wager ---- */
.bet { margin: 6px 0 2px; }
.bet .chips { margin: 4px 0 4px; }
.bet .side { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
/* The chosen side, not a hover state: it is the saved bet, so it reads as
   selected even when the pointer is elsewhere. */
.bet .side[aria-pressed="true"] { background: var(--accent); border-color: var(--accent);
  color: var(--ground); font-weight: 650; }
.stakerow { display: flex; align-items: center; gap: 6px; }
.stakerow .stake { min-width: 26px; text-align: center; font-weight: 650;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.bet-state { margin-left: 2px; }

.rp-controls { margin-top: 10px; }
.chip.on { background: var(--accent); border-color: var(--accent); color: var(--ground); font-weight: 650; }
/* Tall enough to hold context either side of the playing beat: a peephole that
   scrolls constantly never tells you where you are in the night.
   min-height is the load-bearing one. .rail is a flex COLUMN, and a flex item
   that scrolls its own overflow is free to shrink to nothing when the column is
   full -- which it was, so this collapsed to a single visible line and no
   max-height could have stopped it. */
.rp-steps { list-style: none; margin: 0; padding: 0;
  flex: 1 1 auto; min-height: 34vh; max-height: 52vh; overflow-y: auto;
  font-size: 12px; color: var(--muted); }
.rp-steps .prow { padding: 3px 0; border: 0; opacity: .55; }
.rp-steps .prow.done { opacity: .8; }
.rp-steps .prow.on { opacity: 1; color: var(--ink); font-weight: 650; }

/* The UA sheet's [hidden] { display: none } is beaten by .chip's own display,
   so a chip carrying the attribute stayed on screen -- which is how a Protect
   button nobody could press went on being shown to living factions after it was
   marked hidden. Any rule that sets display on a class must restate this. */
.chip[hidden] { display: none; }

/* Movement arrows. The head is a CSS triangle rotated to the bearing, so it
   needs no asset and scales with the text size rather than the map. Its colour
   is set inline from the client, which is where the two hexes live -- red into
   someone else's ground, green into your own -- so the meaning is declared once
   rather than restated here and left to drift. */
.arrow { pointer-events: auto; cursor: pointer; }
.arrow-head {
  display: block;
  width: 0; height: 0;
  margin: -5px 0 0 -5px;
  border-left: 9px solid currentColor;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  filter: drop-shadow(0 1px 2px rgba(6, 14, 20, 0.75));
}

/* The dark casing under each arc, offset downward. This is the whole of what
   makes an arrow read as ABOVE the board rather than painted onto it -- the
   coloured line on top stays crisp because the shadow is not on it. */
.arrow-cast { filter: drop-shadow(0 2px 2px rgba(6, 14, 20, 0.55)); }

/* The attack panel. At the FOOT of the map, not over its middle: the decision
   is made against the board, so the board stays visible while it is open. */
.stage { position: relative; }
.atk {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 1000;
  min-width: 300px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(4, 10, 16, 0.5);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.atk[hidden] { display: none; }

.atk-route { display: flex; align-items: baseline; justify-content: center; gap: 10px; }
.atk-side { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.atk-side b { font-size: 13px; }
.atk-arrow { color: var(--accent); font-size: 15px; }

.atk-pick { display: flex; align-items: center; gap: 8px; }
.atk-track { position: relative; flex: 1; display: flex; }
.atk-pick input[type="range"] { width: 100%; accent-color: var(--accent); }

/* The capture threshold: a notch on the track with the number under it, like a
   surveyor's mark. Positioned by left%, computed from the slider's own range. */
.atk-need {
  position: absolute;
  top: 100%;
  transform: translateX(-50%);
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.atk-need i {
  display: block;
  width: 2px; height: 5px;
  background: var(--accent);
}
.atk-need b {
  font: 700 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--accent);
}

.atk-verdict { margin: 2px 0 0; text-align: center; }
.atk-verdict.takes { color: var(--accent); }
/* The conditional consequence, one step quieter than the verdict: it is always
   a "if they also did X", never a prediction, because whether they did is the
   one thing the projection may not contain. */
.atk-caveat { margin: 4px 0 0; text-align: center; font-size: 11px; opacity: .75; }
.atk-caveat:empty { display: none; }
.atk-pick output {
  min-width: 26px;
  text-align: right;
  font: 700 14px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}

.atk-pick { padding-bottom: 12px; }
.atk-actions { display: flex; justify-content: flex-end; gap: 6px; }
.chip.ok { border-color: var(--accent); color: var(--accent); font-weight: 650; }
.chip.ok:hover, .chip.ok:focus-visible { background: var(--accent); color: var(--ground); }

/* The viewer's own name, as a control. It reads as text until hovered --
   a button-looking element beside the day would compete with the real ones. */
.rename { background: none; border: 0; padding: 0; font: inherit; color: inherit;
  cursor: pointer; border-bottom: 1px dashed var(--rule); }
.rename:hover, .rename:focus-visible { color: var(--accent); border-bottom-color: var(--accent); }
.rename[hidden] { display: none; }
.renamer { display: flex; gap: 4px; align-items: center; margin: 2px 0 6px; flex-wrap: wrap; }
.renamer[hidden] { display: none; }
.renamer input { flex: 1; min-width: 9ch; font: inherit; font-size: 13px; padding: 3px 6px;
  color: var(--ink); background: var(--surface);
  border: 1px solid var(--rule); border-radius: 4px; }
.renamer input:focus-visible { outline: none; border-color: var(--accent); }

.hint { color: var(--muted); font-size: 12px; margin: 0 0 4px; }
.hint code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }

/* --- player board ------------------------------------------------------- */
#map { width: 100%; height: 100%; background: var(--sea); }

/*
 * Clicking a territory focuses its <path>, and the browser draws a focus ring
 * around the element's BOUNDING BOX -- a rectangle the full width and height of
 * the shape, which over a map reads as a selection bug rather than a highlight.
 * Norway's box covers half of Scandinavia.
 *
 * Removed for pointer input only. Keyboard users get it back through
 * :focus-visible, where the ring is the sole indication of where they are, and
 * a rectangle is worth more than nothing. The mouse already has the stroke
 * highlight, which follows the real border.
 */
/*
 * Garrison counts and region badges. Both sit over the map, and NEITHER may
 * take a pointer event -- a label that swallows the tap meant for the territory
 * beneath it is worse than no label.
 *
 * Readability comes from a paint-order stroke rather than a text-shadow halo:
 * the number lands on ten different faction colours plus the grey backdrop, and
 * a shadow tuned for one of them fails on the others.
 */
.gcount { pointer-events: none; }
.gcount.hide { display: none; }

/* The badge IS interactive -- hovering it lights its region. Safe because a
   badge sits outside its region's bounding box, so it covers no territory
   whose tap it could steal. */
.rbadge { pointer-events: none; }
/* The inner span carries the hit area, so it is exactly the badge's ink --
   the outer element is positioned by a transform and would otherwise present
   a box larger than what is drawn. */
.rb-in {
  display: flex;
  align-items: center;
  gap: 5px;
  pointer-events: auto;
  cursor: default;
}

/* The sole holder's crown. Sized to the chip's cap height and never taking a
   pointer event of its own. */
.rb-crown { width: 15px; height: 12px; flex: none; pointer-events: none; }
.rb-in:hover .rb-n { border-color: #ffd479; }
.rb-in:hover .rb-name { color: #ffd479; }

.gcount {
  display: grid;
  place-items: center;
  font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #fff;
  paint-order: stroke fill;
  -webkit-text-stroke: 3px rgba(6, 14, 20, 0.85);
  font-variant-numeric: tabular-nums;
}

/* Your own territories read a shade brighter, so your line is findable. */
.gcount.own { color: #fff; -webkit-text-stroke: 3px rgba(0, 0, 0, 0.9); font-size: 13px; }

/* A number the viewer's own plan has changed. Gold, the same voice as the
   capture notch: gold on this map is "tonight, if your orders happen", never
   settled fact. The movement arrows speak it too, but in red and green, because
   they carry a second thing to say -- whose ground the soldiers are walking
   onto -- and gold cannot say it. */
.gcount.planned { color: #ffd479; }

.rbadge {
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  width: max-content;
}

/*
 * The badge is anchored ON the region's bounding box and then pushed clear of
 * it from here, in PIXELS -- a degree offset would grow as you zoom in until
 * the badge floated away from what it names.
 *
 * Which side was chosen in the client, by whichever way the region sits
 * relative to the board's middle, so labels radiate outward and rim regions
 * put theirs in open water.
 */
.rbadge.side-n { transform: translate(-50%, calc(-100% - 6px)); }
.rbadge.side-s { transform: translate(-50%, 6px); }
.rbadge.side-e { transform: translate(6px, -50%); }
.rbadge.side-w { transform: translate(calc(-100% - 6px), -50%); }

.rb-n {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 18px;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(11, 26, 36, 0.9);
  border: 1px solid rgba(232, 197, 106, 0.75);
  color: #f2e2b8;
  font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}

/*
 * The region's NAME is hidden until its badge is hovered.
 *
 * Twelve names across a board is more type than map, and the number is the
 * part being compared -- what a region pays is the decision, its name is only
 * how you refer to it afterwards. Revealing on hover puts the label exactly
 * where attention already is, and the badge is the hover target for lighting
 * the region anyway, so one gesture does both.
 */
.rb-name { display: none; }
.rb-in:hover .rb-name { display: inline; }

.rb-name {
  font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(242, 226, 184, 0.85);
  paint-order: stroke fill;
  -webkit-text-stroke: 3px rgba(6, 14, 20, 0.8);
}

/* ---- standings ---------------------------------------------------------- */

.players { margin: 4px 0 2px; }

.players > summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  list-style: none;
  padding: 2px 0;
}
.players > summary::-webkit-details-marker { display: none; }

/* A disclosure caret drawn from a border, so it needs no font or asset and
   rotates with the open state. */
.players > summary .h2::before {
  content: "";
  display: inline-block;
  width: 0; height: 0;
  margin-right: 7px;
  vertical-align: middle;
  border-left: 5px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform 120ms ease;
}
.players[open] > summary .h2::before { transform: rotate(90deg); }
.players > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.standings th {
  font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  text-align: left;
  padding-bottom: 4px;
}
.standings th.n { text-align: right; }

/* The swatch is the ONLY link between a rail row and a colour on the map, so
   it has to survive a small screen -- hence a fixed square rather than a
   coloured row that a background would wash out. */
.standings .swatch i {
  display: inline-block;
  width: 9px; height: 9px;
  margin-right: 7px;
  border-radius: 2px;
  vertical-align: baseline;
  border: 1px solid rgba(0, 0, 0, 0.35);
}

.standings .you { color: var(--ink); font-weight: 600; }

/* Hovering a row lights that faction's territories on the map, so the row
   needs to look reachable and to echo the highlight colour used out there. */
.standings tbody tr { cursor: pointer; }
.standings tbody tr:hover,
.standings tbody tr:focus-visible,
.standings tbody tr.lit {
  outline: none;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.standings tbody tr:hover td:first-child,
.standings tbody tr.lit td:first-child { color: var(--accent); }
.standings .tag {
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
}
.standings .inc { color: var(--accent); white-space: nowrap; }
.standings .rb {
  display: block;
  font-size: 9px;
  color: var(--muted);
  font-weight: 400;
}

.leaflet-interactive:focus { outline: none; }
.leaflet-interactive:focus-visible {
  /* An SVG outline is always the element's bounding BOX, so it cannot be made
     to follow a coastline. Suppress it and highlight the shape itself, which
     is what a mouse user already sees on selection. */
  outline: none;
  stroke: var(--accent);
  stroke-width: 3.5;
}
.leaflet-container { background: var(--sea); font: inherit; }
.leaflet-tooltip {
  background: var(--surface); color: var(--ink); border: 1px solid var(--rule);
  box-shadow: none; font-size: 12px;
}
.leaflet-tooltip::before { display: none; }

.count { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px; color: var(--accent); margin: 6px 0 0; }
.count.locked { color: var(--ink); font-weight: 650; }

.prow { display: flex; align-items: baseline; gap: 8px; font-size: 13px;
  padding: 4px 0; border-bottom: 1px solid var(--rule); }
.prow span { flex: 1; }
.prow button { background: none; border: 0; color: var(--muted); cursor: pointer;
  font-size: 15px; line-height: 1; padding: 0 2px; }
.prow button:hover, .prow button:focus-visible { color: var(--accent); }

/* The elimination notice. Accent-bordered rather than red: being knocked out
   opens the veto, so it is news, not an error. */
.hint.out { border-left: 2px solid var(--accent); padding: 8px 0 8px 10px;
  margin: 4px 0 0; color: var(--ink); }
.hint.out strong { font-weight: 650; }
.hint.out em { font-style: normal; color: var(--accent); }

.save { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em;
  font-weight: 650; margin-left: 6px; }
.save.ok { color: var(--muted); }
.save.bad { color: #e5534b; }
.n.over { color: #e5534b; font-weight: 650; }

button.chip { cursor: pointer; background: none; font: inherit; font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
button.chip:disabled { opacity: .4; cursor: default; }
button.chip:not(:disabled):hover { border-color: var(--accent); color: var(--accent); }

/* A page of prose, not a rail. The rail's .note is 12px muted -- correct for a
   footnote beside a map, unreadable for a screen of text -- so /rules gets a
   document measure and body-sized type instead of reusing it. */
.doc { max-width: 64ch; margin: 0 auto; padding: 32px 24px 64px; }
.doc h1 { font-size: 22px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }
.doc .lede { color: var(--muted); margin: 6px 0 0; }
.doc h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em;
  font-weight: 650; color: var(--muted); margin: 34px 0 10px;
  padding-top: 14px; border-top: 1px solid var(--rule); }
.doc p { margin: 0 0 12px; }
.doc ul { margin: 0 0 12px; padding-left: 20px; }
.doc li { margin: 0 0 7px; }
.doc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px; color: var(--accent); }
.doc strong { font-weight: 650; }
.doc a { color: var(--accent); }
.doc .back { display: inline-block; margin-top: 28px; font-size: 13px; }

/* --- landing ------------------------------------------------------------
 *
 * Wider than /rules: the prose wants a document measure but the board wants
 * room, so the column is set for the picture and the text blocks are held to a
 * measure inside it. One column at every width -- a landing page read on a
 * phone in the Slack thread that sent it is the common case, not the fallback.
 */
.land { max-width: 76ch; margin: 0 auto; padding: 56px 24px 80px; }
.land-hero { max-width: 52ch; }
.land-title { font-size: 38px; font-weight: 650; margin: 0; letter-spacing: -0.02em; }
.land-hook { font-size: 18px; line-height: 1.5; margin: 14px 0 0; }
.land-hook-2 { margin: 10px 0 0; color: var(--accent); font-weight: 650; }
.land-s { margin-top: 52px; padding-top: 22px; border-top: 1px solid var(--rule); }
.land-s h2 { font-size: 19px; font-weight: 650; margin: 0 0 10px; letter-spacing: -0.01em; }
.land-s p { margin: 0 0 12px; max-width: 62ch; }
.land-lede { color: var(--muted); }
.land-note { font-size: 13px; color: var(--muted); }
.land-s strong, .land-s b { font-weight: 650; }
.land-s code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px; color: var(--accent); }
.land a { color: var(--accent); }
.land-ul { margin: 0 0 12px; padding-left: 20px; max-width: 62ch; }
.land-ul li { margin: 0 0 8px; }
.land-out { margin-top: 24px; font-size: 13px; }

/* The screenshot frame. A border and a lifted ground, so the rendered board
   and the mocked panels read as things pulled out of the app rather than as
   more page. */
.shot { margin: 28px 0 0; }
.shot-narrow { max-width: 44ch; }
.shot-frame { background: var(--sea); border: 1px solid var(--rule); border-radius: 10px;
  overflow: hidden; box-shadow: 0 1px 2px rgba(6, 14, 20, .06), 0 8px 24px rgba(6, 14, 20, .08); }
.shot-cap { font-size: 12.5px; color: var(--muted); margin: 9px 0 0; max-width: 58ch; }
.shot-slack, .shot-panel { background: var(--surface); padding: 14px; }

/* The demo board. Territory fills carry the faction colours, which are the
   season palette and therefore not theme-aware -- so the hairline between them
   is a translucent ink rather than a token, and works on either ground. */
.dm { display: block; width: 100%; height: auto; }
.dm-t { stroke: rgba(6, 14, 20, .55); stroke-width: .8; stroke-linejoin: round; }
/* Ground nobody was dealt. Inert, and far enough back that it never competes
   with a faction colour for attention. */
.dm-off { fill: var(--edge); opacity: .34; }
/* Sized in the SVG's user units, which the viewBox scales down by roughly a
   third at the width the frame actually gets -- so 20 here reads as ~13. */
.dm-n { font: 700 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  fill: #fff; text-anchor: middle; dominant-baseline: central;
  paint-order: stroke fill; stroke: rgba(6, 14, 20, .8); stroke-width: 4.5px;
  font-variant-numeric: tabular-nums; pointer-events: none; }
.dm-pin circle { fill: #ffd479; stroke: rgba(6, 14, 20, .85); stroke-width: 2.5; }
.dm-pin text { font: 700 19px/1 ui-sans-serif, system-ui, sans-serif; fill: #14232b;
  text-anchor: middle; dominant-baseline: central; }

/* The callouts under the board. Numbered to match the pins on it. */
.pins { list-style: none; margin: 18px 0 0; padding: 0; max-width: 62ch; }
.pins li { display: flex; gap: 10px; align-items: baseline; margin: 0 0 11px;
  font-size: 14px; }
.pin-n { flex: none; width: 21px; height: 21px; border-radius: 50%;
  background: #ffd479; color: #14232b; font: 700 12px/21px ui-sans-serif, system-ui, sans-serif;
  text-align: center; }

/* A Slack message. Close enough to be recognisable, not a forgery -- no Slack
   marks, no real avatars, and the copy says it is an example. */
.sk { display: flex; gap: 9px; }
.sk-av { flex: none; width: 34px; height: 34px; border-radius: 7px; background: var(--accent);
  color: var(--ground); font: 650 15px/34px ui-sans-serif, system-ui, sans-serif;
  text-align: center; }
.sk-msg { min-width: 0; }
.sk-who { font-weight: 650; font-size: 13.5px; margin: 0 0 3px; }
.sk-b { margin: 0 0 5px; font-size: 13.5px; line-height: 1.5; }
/* Stands in for the photo. A bare gradient box read as an image that failed to
   load, which on a page arguing the mechanic is real is the wrong impression --
   so it carries a photo glyph and says what it is. */
.sk-img { height: 86px; border-radius: 6px; margin: 7px 0 2px; display: grid;
  place-items: center; gap: 4px; color: var(--muted); font-size: 11px;
  background: linear-gradient(135deg, var(--sea), var(--rule)); }
.sk-img svg { width: 26px; height: 26px; opacity: .55; }

/* Emoji sit tight against the word after them at these sizes. */
.em { margin-right: 6px; }
.sk-rx { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.sk-r { font-size: 12px; border: 1px solid var(--rule); border-radius: 10px;
  padding: 1px 7px; color: var(--muted); }
.sk-r.on { border-color: var(--accent); color: var(--accent); }
.sk-r b { font-weight: 650; }

/* The wagers sheet, mocked. Reuses none of the live panel's classes on
   purpose: this is a picture of it, and wiring it to the real ones would mean
   a change to the panel silently reflowed a landing page nobody re-checked. */
.wg-h { display: flex; justify-content: space-between; font-size: 10.5px;
  text-transform: uppercase; letter-spacing: .1em; font-weight: 650;
  color: var(--muted); margin: 0 0 10px; }
.wg-r b { color: var(--ink); }
.wg-m { border-top: 1px solid var(--rule); padding: 9px 0 4px; }
.wg-q { margin: 0 0 4px; font-size: 13.5px; line-height: 1.45; }
.wg-p { margin: 0 0 7px; font-size: 11.5px; color: var(--muted); }
.wg-s { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin: 0;
  font-size: 12px; color: var(--muted); }
.wg-side { font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  border: 1px solid var(--rule); border-radius: 4px; padding: 3px 7px; }
.wg-side.on { background: var(--accent); border-color: var(--accent);
  color: var(--ground); font-weight: 650; }
.wg-stake, .wg-pay { margin-left: 4px; }
.wg-stake b, .wg-pay b { color: var(--ink); font-weight: 650; }

/* The tick, as three beats. A list rather than prose because the whole point
   is that it is the same three every day. */
.beats { list-style: none; margin: 0 0 14px; padding: 0; max-width: 62ch; }
.beats li { display: grid; grid-template-columns: 13ch 1fr; gap: 12px;
  padding: 10px 0; border-top: 1px solid var(--rule); font-size: 14px; }
.beats li b { font-weight: 650; color: var(--accent); }

@media (max-width: 620px) {
  .land { padding: 36px 18px 64px; }
  .land-title { font-size: 27px; }
  .land-hook { font-size: 16px; }
  .beats li { grid-template-columns: 1fr; gap: 2px; }

  /* The board is one render at every width, and the viewBox scales it down by
     roughly two thirds on a phone -- so a count sized for the desktop frame
     arrives at about 6px and the picture loses the thing it is there to show.
     landing.ts tests each territory for room against THESE sizes, not the
     desktop ones, so nothing printed here overflows the country it names. */
  .dm-n { font-size: 32px; stroke-width: 7px; }
  .dm-pin circle { r: 26px; }
  .dm-pin text { font-size: 30px; }
}
`
