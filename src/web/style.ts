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
.leaflet-interactive:focus { outline: none; }
.leaflet-interactive:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
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
`
