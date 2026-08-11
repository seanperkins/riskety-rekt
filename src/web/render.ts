import type { GameMap } from "../engine/index.js"
import type { LatLon } from "../map/coords.js"
import { edges, focusRegion, project, regionStats } from "./projection.js"
import { CLIENT } from "./client.js"
import { STYLE } from "./style.js"
import type { Projection } from "./projection-data.js"

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

function subtitle(
  board: { factions: number; seed: number } | undefined,
  focusName: string | undefined,
  query: (over: Record<string, string | undefined>) => string,
): string {
  const where =
    focusName === undefined
      ? ""
      : ` Showing ${esc(focusName)} and everything bordering it — <a href="${esc(query({ region: undefined }))}">all of it</a>.`
  if (board === undefined) {
    return `World data. Pick a region to check its borders.${where}`
  }
  return `The board a ${board.factions}-faction season would be dealt on.${where}`
}

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
export interface MapView {
  /** The board to draw. The whole world, or a selected sub-map. */
  base: GameMap
  /** Narrow to one region and its neighbours. */
  focusId?: string
  /** Set when `base` is a dealt board rather than the world. */
  board?: { factions: number; seed: number }
}

export function renderMap(view: MapView, coords: Record<string, LatLon>): string {
  const world = view.base
  const focusId = view.focusId
  const board = view.board
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

  const totalRows: [string, string][] = [
    ["territories", String(world.territories.length)],
    ["regions", String(world.regions.length)],
    ["borders", String(edges(world).length)],
    ["mean degree", degree.toFixed(2)],
  ]
  if (board !== undefined) {
    const per = world.territories.length / board.factions
    totalRows.push(["per faction", per.toFixed(1)])
  }
  const totals = totalRows
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`)
    .join("")

  // Board controls. Plain links rather than a form: there is no client
  // JavaScript on this page and a GET link is the whole interaction.
  const query = (over: Record<string, string | undefined>): string => {
    const q = new URLSearchParams()
    if (board !== undefined) {
      q.set("factions", String(board.factions))
      q.set("seed", String(board.seed))
    }
    if (focusId !== undefined) q.set("region", focusId)
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) q.delete(k)
      else q.set(k, v)
    }
    const str = q.toString()
    return str === "" ? "/map" : `/map?${str}`
  }

  const rosterLinks = Array.from({ length: 12 }, (_, i) => i + 4)
    .map((n) => {
      const on = board?.factions === n
      return `<a class="chip${on ? " on" : ""}" href="${esc(query({ factions: String(n), region: undefined }))}">${n}</a>`
    })
    .join("")

  const boardPanel =
    board === undefined
      ? `<h2 class="h2">Deal a board</h2>
    <p class="hint">Pick a roster size to see the board a season of that size would be dealt.</p>
    <div class="chips">${rosterLinks}</div>`
      : `<h2 class="h2">Board</h2>
    <div class="chips">${rosterLinks}</div>
    <p class="hint">Seed <code>${esc(board.seed)}</code> ·
      <a href="${esc(query({ seed: String(board.seed + 1), region: undefined }))}">re-roll</a> ·
      <a href="${esc(query({ factions: undefined, seed: undefined, region: undefined }))}">whole world</a></p>`

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
    <p class="sub">${subtitle(board, focusName, query)}</p>
    <h2 class="h2">Regions</h2>
    <table class="t"><tbody>${regions}</tbody></table>
    ${boardPanel}
    <h2 class="h2">Totals</h2>
    <table class="t"><tbody>${totals}</tbody></table>
    <p class="note">Every line is a border in <code>src/map/world.ts</code>. A line that jumps
      across the map is a bug in the data — that is what this page is for.</p>
  </aside>
</div>`,
  )
}

/**
 * The player board.
 *
 * The projection is serialised into the page as JSON. **Only the viewer's own
 * plan is in it** — no other faction's deploys, attacks or protect pick is
 * present, not hidden with CSS but absent from the bytes. A test asserts it.
 */
/**
 * The standings, with what each faction earns from the board tonight.
 *
 * Every number here is derived from `ownership` and the per-board region
 * bonuses, both of which are already public — `territoryIncome` is
 * `max(5, floor(territories / 2)) + regionBonuses` and reads nothing else. So
 * this leaks nothing, and it replaces the counting-territories-by-eye that the
 * map otherwise demands.
 *
 * It deliberately EXCLUDES the two income sources that are not board state:
 * approved workouts, which land at the tick, and wager payouts, which are
 * secret per faction. Showing a total that included either would be a number
 * the viewer cannot verify and, for wagers, a leak.
 */
