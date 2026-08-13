import { MAX_LIVE_TOKENS } from "../auth/token.js"
import { SEASON_LENGTH } from "../config.js"
import { createSeason } from "../engine/index.js"
import type { Faction, FactionId, GameState, TerritoryId } from "../engine/index.js"
import { RULE_CATALOGUE } from "../engine/rules/index.js"
import { clusteredOrder } from "../map/deal.js"
import { selectSubMap } from "../map/select.js"
import { WORLD } from "../map/world.js"
import { COORDS } from "../map/coords.js"
import { LABELS, SHAPES } from "../map/shapes.js"
import { makeRng } from "../rng.js"
import { equalEarth } from "./projection.js"
import { esc, page } from "./render.js"

/**
 * The signed-out page.
 *
 * It used to say nothing about the game on purpose. That was the right call
 * while the only people who could reach it were players who had lost a cookie;
 * it stopped being right once the way anybody joins is a coworker asking to be
 * added. So this page now argues for the game, and the one property worth
 * keeping from the old one is kept and tested: **nothing here comes from a live
 * season**. The board below is dealt at render time from a constant seed and
 * reads no store, so there is no session to leak and nothing to authorise.
 *
 * Pure, like every other page — a function of no arguments, no clock and no
 * randomness beyond a seeded generator. `renderLanding()` returns the same
 * bytes on every call, and a test asserts it.
 */

/**
 * The frame's width in user units, and the tallest it may get.
 *
 * The HEIGHT is computed from the board rather than fixed. A fixed frame
 * letterboxes: the deal decides the outline, and a portrait one — Africa, say —
 * fits its height and leaves both flanks empty, which reads as a rendering bug
 * rather than a map. The viewBox is the board's own bounding box, so the
 * picture fills its frame whatever gets dealt.
 */
const W = 1200
const MAX_H = 860
const PAD = 24

/**
 * The seed the demo board is dealt from.
 *
 * Not arbitrary. Seeds were scanned for one that deals a LANDSCAPE board of
 * large territories, and this is the first that does both: it deals Siberia,
 * China, Central Asia and Persia at an aspect near 16:9. Both halves matter.
 * Landscape is what makes a hero image; large territories are what leaves room
 * to print a garrison count inside one, and a European deal — which the
 * selector reaches for often — packs forty countries into a blob where most of
 * the numbers have to be dropped.
 *
 * Changing it changes the picture and the three territory names in the
 * callouts, all of which are computed from the deal rather than written down —
 * so a new seed is a one-line change with no copy to chase.
 */
const SEED = 340_517

/** How many seats the demo board is dealt for. */
const DEMO_FACTIONS = 6

/**
 * Invented players, and deliberately obvious about it — the caption says so,
 * and a test pins that it does. Somebody reading the hero as a season in
 * progress would go looking for these six in Slack.
 *
 * The colours are the first six of the real season palette, copied rather than
 * imported: `PALETTE` lives in `src/jobs/season-init.ts`, and pulling a job
 * into the web layer to render a picture would drag the store in behind it.
 */
const DEMO_PLAYERS: [string, string][] = [
  ["Ada L.", "#e6194b"],
  ["Bo O.", "#3cb44b"],
  ["Cyrus M.", "#4363d8"],
  ["Dee W.", "#f58231"],
  ["Eli R.", "#911eb4"],
  ["Fern K.", "#42d4f4"],
]

/**
 * A board that looks like a game in progress.
 *
 * Dealt through exactly the code a real season uses — `selectSubMap`, then
 * `clusteredOrder`, then `createSeason` — so the holdings are contiguous for
 * the same reason a real deal's are, and the picture is not a flattering lie
 * about what day 0 looks like.
 *
 * Then played forward by a rough approximation rather than by the engine.
 * Running the real tick would need orders, policies and a `DailyContext`, which
 * would make the landing page depend on the simulator; what the hero actually
 * needs is ragged frontiers and uneven garrisons, and that is all this does.
 */
