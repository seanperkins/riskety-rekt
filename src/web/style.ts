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

@media (max-width: 860px) {
  .wrap {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
  .stage {
    min-height: 70vh;
  }
}

.stage {
  background: var(--sea);
  overflow: hidden;
  min-height: 0;
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

.chip:disabled { opacity: 0.45; cursor: default; }
.chip:disabled:hover { border-color: var(--rule); color: var(--muted); }

/* Attack arrows. The head is a CSS triangle rotated to the bearing, so it needs
   no asset and scales with the text size rather than the map. */
.arrow { pointer-events: auto; cursor: pointer; }
.arrow-head {
  display: block;
  width: 0; height: 0;
  margin: -5px 0 0 -5px;
  border-left: 9px solid #ffd479;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  filter: drop-shadow(0 0 1px rgba(6, 14, 20, 0.9));
}

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
   attack arrows and the capture notch: everything gold on this map is
   "tonight, if your orders happen", never settled fact. */
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
`
