import type { GameMap } from "../engine/index.js"
import type { LatLon } from "../map/coords.js"
import { regionStats, edges, project } from "./projection.js"
import { STYLE } from "./style.js"

/**
 * Every page is a pure function from data to an HTML string.
 *
 * No templating engine, no bundler, no client JavaScript. That is not
 * minimalism for its own sake: `tsx` running TypeScript directly is what keeps
 * `node:sqlite` loadable, since bundlers strip the `node:` prefix and the
 * module exists under no other name. Rendering being pure is what makes these
 * pages testable without starting a server.
 */

/**
 * HTML-escape. Applied to EVERY interpolated value without exception.
 *
 * Territory names are ours today, but market questions are third-party text
 * straight from Kalshi and player display names come from Slack — and the
 * habit of escaping only "the untrusted ones" is how the one that got
 * reclassified slips through.
 */
export function esc(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  )
}

/** The document shell. `body` is already-escaped markup. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>${body}</body>
</html>
`
}

const W = 1160
const H = 900
const PAD = 52

/**
 * Golden-angle hues, so regions adjacent in the list never share a colour,
 * kept at chart saturation so they sit on the ground rather than shout off it.
 */
const hueFor = (i: number): string => `hsl(${Math.round((i * 137.508) % 360)} 46% 56%)`

/**
 * The world map.
 *
 * Plain server-rendered SVG with no client JavaScript: the data is static, hover
 * text is a native `<title>`, and nothing here needs state.
 *
 * Its first job is verification. A bogus border is invisible in a data file and
 * obvious as a line jumping across Sudan, and no test can catch one — "Chad
 * borders Egypt" is symmetric, connected and in-band, which is everything
 * `validateMap` checks.
 */
export function renderMap(map: GameMap, coords: Record<string, LatLon>): string {
  const proj = project(map, coords, W, H, PAD)
  const color = new Map(map.regions.map((c, i) => [c.id, hueFor(i)]))
  const byId = new Map(map.territories.map((t) => [t.id, t]))
  const border = edges(map)
  const degree =
    map.territories.reduce((sum, t) => sum + t.neighbors.length, 0) / map.territories.length

  const lines = border
    .map(([a, b]) => {
      const p = proj.at(a)
      const q = proj.at(b)
      if (p === undefined || q === undefined) return ""
      return `<line class="edge" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}"/>`
    })
    .join("")

  const nodes = map.territories
    .map((t) => {
      const p = proj.at(t.id)
      if (p === undefined) return ""
      const borders = t.neighbors.map((n) => byId.get(n)?.name ?? n).join(", ")
      return (
        `<circle class="terr" tabindex="0" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5"` +
        ` fill="${esc(color.get(t.region))}">` +
        `<title>${esc(t.name)} — ${esc(t.region)}\nborders (${t.neighbors.length}): ${esc(borders)}</title>` +
        `</circle>` +
        `<text class="label" x="${(p.x + 7.5).toFixed(1)}" y="${(p.y + 2.4).toFixed(1)}">${esc(t.name)}</text>`
      )
    })
    .join("")

  const regions = regionStats(map)
    .map(
      (c) =>
        `<tr><td><span class="sw" style="background:${esc(color.get(c.id))}"></span>${esc(c.name)}</td>` +
        `<td class="n">${c.size} · ${c.entries} in</td></tr>`,
    )
    .join("")

  const totals = [
    ["territories", String(map.territories.length)],
    ["regions", String(map.regions.length)],
    ["borders", String(border.length)],
    ["mean degree", degree.toFixed(2)],
  ]
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`)
    .join("")

  const label = `World map: ${map.territories.length} territories in ${map.regions.length} regions`

  return page(
    "Riskety Rekt — world map",
    `<div class="wrap">
  <div class="stage">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(label)}">
      ${lines}${nodes}
    </svg>
  </div>
  <aside class="rail">
    <h1 class="title">Riskety&nbsp;Rekt</h1>
    <p class="sub">World data. Hover a territory for its borders.</p>
    <h2 class="h2">Regions</h2>
    <table class="t"><tbody>${regions}</tbody></table>
    <h2 class="h2">Totals</h2>
    <table class="t"><tbody>${totals}</tbody></table>
    <p class="note">Every line is a border in <code>src/map/world.ts</code>. A line that jumps
      across the map is a bug in the data — that is what this page is for.</p>
  </aside>
</div>`,
  )
}