export function demoSeason(): GameState {
  const rng = makeRng(SEED)
  const map = selectSubMap(WORLD, DEMO_FACTIONS, rng)
  const factions: Faction[] = DEMO_PLAYERS.map(([playerName, color], i) => ({
    id: `f${i + 1}`,
    playerName,
    color,
  }))
  const state = createSeason("demo", factions, clusteredOrder(map, factions.length, rng), map)

  const ownership = { ...state.ownership }
  const neighborsOf = new Map(state.map.territories.map((t) => [t.id, t.neighbors]))
  const ids = state.map.territories.map((t) => t.id).sort()

  // Erode the blocks into a frontier. Three passes rather than one: a single
  // pass moves territories that were still surrounded by their original owner,
  // so the edges stay suspiciously straight.
  const held = new Map<FactionId, number>()
  for (const id of ids) held.set(ownership[id]!, (held.get(ownership[id]!) ?? 0) + 1)
  for (let pass = 0; pass < 3; pass++) {
    for (const id of ids) {
      if (rng() > 0.16) continue
      const from = ownership[id]!
      // Never take a faction's last territory. An eliminated seat would show a
      // colour in the standings that appears nowhere on the map, which reads as
      // a rendering bug rather than a game state.
      if ((held.get(from) ?? 0) <= 1) continue
      const foreign = (neighborsOf.get(id) ?? []).filter((n) => ownership[n] !== from).sort()
      const to = foreign[Math.floor(rng() * foreign.length)]
      if (to === undefined) continue
      const winner = ownership[to]!
      ownership[id] = winner
      held.set(from, (held.get(from) ?? 1) - 1)
      held.set(winner, (held.get(winner) ?? 0) + 1)
    }
  }

  // Garrisons pile up where the fighting is. An interior territory keeps a
  // token holding; a border territory is where the soldiers actually are, which
  // is what makes the frontier readable at a glance.
  const garrisons: Record<TerritoryId, number> = {}
  for (const id of ids) {
    const exposed = (neighborsOf.get(id) ?? []).some((n) => ownership[n] !== ownership[id])
    garrisons[id] = 1 + Math.floor(rng() * 3) + (exposed ? Math.floor(rng() * 7) : 0)
  }

  return { ...state, day: 9, ownership, garrisons }
}

interface Pin {
  n: number
  id: TerritoryId
  text: string
}

/**
 * The three things a stranger has to be told about the picture, anchored to the
 * board they are actually looking at.
 *
 * Every one is derived from the deal rather than written down, so the seed can
 * change without leaving three wrong country names in the copy.
 */
function pinsFor(state: GameState, me: FactionId): Pin[] {
  const nameOf = new Map(state.map.territories.map((t) => [t.id, t.name]))
  const ids = state.map.territories.map((t) => t.id).sort()
  const mine = ids.filter((id) => state.ownership[id] === me)
  const strongest = (from: TerritoryId[]): TerritoryId =>
    from.reduce((best, id) => ((state.garrisons[id] ?? 0) > (state.garrisons[best] ?? 0) ? id : best))

  const yours = strongest(mine)
  const border =
    mine
      .flatMap((id) => state.map.territories.find((t) => t.id === id)?.neighbors ?? [])
      .filter((n) => state.ownership[n] !== me)
      .sort()[0] ?? ids.find((id) => state.ownership[id] !== me)!
  const threat = strongest(ids.filter((id) => state.ownership[id] !== me))

  return [
    {
      n: 1,
      id: yours,
      text:
        `<strong>${esc(nameOf.get(yours))}</strong> is yours, and ` +
        `${esc(state.garrisons[yours])} soldiers are sat on it. They do nothing there. ` +
        `Soldiers only matter where the line is.`,
    },
    {
      n: 2,
      id: border,
      text:
        `<strong>${esc(nameOf.get(border))}</strong> is not yours and it touches you. ` +
        `You can send everything but one soldier at it — and whatever you send is ` +
        `not home defending when they come the other way.`,
    },
    {
      n: 3,
      id: threat,
      text:
        `Somebody has put ${esc(state.garrisons[threat])} soldiers on ` +
        `<strong>${esc(nameOf.get(threat))}</strong>. You can see that. What you cannot ` +
        `see is where they are pointed, and you will find out at the same moment ` +
        `everyone else does.`,
    },
  ]
}

/** Where a garrison count sits: the point furthest inside the territory. */
function anchor(id: TerritoryId): { lat: number; lon: number } {
  const p = LABELS[id]
  return p === undefined ? COORDS[id]! : { lat: p[1], lon: p[0] }
}

/**
 * The board, as a static SVG.
 *
 * Server-rendered rather than the Leaflet board a player gets, because a
 * landing page must not depend on a tile layer or a megabyte of client
 * JavaScript to show its own hero image. It is the same geometry: `SHAPES` is
 * what the real board draws, and `equalEarth` is the projection the world map
 * already uses.
 *
 * Coordinates are rounded to one decimal and consecutive duplicates dropped.
 * The outlines ARE this page's weight — untouched they are several hundred
 * kilobytes of decimals no browser can resolve at this size — and a test caps
 * the finished page so a switch to `SHAPES_FINE` or an off-board backdrop
 * cannot quietly restore them.
 */
