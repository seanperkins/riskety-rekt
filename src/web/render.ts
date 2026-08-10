import type { GameMap } from "../engine/index.js"
import type { LatLon } from "../map/coords.js"
import { edges, focusRegion, project, regionStats } from "./projection.js"
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
export function renderMap(
  world: GameMap,
  coords: Record<string, LatLon>,
  focusId?: string,
): string {
  // Focused: the region plus everything bordering it, projected to fill the
  // frame. That is what makes a border checkable -- the whole-world view packs
  // Europe into a blob where no edge can be read.
  const focus = focusId === undefined ? undefined : focusRegion(world, focusId)
  const map = focus?.map ?? world
  const inFocus = focus?.inFocus
  const proj = project(map, coords, W, H, PAD)
  const color = new Map(map.regions.map((c, i) => [c.id, hueFor(i)]))
  const byId = new Map(map.territories.map((t) => [t.id, t]))
  const border = edges(map)

  // Sizes scale with how much is on screen. A label sized for 264 territories
  // is unreadable when a focused view shows 14, and one sized for 14 buries the
  // world view. Square-root because the territories spread over an AREA, and
  // clamped so a two-territory view does not fill the frame with two dots.
  const zoom = Math.min(2.8, Math.max(1, Math.sqrt(264 / Math.max(map.territories.length, 1))))
  const labelPx = (6.4 * zoom).toFixed(1)
  const rFocus = (5.5 * zoom).toFixed(1)
  const rDim = (4 * zoom).toFixed(1)
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
      const dim = inFocus !== undefined && !inFocus.has(t.id)
      return (
        `<circle class="terr${dim ? " dim" : ""}" tabindex="0" cx="${p.x.toFixed(1)}"` +
        ` cy="${p.y.toFixed(1)}" r="${dim ? rDim : rFocus}"` +
        ` fill="${esc(color.get(t.region))}">` +
        `<title>${esc(t.name)} — ${esc(t.region)}\nborders (${t.neighbors.length}): ${esc(borders)}</title>` +
        `</circle>` +
        `<text class="label${dim ? " dim" : ""}" font-size="${labelPx}" x="${(p.x + Number(rFocus) + 3).toFixed(1)}" y="${(p.y + 2.6 * zoom).toFixed(1)}">${esc(t.name)}</text>`
      )
    })
    .join("")

  // Always the WORLD's regions, never the focused sub-map's: the rail is how
  // you get from one region to the next, so it must not shrink to the three
  // regions that happen to be on screen.
  const regions = regionStats(world)
    .map((c) => {
      const on = c.id === focusId
      return (
        `<tr${on ? ' class="on"' : ""}><td>` +
        `<span class="sw" style="background:${esc(color.get(c.id))}"></span>` +
        `<a href="/map?region=${encodeURIComponent(c.id)}">${esc(c.name)}</a></td>` +
        `<td class="n">${c.size} · ${c.entries} in</td></tr>`
      )
    })
    .join("")

  const totals = [
    ["territories", String(map.territories.length)],
    ["regions", String(map.regions.length)],
    ["borders", String(border.length)],
    ["mean degree", degree.toFixed(2)],
  ]
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`)
    .join("")

  const focusName = focus === undefined ? undefined : world.regions.find((r) => r.id === focusId)?.name
  const label =
    focusName === undefined
      ? `World map: ${map.territories.length} territories in ${map.regions.length} regions`
      : `${focusName} and its neighbours`

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
    <p class="sub">${
      focusName === undefined
        ? "World data. Pick a region to check its borders."
        : `${esc(focusName)} and everything bordering it. <a href="/map">Whole world</a>.`
    }</p>
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
