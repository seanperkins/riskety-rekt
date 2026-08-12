import type { GameMap } from "../engine/index.js"
import type { LatLon } from "../map/coords.js"
import { edges, focusRegion, project, regionStats } from "./projection.js"
import { CLIENT } from "./client.js"
import { REPLAY } from "./replay.js"
import { STYLE } from "./style.js"
import type { Projection } from "./projection-data.js"
import type { Replay } from "./replay-data.js"

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

/**
 * How the game works. Static prose — no projection, no season, no state, so it
 * needs no session and cannot leak anything.
 *
 * It exists because the rules players get WRONG are the ones no single tap can
 * explain. The attack panel already says "takes it with 4"; nothing could say
 * "and if they attacked you back, the smaller force dies outright" at the
 * moment you need it, because whether they did is the one thing the projection
 * is forbidden to contain.
 *
 * Every number here is the engine's, not the spec's: the income formula is
 * `territoryIncome`, the 2-action cap and both bonuses are `irlGrants`, the
 * mutual-attack rule and the post-departure garrison are `resolveCombat`, the
 * price clamp is `payout`. When one of those changes this page is wrong, and
 * `render.test.ts` pins the load-bearing phrases so a silent drift shows up.
 */
export function renderRules(): string {
  return page(
    "Riskety Rekt — how it works",
    `<div class="doc">
  <h1>How this works</h1>
  <p class="lede">One tick a day. Everything below resolves at the same instant,
    for everybody, with nobody moving first.</p>

  <h2>The tick</h2>
  <p>Orders resolve at <strong>21:00 Eastern</strong>, once a day. Until then nothing
    you save has happened yet — deploys, moves and attacks are a plan, and you can
    change them as often as you like.</p>
  <p>At 21:00 every player's orders resolve <strong>simultaneously</strong>. There is no
    turn order and no advantage to submitting early or late. You cannot see anyone
    else's plan, and they cannot see yours.</p>
  <p>Soldiers you earn tonight are spendable tonight — income arrives before your
    orders are checked, so a deploy funded by today's income is legal.</p>

  <h2>Where soldiers come from</h2>
  <ul>
    <li><strong>Territory income.</strong> <code>max(5, territories / 2)</code> rounded
      down, plus a bonus for every whole region you hold. Anything up to eleven
      territories pays the same 5, so early on <strong>completing a region is worth far
      more than collecting scattered ground</strong> — the count itself does not start
      to matter until twelve.</li>
    <li><strong>Workouts.</strong> Post a photo in Slack. When <strong>two other
      players</strong> react 👍 it counts, and you get +1. Up to two photos a day.
      Only 👍 counts, and your own reaction never does.</li>
    <li><strong>Timing bonuses.</strong> The first person to post that day gets +1.
      The last person to be approved before 21:00 gets +1. One bonus each, so if
      you hold both ends the second goes to the next player.</li>
    <li><strong>Settled wagers.</strong> See below.</li>
  </ul>
  <p>A faction with no territories earns no income.</p>

  <h2>Moving</h2>
  <p>You can move soldiers to an adjacent territory you already own. They
    <strong>arrive before any fighting</strong>, defend the destination that same
    night, and can die doing it. Reinforcement, not logistics.</p>
  <p>Moves and attacks share one budget per territory, and a territory can never be
    emptied — at least one soldier always stays home. If you order more out of one
    place than it can spare, the <strong>move survives and the attack is dropped</strong>:
    losing ground you already hold is worse than failing to take more.</p>

  <h2>Fighting</h2>
  <ul>
    <li>You may attack any adjacent territory you do not own, with up to
      <strong>all but one</strong> of the attacking territory's soldiers.</li>
    <li>A territory defends with the soldiers <strong>still in it</strong>. Anything you
      ordered out has already left, so attacking out of a border territory weakens
      its defence the same night.</li>
    <li>Losses total exactly the defending garrison, shared out across everyone
      attacking that territory. Beat the defence and you take it with whatever
      survives; fall short and you have only thinned the garrison.</li>
    <li><strong>If two players attack each other across the same border, the smaller
      force dies outright</strong> and the larger continues with
      <code>size − 2 × smaller</code>. A small attack into a big one is not a cheap
      spoiler — it is a total loss, and it still costs the attacker double.</li>
    <li>Attacks from several of your own territories onto one target fight as a single
      force. Survivors of a failed attack withdraw to where they came from.</li>
  </ul>

  <h2>Wagers</h2>
  <ul>
    <li><strong>One wager per market</strong>, per player. Backing both sides of the
      same market would be a guaranteed profit, so it is not allowed.</li>
    <li>A wager is priced <strong>when you place it</strong>, not at the tick. Changing
      your stake re-prices it at the current odds.</li>
    <li>Each market <strong>locks at its own close time</strong>, not at 21:00 — often
      hours earlier, and sooner still if it settles early.</li>
    <li>Your stake leaves your reserve at the tick. Winning pays it back with a
      premium; losing returns nothing.</li>
  </ul>

  <h2>The daily rule</h2>
  <p>Every morning the bot offers three rules from the catalogue in Slack. React with
    the numeral next to the one you want. You can change your mind — your latest
    reaction is the one that counts — and the most-voted rule is applied at 21:00
    for that night only. If nobody votes, nothing changes.</p>

  <h2>Being knocked out</h2>
  <p>A player with no territories left can shield one territory a day from attack —
    anyone's — but only if they posted a workout that day. Showing up is the price
    of a say in how it ends.</p>

  <p class="note">If the game does something you did not expect, it is probably on this
    page — and if it is not, it is a bug worth reporting.</p>
  <a class="back" href="/">← Back to the board</a>
</div>`,
  )
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
/**
 * Send a player to last night's replay if they have not watched it.
 *
 * Runs BEFORE the board's markup, so an unwatched night replaces the page
 * rather than flashing it. `location.replace`, not `href`: the board must not
 * become a back-button trap behind the replay.
 *
 * The seen-marker lives in localStorage, so the SERVER cannot know and cannot
 * do this with a 302 — watching on a phone and then opening a laptop offers the
 * replay again, which is the accepted cost of not storing it.
 *
 * Two things stop a redirect loop. A failure to read localStorage throws into
 * the catch and simply does not redirect, so a private window still reaches the
 * board. And the replay returns with `?from=replay`, which is honoured even if
 * WRITING the marker silently failed — without it a full quota would bounce a
 * player between the two pages forever.
 */
function unseenReplayRedirect(p: Projection): string {
  if (p.resolvedDay < 1) return ""
  return `<script>(function(){try{
  if (location.search.indexOf("from=replay") !== -1) return
  var k = "rr.seen." + ${JSON.stringify(p.seasonId)}
  if (Number(localStorage.getItem(k) || 0) < ${p.resolvedDay}) {
    location.replace("/day/${p.resolvedDay}")
  }
}catch(e){}})()</script>`
}

/**
 * The notice an eliminated player sees, and nobody else.
 *
 * Without it the Protect button is simply disabled for everyone still playing
 * and simply enabled for someone with nothing left, with no explanation of
 * either — and the veto is the one order that only becomes available by losing,
 * so there is no earlier moment at which anyone would have learned it exists.
 *
 * It states the posting condition rather than evaluating it: whether you posted
 * today lives in Slack, and putting it in the projection would mean shipping a
 * fact about a player to the browser for no gain. Naming the rule is enough.
 */
/**
 * Who may cast an elimination veto, from the projection alone.
 *
 * One source for the notice and the button, so they can never disagree about
 * whether the veto is available — which is the state that produced a Protect
 * button living factions could press and the engine then refused.
 */
function vetoState(p: Projection): { out: boolean; canVeto: boolean } {
  const out = !Object.values(p.ownership).includes(p.factionId)
  return { out, canVeto: out && p.modules.includes("veto") }
}

function outOfIt(p: Projection): string {
  const { out, canVeto } = vetoState(p)
  if (!out) return ""
  if (!canVeto) {
    return `<p class="hint out">You are out — and the veto is off this season, so there is
      nothing left to do but watch.</p>`
  }
  // "Protect" throughout, matching the button and the plan row. An earlier draft
  // called it a shield, which read better and named nothing on screen.
  return `<p class="hint out"><strong>You are out.</strong> You still get one Protect a day:
    tap <em>any</em> territory, anyone's, and no attack can enter it tonight. It only counts
    if you posted a workout today — showing up is the price of a say in how this ends.</p>`
}

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
      return `<tr class="${you ? "you" : ""}" data-faction="${esc(f.id)}">
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
      <p class="note">From the board only — territories and whole regions.${
        p.modules.includes("irl") && p.modules.includes("markets")
          ? " Approved workouts and settled wagers arrive at the tick."
          : p.modules.includes("irl")
            ? " Approved workouts arrive at the tick."
            : p.modules.includes("markets")
              ? " Settled wagers arrive at the tick."
              : ""
      }</p>
    </details>`
}