function boardSvg(state: GameState, pins: Pin[]): string {
  const ids = state.map.territories.map((t) => t.id)
  const color = new Map(state.factions.map((f) => [f.id, f.color]))

  const rings = ids.map((id) => [id, SHAPES[id] ?? []] as const)
  const points = rings.flatMap(([, rs]) => rs.flat()).map(([lon, lat]) => equalEarth(lat, lon))
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x0 = Math.min(...xs)
  const y1 = Math.max(...ys)
  const spanX = Math.max(...xs) - x0 || 1
  const spanY = y1 - Math.min(...ys) || 1

  // Fit the width, then let the height fall out of the board's own aspect — one
  // scale for both axes, because fitting each independently would stretch the
  // board back into the distortion an equal-area projection exists to remove.
  // A board tall enough to overrun MAX_H fits its height instead and is
  // centred, which is the only case that letterboxes.
  const scale = Math.min((W - 2 * PAD) / spanX, (MAX_H - 2 * PAD) / spanY)
  const H = Math.round(spanY * scale + 2 * PAD)
  const offX = (W - spanX * scale) / 2
  const at = (lat: number, lon: number): { x: number; y: number } => {
    const p = equalEarth(lat, lon)
    // Plane y grows north; SVG y grows down.
    return { x: offX + (p.x - x0) * scale, y: PAD + (y1 - p.y) * scale }
  }

  const ring = (rs: [number, number][][]): string =>
    rs
      .map((r) => {
        const pts: string[] = []
        let last = ""
        for (const [lon, lat] of r) {
          const p = at(lat, lon)
          const s = `${p.x.toFixed(1)},${p.y.toFixed(1)}`
          // Sub-pixel detail survives rounding as a repeated point. Dropping
          // the repeats is most of the saving and changes nothing drawn.
          if (s === last) continue
          pts.push(s)
          last = s
        }
        return pts.length < 3 ? "" : `M${pts.join("L")}Z`
      })
      .join("")

  // The countries nobody was dealt, drawn flat behind everything.
  //
  // Not decoration. Without them the board has a HOLE in it — a six-faction
  // deal across Asia leaves Mongolia and Tibet unclaimed in the middle of it,
  // and an unfilled gap the shape of a country reads as a map that failed to
  // render rather than as ground nobody owns.
  //
  // Bounded to the board's own extent, which is what keeps it affordable: the
  // world has 200-odd of these and only the three dozen inside the frame are
  // worth any bytes.
  const onBoard = new Set(ids)
  const backdrop = Object.entries(SHAPES)
    .filter(([id, rs]) => {
      if (onBoard.has(id) || rs.length === 0) return false
      const c = COORDS[id]
      if (c === undefined) return false
      const p = equalEarth(c.lat, c.lon)
      return p.x >= x0 && p.x <= x0 + spanX && p.y >= y1 - spanY && p.y <= y1
    })
    .map(([, rs]) => ring(rs))
    .filter((d) => d !== "")
    .map((d) => `<path class="dm-off" d="${d}"/>`)
    .join("")

  // Each territory's drawn extent, kept so a garrison count can be dropped from
  // one with no room for it. The real board does the same (`.gcount.hide`); a
  // number wider than the country it names lands in the sea beside it.
  const room = new Map<TerritoryId, { w: number; h: number }>()

  const shapes = rings
    .map(([id, rs]) => {
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      const d = rs
        .map((ring) => {
          const pts: string[] = []
          let last = ""
          for (const [lon, lat] of ring) {
            const p = at(lat, lon)
            const s = `${p.x.toFixed(1)},${p.y.toFixed(1)}`
            // Sub-pixel detail survives rounding as a repeated point. Dropping
            // the repeats is most of the saving and changes nothing drawn.
            if (s === last) continue
            pts.push(s)
            last = s
            minX = Math.min(minX, p.x)
            maxX = Math.max(maxX, p.x)
            minY = Math.min(minY, p.y)
            maxY = Math.max(maxY, p.y)
          }
          return pts.length < 3 ? "" : `M${pts.join("L")}Z`
        })
        .join("")
      if (d === "") return ""
      room.set(id, { w: maxX - minX, h: maxY - minY })
      const fill = color.get(state.ownership[id]!) ?? "#888"
      return `<path class="dm-t" d="${d}" fill="${esc(fill)}"><title>${esc(
        state.map.territories.find((t) => t.id === id)?.name ?? id,
      )} — ${esc(state.garrisons[id])}</title></path>`
    })
    .join("")

  const counts = ids
    .map((id) => {
      // Sized for the LARGEST the number ever gets, which is the phone
      // breakpoint rather than the desktop one: there is a single render for
      // every width, and on a ~390px screen the count has to grow to about 32
      // user units to stay legible at all. Checking it against the desktop size
      // would pass territories the mobile number then overflows.
      //
      // The bounding box overstates the room in anything not roughly
      // rectangular, so this is still generous — but it is only deciding
      // whether a number is legible, not where it goes, and `anchor` already
      // puts it at the point furthest inside the coastline. On this board it
      // drops 2 of 44.
      const fits = room.get(id)
      if (fits === undefined || fits.w < 34 || fits.h < 32) return ""
      const a = anchor(id)
      const p = at(a.lat, a.lon)
      return `<text class="dm-n" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}">${esc(
        state.garrisons[id],
      )}</text>`
    })
    .join("")

  // Numbered pins rather than leader lines with labels on the map. A leader
  // line has to be placed clear of the shapes it points past, and the deal that
  // decides where those shapes are is seeded — so the placement would have to
  // be solved rather than chosen, for a picture whose captions read perfectly
  // well underneath it.
  //
  // Pushed apart because two of the three are guaranteed to be NEIGHBOURS: pin
  // 2 is chosen as a territory bordering pin 1's owner, so on a board of small
  // countries the two markers land on top of each other.
  const placed: { x: number; y: number }[] = []
  const marks = pins
    .map((pin) => {
      const a = anchor(pin.id)
      const p = at(a.lat, a.lon)
      let x = p.x
      let y = p.y - 34
      // Cleared against the marker's MOBILE radius (26), not its desktop one —
      // one render serves both, and pins that merely look separate at desktop
      // size overlap once the breakpoint grows them.
      for (let turn = 0; turn < 8; turn++) {
        if (!placed.some((q) => Math.hypot(q.x - x, q.y - y) < 58)) break
        // Walk the marker around its anchor rather than off in one direction,
        // so a crowded corner cannot march it into the sea.
        const angle = ((turn + 1) * Math.PI) / 4
        x = p.x + Math.sin(angle) * 46
        y = p.y - Math.cos(angle) * 46
      }
      placed.push({ x, y })
      return (
        `<g class="dm-pin"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="15"/>` +
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}">${pin.n}</text></g>`
      )
    })
    .join("")

  return (
    `<svg class="dm" viewBox="0 0 ${W} ${H}" role="img"` +
    ` aria-label="An example board: ${ids.length} territories held between ${DEMO_FACTIONS} players">` +
    `${backdrop}${shapes}${counts}${marks}</svg>`
  )
}