function standings(p: Projection): string {
  const held = new Map<string, number>()
  for (const f of p.factions) held.set(f.id, 0)
  for (const owner of Object.values(p.ownership)) {
    held.set(owner, (held.get(owner) ?? 0) + 1)
  }

  // Region bonus only when a faction holds EVERY territory in the region —
  // the same rule regionBonusesFor applies.
  const members = new Map<string, string[]>()
  for (const t of p.territories) {
    members.set(t.region, [...(members.get(t.region) ?? []), t.id])
  }
  const bonus = new Map<string, number>()
  for (const r of p.regions) {
    const ids = members.get(r.id) ?? []
    if (ids.length === 0) continue
    const owners = new Set(ids.map((id) => p.ownership[id]))
    if (owners.size !== 1) continue
    const sole = [...owners][0]!
    bonus.set(sole, (bonus.get(sole) ?? 0) + r.bonus)
  }

  const rows = [...p.factions]
    .map((f) => {
      const count = held.get(f.id) ?? 0
      const regions = bonus.get(f.id) ?? 0
      // Eliminated factions earn nothing: the floor would otherwise pay a
      // faction with no territories forever.
      const income = count === 0 ? 0 : Math.max(5, Math.floor(count / 2)) + regions
      return { f, count, regions, income }
    })
    .sort((a, b) => b.count - a.count || (a.f.id < b.f.id ? -1 : 1))
    .map(({ f, count, regions, income }) => {
      const you = f.id === p.factionId
      return `<tr class="${you ? "you" : ""}">
        <td class="swatch"><i style="background:${esc(f.color)}"></i>${esc(f.name)}${
          you ? ' <span class="tag">you</span>' : ""
        }</td>
        <td class="n">${esc(count)}</td>
        <td class="n inc">+${esc(income)}${regions > 0 ? `<span class="rb">incl +${esc(regions)}</span>` : ""}</td>
      </tr>`
    })
    .join("")

  return `<details class="players" open>
      <summary><span class="h2">Players</span><span class="hint">soldiers tonight</span></summary>
      <table class="t standings"><thead>
        <tr><th>faction</th><th class="n">terr</th><th class="n">income</th></tr>
      </thead><tbody>${rows}</tbody></table>
      <p class="note">From the board only — territories and whole regions.
        Approved workouts and settled wagers arrive at the tick.</p>
    </details>`
}

export function renderBoard(p: Projection): string {
  const me = p.factions.find((f) => f.id === p.factionId)
  return page(
    `Riskety Rekt — day ${p.day}`,
    `<link rel="stylesheet" href="/vendor/leaflet.css">
<div class="wrap">
  <div class="stage"><div id="map"></div></div>
  <aside class="rail">
    <h1 class="title">Riskety&nbsp;Rekt</h1>
    <p class="sub">Day ${esc(p.day)} · ${esc(me?.name ?? p.factionId)}</p>
    <p id="countdown" class="count"></p>

    <h2 class="h2">Selected</h2>
    <p class="hint"><span id="selected">nothing selected</span></p>
    <div class="chips">
      <button id="btn-deploy" class="chip">Deploy</button>
      <button id="btn-protect" class="chip">Protect</button>
    </div>
    <p class="hint" id="flash"></p>

    ${standings(p)}

    <h2 class="h2">Your orders <span id="save" class="save ok">saved</span></h2>
    <div id="plan"></div>

    <h2 class="h2">Reserve</h2>
    <table class="t"><tbody>
      <tr><td>unspent</td><td class="n" id="reserve">${esc(p.reserve)}</td></tr>
    </tbody></table>

    <p class="note">Tap one of your territories to select it, then tap a
      neighbour to attack. Orders save as you make them and lock at 21:00.
      <a href="/wagers">Wagers</a> · <a href="/day/${esc(p.day)}">Last night</a></p>
  </aside>
</div>
<script>window.__RR__ = ${JSON.stringify(p).replace(/</g, "\\u003c")}</script>
<script src="/vendor/leaflet.js"></script>
<script>${CLIENT}</script>`,
  )
}

/**
 * Today's slate.
 *
 * A market locks at `min(closeTime, settlement observed_at)` — `can_close_early`
 * means an outcome can be public hours before the stated close. A locked market
 * renders locked, with the reason, rather than taking a stake the server will
 * refuse.
 */