export function renderBoard(p: Projection): string {
  const me = p.factions.find((f) => f.id === p.factionId)
  return page(
    `Riskety Rekt — day ${p.day}`,
    `${unseenReplayRedirect(p)}<link rel="stylesheet" href="/vendor/leaflet.css">
<div class="wrap">
  <div class="stage"><div id="map"></div>
    <div id="atk" class="atk" hidden>
      <div class="atk-route">
        <span class="atk-side"><b id="atk-from"></b><span class="hint" id="atk-from-g"></span></span>
        <span class="atk-arrow">→</span>
        <span class="atk-side"><b id="atk-to"></b><span class="hint" id="atk-to-g"></span></span>
      </div>
      <div class="atk-pick">
        <span class="atk-track">
          <input id="atk-slider" type="range" min="0" value="1" step="1">
          <span id="atk-need" class="atk-need" hidden><i></i><b></b></span>
        </span>
        <output id="atk-n" for="atk-slider">1</output>
        <span class="hint">soldiers</span>
      </div>
      <p id="atk-verdict" class="hint atk-verdict"></p>
      <p id="atk-caveat" class="hint atk-caveat"></p>
      <div class="atk-actions">
        <button id="atk-select" class="chip" hidden>Select instead</button>
        <button id="atk-cancel" class="chip">Cancel</button>
        <button id="atk-ok" class="chip ok">Okay</button>
      </div>
    </div>
  </div>
  <aside class="rail">
    <h1 class="title">Riskety&nbsp;Rekt</h1>
    <p class="sub">Day ${esc(p.day)} · ${esc(me?.name ?? p.factionId)}</p>
    <p id="countdown" class="count"></p>

    ${outOfIt(p)}
    <h2 class="h2">Selected</h2>
    <p class="hint"><span id="selected">nothing selected</span></p>
    <div class="chips">
      <!-- Present but hidden rather than omitted: the client sets .disabled on
           it unconditionally, and a missing element would throw there. It can
           never become pressable for a living faction, so showing it greyed out
           all season is an affordance that leads nowhere. -->
      <button id="btn-protect" class="chip"${vetoState(p).canVeto ? "" : " hidden"}>Protect</button>
      <button id="btn-undo" class="chip">Undo</button>
    </div>
    <p class="hint" id="flash"></p>

    <h2 class="h2">Your orders <span id="save" class="save ok">saved</span></h2>
    <div id="plan"></div>

    <h2 class="h2">Reserve</h2>
    <table class="t"><tbody>
      <tr><td>unspent</td><td class="n" id="reserve">${esc(p.reserve)}</td></tr>
    </tbody></table>

    ${standings(p)}

    <p class="note">Tap one of your territories to select it, then tap a neighbour —
      an enemy to attack it, one of yours to reinforce it. Orders save as you make
      them and lock at 21:00, when <strong>everyone resolves at once</strong>; nobody
      moves first.
      ${p.modules.includes("markets") ? `<a href="/wagers">Wagers</a> · ` : ""}<a href="/day/${esc(p.day)}">Last night</a> · <a href="/rules">How this works</a></p>
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
  // Reachable only for a markets-on season — the route 404s otherwise — so
  // the absent-field case is a server bug, not a render case.
  const staked = new Map((p.wagers ?? []).map((w) => [w.marketId, w]))
  const rows = (p.slate ?? [])
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
        outcome is public — whichever comes first. That is usually well before
        21:00, so a wager is not something you can leave until the evening.
        <a href="/">Board</a> · <a href="/rules">How this works</a></p>
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
/**
 * The night, animated on the board.
 *
 * Replaces a static list of sentences. The list is still here — it is the
 * transcript beside the map, and the playing step is highlighted in it — but
 * the map is the point: "f2 attacks Tibet from Yunnan with 6" is a sentence you
 * have to decode, and a soldier crossing a border is not.
 *
 * No session. A resolved night is public: the recap posts all of it to Slack,
 * so there is nothing here to keep from anyone, and the page therefore carries
 * no `Projection` and no viewer.
 */
export function renderReplay(r: Replay): string {
  return page(
    `Riskety Rekt — day ${r.day}`,
    `<link rel="stylesheet" href="/vendor/leaflet.css">
<div class="wrap">
  <div class="stage"><div id="map"></div></div>
  <aside class="rail">
    <h1 class="title">Day ${esc(r.day)}</h1>
    <p class="sub">Last night, as it happened</p>

    <div class="chips rp-controls">
      <button id="btn-play" class="chip">Play</button>
      <button id="btn-step" class="chip">Step</button>
      <button id="spd-1" class="chip on">1×</button>
      <button id="spd-2" class="chip">2×</button>
      <button id="spd-4" class="chip">4×</button>
    </div>
    <p class="hint" id="progress"></p>

    <!-- The transcript leads. It is the thing being played, and it scrolls
         itself to the current beat, so burying it under a static table put the
         one moving part of the page below the fold. -->
    <h2 class="h2">The night, step by step</h2>
    <ol id="steps" class="rp-steps"></ol>

    <h2 class="h2">Soldiers arriving</h2>
    <table class="t"><tbody id="bank"></tbody></table>

    <p class="note">Every number here is the one the engine recorded.
      <button id="btn-skip" class="chip">Skip to the board →</button></p>
  </aside>
</div>
<script>window.__RRP__ = ${JSON.stringify(r).replace(/</g, "\\u003c")}</script>
<script src="/vendor/leaflet.js"></script>
<script>${REPLAY}</script>`,
  )
}