/** One faction's line in the demo standings. */
function standingsRow(state: GameState, f: Faction, me: FactionId): string {
  const n = Object.values(state.ownership).filter((o) => o === f.id).length
  return (
    `<tr${f.id === me ? ' class="on"' : ""}>` +
    `<td><span class="sw" style="background:${esc(f.color)}"></span>${esc(f.playerName)}` +
    `${f.id === me ? " <em>(you)</em>" : ""}</td>` +
    `<td class="n">${n}</td></tr>`
  )
}

/** A Slack message, as it looks in the channel. Our markup, not a screenshot. */
function slackCard(args: { who: string; initial: string; body: string; reactions: string }): string {
  return `<div class="sk">
  <div class="sk-av" aria-hidden="true">${esc(args.initial)}</div>
  <div class="sk-msg">
    <p class="sk-who">${esc(args.who)}</p>
    ${args.body}
    <div class="sk-rx">${args.reactions}</div>
  </div>
</div>`
}

function reaction(emoji: string, n: number, on = false): string {
  return `<span class="sk-r${on ? " on" : ""}"><span class="em">${esc(emoji)}</span><b>${esc(
    n,
  )}</b></span>`
}

/**
 * Three rules for the mock offer, read from the catalogue rather than written
 * out here.
 *
 * The catalogue's own comment says display names and descriptions are read from
 * the registry at render time and may change freely — so a landing page that
 * quoted them by hand would be the one place they could go stale, advertising a
 * rule under a name the bot no longer uses.
 *
 * Picked by id, because these three happen to show the range: one that stops
 * the war, one that punishes the leader, one that just taxes everybody. If an
 * id ever leaves the catalogue the offer tops itself up in catalogue order
 * rather than rendering short — a landing page must not go blank over a rule.
 */