export function renderWagers(p: Projection, now: Date): string {
  const staked = new Map(p.wagers.map((w) => [w.marketId, w]))
  const rows = p.slate
    .map((m) => {
      const mine = staked.get(m.id)
      const closed = new Date(m.closeTime).getTime() <= now.getTime()
      const state = closed
        ? `<span class="save bad">closed</span>`
        : `<span class="n">${esc(new Date(m.closeTime).toUTCString().slice(17, 22))} UTC</span>`
      return `<tr><td>${esc(m.question)}<br>
        <span class="hint">yes ${esc(m.priceYes)} · no ${esc(m.priceNo)}${
          mine === undefined ? "" : ` · <b>you: ${esc(mine.stake)} on ${esc(mine.side)}</b>`
        }</span></td><td class="n">${state}</td></tr>`
    })
    .join("")

  return page(
    "Riskety Rekt — wagers",
    `<div class="wrap"><div class="stage" style="display:grid;place-items:center">
      <p class="hint">Stakes leave your reserve when the tick runs.</p></div>
    <aside class="rail">
      <h1 class="title">Wagers</h1>
      <p class="sub">Day ${esc(p.day)} · one wager per market</p>
      <h2 class="h2">Today's slate</h2>
      <table class="t"><tbody>${
        rows === "" ? `<tr><td class="hint">No slate published yet.</td></tr>` : rows
      }</tbody></table>
      <p class="note">A market locks at its close time, or as soon as its
        outcome is public — whichever comes first.
        <a href="/">Board</a></p>
    </aside></div>`,
  )
}

/**
 * The night replayed.
 *
 * Recomputes NOTHING. The log is animated against two known states — day N-1
 * and day N, both already persisted — because replaying events forward would be
 * a second implementation of the engine's bookkeeping, and it would drift until
 * the picture and the game disagreed.
 *
 * Income, IRL grants and settled wagers collapse into one opening summary:
 * every source of soldiers arriving in the bank, so the game reads as one
 * system rather than two.
 */
export function renderDay(args: {
  day: number
  before: GameStateLike
  after: GameStateLike
  factionName: (id: string) => string
  territoryName: (id: string) => string
}): string {
  const { after, factionName: fname, territoryName: tname } = args

  const bank = new Map<string, string[]>()
  const push = (f: string, s: string) => bank.set(f, [...(bank.get(f) ?? []), s])
  const steps: string[] = []

  for (const e of after.log) {
    switch (e.t) {
      case "income":
        push(e.faction, `+${e.amount} income`)
        break
      case "irl":
        push(e.faction, `+${e.actions + e.bonus} workout`)
        break
      case "wagerSettle":
        if (e.payout > 0) push("—", `+${e.payout} from a market`)
        break
      case "deploy":
        steps.push(`${esc(fname(e.faction))} deploys ${e.count} to ${esc(tname(e.territory))}`)
        break
      case "fieldBattle":
        steps.push(
          `Field battle between ${esc(tname(e.a))} and ${esc(tname(e.b))} — ${e.aContinues} and ${e.bContinues} continue`,
        )
        break
      case "protected":
        steps.push(`${esc(tname(e.territory))} is protected by ${e.byCount}`)
        break
      case "attack":
        steps.push(
          `${esc(fname(e.attacker))} attacks ${esc(tname(e.to))} from ${esc(tname(e.from))} with ${e.committed} — ${
            e.captured ? `<b>captured</b>, ${e.survivors} hold it` : `repulsed`
          }`,
        )
        break
      case "rejected":
        steps.push(`<span class="save bad">rejected</span> ${esc(fname(e.faction))}: ${esc(e.reason)}`)
        break
    }
  }

  const reinforcements = [...bank.entries()]
    .map(([f, parts]) => `<tr><td>${esc(f === "—" ? "markets" : fname(f))}</td><td class="n">${esc(parts.join(", "))}</td></tr>`)
    .join("")

  return page(
    `Riskety Rekt — day ${args.day}`,
    `<div class="wrap"><div class="stage" style="overflow-y:auto;padding:26px">
      <h2 class="h2">The night, step by step</h2>
      <ol id="steps">${steps.map((s) => `<li class="prow"><span>${s}</span></li>`).join("")}</ol>
    </div>
    <aside class="rail">
      <h1 class="title">Day ${esc(args.day)}</h1>
      <p class="sub">${esc(steps.length)} things happened.</p>
      <h2 class="h2">Soldiers arriving</h2>
      <table class="t"><tbody>${
        reinforcements === "" ? `<tr><td class="hint">Nobody earned.</td></tr>` : reinforcements
      }</tbody></table>
      <p class="note">Income, workouts and settled wagers are all the same
        thing: soldiers in the bank. <a href="/">Board</a></p>
    </aside></div>`,
  )
}

interface GameStateLike {
  log: import("../engine/index.js").TickEvent[]
  ownership: Record<string, string>
}