export const OFFER_IDS = ["truce", "eat-the-rich", "attrition"]

function offeredRules(): { name: string; description: string }[] {
  const picked = OFFER_IDS.map((id) => RULE_CATALOGUE.find((r) => r.id === id)).filter(
    (r): r is (typeof RULE_CATALOGUE)[number] => r !== undefined,
  )
  for (const r of RULE_CATALOGUE) {
    if (picked.length >= 3) break
    if (!picked.includes(r)) picked.push(r)
  }
  return picked.slice(0, 3).map((r) => ({ name: r.name, description: r.description }))
}

export function renderLanding(): string {
  const state = demoSeason()
  const me = state.factions[0]!.id
  const pins = pinsFor(state, me)
  const mine = Object.values(state.ownership).filter((o) => o === me).length

  return page(
    "Riskety Rekt",
    `<div class="land">

  <header class="land-hero">
    <h1 class="land-title">Riskety&nbsp;Rekt</h1>
    <p class="land-hook">A game of world conquest that takes ninety seconds a day,
      runs for ${SEASON_LENGTH} nights in your Slack, and pays you in soldiers for
      doing push-ups.</p>
    <p class="land-hook-2">Everybody moves at 21:00. Nobody moves first.</p>
  </header>

  <figure class="shot">
    <div class="shot-frame">${boardSvg(state, pins)}</div>
    <figcaption class="shot-cap">Day 9 of an example season. The six players are made
      up — but the world, the borders and the way the ground was dealt are the real
      ones, and a season picks its board out of the same map. You would be
      <strong>${esc(state.factions[0]!.playerName)}</strong>, holding ${esc(mine)} of the
      ${esc(state.map.territories.length)} territories in play.</figcaption>
  </figure>

  <ol class="pins">${pins
    .map((p) => `<li><span class="pin-n">${p.n}</span><span>${p.text}</span></li>`)
    .join("")}</ol>

  <section class="land-s">
    <h2>One tick a day</h2>
    <p class="land-lede">You are never waiting for your turn, because there are no
      turns.</p>
    <ol class="beats">
      <li><b>All day</b><span>Tap your territories, plan deploys, moves and attacks.
        Change your mind as often as you like. Nothing you save has happened yet.</span></li>
      <li><b>21:00 Eastern</b><span>Everything locks and everyone's orders resolve at the
        same instant. There is no turn order, no first-mover advantage, and no
        reward for submitting late.</span></li>
      <li><b>Overnight</b><span>The bot posts what happened. You open the board next
        morning to a replay of the night and a new set of decisions.</span></li>
    </ol>
    <p class="land-note">You never see anyone else's plan and they never see yours.
      Everything you know about tonight, you inferred from the map — and from what
      people were willing to say out loud in the channel.</p>
  </section>

  <section class="land-s">
    <h2>Push-ups are currency</h2>
    <p class="land-lede">The soldiers come from somewhere. That somewhere is you,
      doing something, and proving it.</p>
    <div class="shot shot-narrow">
      <div class="shot-frame shot-slack">
        ${slackCard({
          who: state.factions[1]!.playerName,
          initial: state.factions[1]!.playerName.slice(0, 1),
          body: `<p class="sk-b">5k before work. Cold. No I did not enjoy it.</p>
            <div class="sk-img"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15"
              rx="2"/><circle cx="8" cy="10" r="1.8"/><path d="M3 17l5-5 4 4 3-3 6 6"/></svg>
            <span>photo</span></div>`,
          reactions: `${reaction("👍", 3, true)}${reaction("🥶", 2)}`,
        })}
      </div>
      <figcaption class="shot-cap">Two <span class="em">👍</span>from other players is the
        whole approval process. Your own reaction never counts.</figcaption>
    </div>
    <ul class="land-ul">
      <li>A workout that clears two <span class="em">👍</span>is worth <b>+1 soldier</b>.
        Two a day, maximum.</li>
      <li><b>+1 more</b> for the first person to post that day, and <b>+1</b> for the last
        one approved before the tick. Which means the channel has a rush at breakfast
        and another one at dinner, and both of them are strategic.</li>
      <li>This is the part nobody believes until the second week, when they notice
        they have been going to the gym to win a board game.</li>
    </ul>
  </section>

  <section class="land-s">
    <h2>Your war chest is also a betting account</h2>
    <p class="land-lede">Every morning the bot posts real prediction-market questions
      with real odds. You can put soldiers on them.</p>
    <div class="shot shot-narrow">
      <div class="shot-frame shot-panel">
        <div class="wg">
          <p class="wg-h">Today's slate <span class="wg-r">reserve <b>14</b></span></p>
          <div class="wg-m">
            <p class="wg-q">Will the Fed cut rates at the September meeting?</p>
            <p class="wg-p">Yes 62¢ · No 38¢ · closes 14:00</p>
            <p class="wg-s"><span class="wg-side on">YES</span><span class="wg-side">NO</span>
              <span class="wg-stake">stake <b>6</b></span>
              <span class="wg-pay">wins <b>10</b></span></p>
          </div>
          <div class="wg-m">
            <p class="wg-q">Will it rain in Central Park on Thursday?</p>
            <p class="wg-p">Yes 21¢ · No 79¢ · closes 20:00</p>
            <p class="wg-s"><span class="wg-side">YES</span><span class="wg-side">NO</span>
              <span class="wg-stake">not staked</span></p>
          </div>
        </div>
      </div>
      <figcaption class="shot-cap">The wagers sheet, over the board.</figcaption>
    </div>
    <p>Here is the tension, and it is the best thing in the game: <strong>a stake and
      a soldier come out of the same pot.</strong> Six soldiers on the Fed is six
      soldiers not standing on your border tonight. Win and you are further ahead than
      any amount of conquering would have got you. Lose and you spent your army on
      an interest rate.</p>
    <p class="land-note">One wager per market — backing both sides would be free money,
      so it is not allowed. And a wager is priced the moment you place it, not at the
      tick, so there is no waiting until the answer is obvious.</p>
  </section>

  <section class="land-s">
    <h2>You vote on the rules. Daily.</h2>
    <p class="land-lede">Every morning the bot offers three rules from the catalogue.
      Whichever wins applies tonight, and tonight only.</p>
    <div class="shot shot-narrow">
      <div class="shot-frame shot-slack">
        ${slackCard({
          who: "Riskety Rekt",
          initial: "R",
          body: `<p class="sk-b"><b>Tonight's rule — vote by 21:00</b></p>
            <p class="sk-b">${offeredRules()
              .map(
                (r, i) =>
                  `<span class="em">${["1️⃣", "2️⃣", "3️⃣"][i]}</span> <b>${esc(r.name)}</b> — ` +
                  `${esc(r.description)}`,
              )
              .join("<br>")}</p>`,
          reactions: `${reaction("1️⃣", 1)}${reaction("2️⃣", 4, true)}${reaction("3️⃣", 1)}`,
        })}
      </div>
      <figcaption class="shot-cap">Change your mind whenever you like — your latest
        reaction is the one that counts.</figcaption>
    </div>
    <p>Which is how a quiet evening becomes a bloodbath because four people decided
      it should be, and how the player in last place gets a say in the shape of the
      night. If nobody votes, nothing changes.</p>
  </section>

  <section class="land-s">
    <h2>Nobody is ever quite out</h2>
    <p>Lose your last territory and you can still shield one territory a day from
      attack — anyone's, including the person who took you out. But only on a day
      you posted a workout. Showing up is the price of a say in how it ends.</p>
    <p class="land-note">After ${SEASON_LENGTH} nights, whoever holds the most ground
      wins, and somebody is insufferable about it until the next season.</p>
  </section>

  <section class="land-s land-join">
    <h2>Getting in</h2>
    <p><strong>Joining is not self-service, on purpose.</strong> Everything — the board,
      the seats, the ground — is handed out the moment a season begins, so somebody
      who joins on day 6 has nothing to play with. Ask whoever runs the season to add
      you, and ask <em>before</em> it starts.</p>
    <p>Already a player? Run <code>/login</code> in Slack and follow the link it sends
      you. The link is good for ten minutes and works once. Run it as often as you
      like — your last ${MAX_LIVE_TOKENS} links all keep working, so asking for a new
      one never breaks the one you were about to tap.</p>
    <p>Ran <code>/login</code> and nothing came back? Then you are not on the roster
      yet, and the command replied with the one-line invitation to send to whoever
      runs the season.</p>
    <p class="land-out"><a href="/rules">Every rule, and why it is that rule</a> ·
      <a href="/map">The whole world map</a></p>
  </section>

</div>`,
  )
}
