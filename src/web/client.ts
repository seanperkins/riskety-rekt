/**
 * The player client, as a string served from memory.
 *
 * Vanilla and hand-written: there is no bundler, and adding one would cost the
 * `node:sqlite` property that `createRequire` exists to protect. Leaflet is the
 * one library, served statically — a client dependency never touches the
 * server, the tick, or the test suite.
 *
 * **It never validates.** It shows the reserve and what the plan spends, but
 * legality belongs to the engine, whose rejections already surface publicly in
 * the recap. A client that pre-validated would drift from the engine and start
 * lying, and the lie would be invisible until a rejection appeared in front of
 * the whole channel.
 */
export const CLIENT = String.raw`
(() => {
const P = window.__RR__
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]))

// ---- state -----------------------------------------------------------------
// The plan is the order. saveOrder replaces the whole body, so there is no
// merge and no partial state to reconcile.
let plan = { deploys: [], attacks: [], moves: [], protect: P.plan.protect ?? null }
plan.deploys = P.plan.deploys.map((d) => ({ ...d }))
plan.attacks = P.plan.attacks.map((a) => ({ ...a }))
plan.moves = (P.plan.moves || []).map((m) => ({ ...m }))
let selected = null
// A transient hover highlight: {kind: "region"|"faction", id}. Distinct from
// 'selected', which is an ORDER target and survives the pointer leaving.
let highlight = null
// The plan row under the pointer, resolved to the ground it names:
// {kind, from, to} with 'from' null for a deploy or a shield. Separate from
// 'highlight' because the two answer different questions and can both be live
// -- one says "whose ground is this", the other "where does THIS order go".
let hoverOrder = null
let saveState = "saved"

const mine = (id) => P.ownership[id] === P.factionId

// Eliminated: nothing left on the board. The interaction model INVERTS here,
// and it has to. Every other order names a territory you own, so the selection
// was only ever assigned inside the mine(id) branch -- which meant a player
// holding nothing could never select anything, the Protect button's no-selection
// guard never cleared, and the elimination veto was unreachable from this page
// for exactly the people it exists for. The engine lets a veto name ANY
// territory on the map (veto.ts validates existence, not ownership), so when you
// are out, every territory becomes selectable and nothing else is.
const eliminated = Object.values(P.ownership).indexOf(P.factionId) === -1
// A veto is neither validated nor applied in a veto-off season -- the module
// owns both hooks -- so offering the button there would be a lie.
const canVeto = eliminated && P.modules.indexOf("veto") !== -1
const owner = (id) => P.ownership[id]
const colorOf = (f) => (P.factions.find((x) => x.id === f) || {}).color || "#888"
const nameOf = (id) => (P.territories.find((t) => t.id === id) || {}).name || id
const byId = Object.fromEntries(P.territories.map((t) => [t.id, t]))

const spent = () =>
  plan.deploys.reduce((n, d) => n + d.count, 0) +
  P.wagers.reduce((n, w) => n + w.stake, 0)

// ---- map -------------------------------------------------------------------
// zoomSnap 0 lets fitBounds land on a fractional zoom. Leaflet's default snaps
// to whole levels, so an ideal fit of 4.7 floors to 4 and shows nearly twice
// the area needed -- the board filled barely half the container with grey
// backdrop around it. Fractional zoom is only a problem for raster tiles, which
// have a native resolution to be blurred away from; this map is vector.
// Two knobs, both overridable by query string so they can be compared without
// a redeploy:
//
//   ?zoomanim=0   zoom jumps straight to the new scale instead of tweening
//   ?zoomsnap=N   0 is continuous, 1 is Leaflet's default (see below)
//
// zoomAnimation tweens each step over 250ms. A trackpad emits a continuous
// stream, so every new step INTERRUPTS the running tween -- Leaflet stops it,
// re-projects, and starts another. Off, each step is one instant re-projection
// and the map keeps up with the gesture.
const params = new URLSearchParams(location.search)
const map = L.map("map", {
  zoomControl: true,
  attributionControl: false,
  worldCopyJump: false,
  zoomAnimation: params.get("zoomanim") !== "0",
  // zoomSnap 0 ONLY for the opening fitBounds -- see below, where it is put
  // back. Left at 0, every wheel notch is a distinct fractional zoom, so a
  // trackpad's continuous stream starts a fresh animated zoom cycle every few
  // milliseconds and each one interrupts the last: Leaflet stops the running
  // animation, re-projects every layer, fires moveend, and starts again. That
  // is the sluggishness, and it is unrelated to how much geometry is on the
  // board -- which is why turning the backdrop off changed nothing.
  zoomSnap: 0,
  scrollWheelZoom: true,
  // The +/- buttons and the keyboard move in readable steps rather than whole
  // levels, since fractional zoom is available anyway.
  zoomDelta: 0.5,
  // OFF, and this is a correctness fix rather than a preference. The board's
  // whole gesture is "tap your territory, tap it again to put a soldier on
  // it", so two taps in quick succession are the NORMAL way to deploy -- and
  // to the browser they are also a double click. Leaflet's DoubleClickZoom
  // listens on the container, the polygon's own click handler does not stop
  // dblclick, so every fast pair deployed a soldier AND flew the map in half a
  // zoom level under the finger. Measured: two taps 700ms apart leave the
  // geometry at 64px, the same pair 60ms apart takes it to 86px.
  //
  // Nothing is lost. The +/- control, the wheel, the keyboard and clicking a
  // player in the rail all still zoom; this removes the one zoom gesture that
  // collides with acting on the map.
  doubleClickZoom: false,
})
const layers = {}

// The rest of the world: one CANVAS layer, one shape.
//
// ON by default; ?backdrop=0 removes it. It was switched off while we worked
// out what made zooming feel slow, and the answer was that this is not it:
// turning it off changed nothing, because the cost was zoom CYCLES rather than
// geometry. Without it a 70-territory board floats in an empty sea and an ocean
// is indistinguishable from a country nobody was dealt.
//
// It began as 451 separate SVG polygons -- one per ring across 194
// territories, against 70 for the board itself -- so every zoom re-projected
// all of them and the browser laid out 451 DOM nodes. Collapsing it to a
// single multi-polygon on a canvas made that one draw call, which is free
// because the backdrop is uniform and inert: no CSS, no hit testing, no focus
// ring, which are the only reasons to prefer SVG.
const wantBackdrop = params.get("backdrop") !== "0"

if (wantBackdrop) {
  map.createPane("backdrop")
  map.getPane("backdrop").style.zIndex = 200
  map.getPane("backdrop").style.pointerEvents = "none"

  const backdropRings = []
  for (const id in (P.offBoard || {})) {
    for (const ring of P.offBoard[id]) {
      backdropRings.push([ring.map(([lon, lat]) => [lat, lon])])
    }
  }
  if (backdropRings.length) {
    L.polygon(backdropRings, {
      renderer: L.canvas({ pane: "backdrop", padding: 0.3 }),
      pane: "backdrop",
      stroke: true, weight: 0.5, color: "#16242f",
      fillColor: "#22303c", fillOpacity: 0.45,
      interactive: false,
    }).addTo(map)
  }
}

// ---- sea bridges ------------------------------------------------------------
// A dedicated pane BELOW the overlay pane, so bridges are behind every
// territory no matter what bringToFront does later. Paint order alone was
// already correct and still was not enough: territory fills are translucent,
// so a line behind them showed straight through and read as lying on top.
//
// The real fix is that a bridge now runs coast to COAST rather than centre to
// centre, so it never passes over land at all. Without it an attack from
// Tunisia to Sicily looks impossible -- the two do not touch, and nothing on
// the map says why they are adjacent.
map.createPane("bridges")
map.getPane("bridges").style.zIndex = 350
map.getPane("bridges").style.pointerEvents = "none"

const inRings = (lon, lat, rings) => {
  for (const ring of rings) {
    let hit = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit
    }
    if (hit) return true
  }
  return false
}

// Walk the segment and find where it leaves one shore and reaches the other.
// Sampling rather than solving for the intersection: a territory is a
// multipolygon of simplified rings, and 120 steps puts the endpoint within a
// pixel or two at any zoom anyone plays at.
function overWater(a, b, ringsA, ringsB) {
  const STEPS = 120
  const at = (t) => [a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t]
  let start = 0
  for (let i = 0; i <= STEPS; i++) {
    const [x, y] = at(i / STEPS)
    if (!inRings(x, y, ringsA)) { start = i / STEPS; break }
  }
  let end = 1
  for (let i = STEPS; i >= 0; i--) {
    const [x, y] = at(i / STEPS)
    if (!inRings(x, y, ringsB)) { end = i / STEPS; break }
  }
  if (!(end > start)) return null
  const [x0, y0] = at(start)
  const [x1, y1] = at(end)
  return [[y0, x0], [y1, x1]]
}

for (const [a, b] of (P.seaLinks || [])) {
  const ca = P.centres[a]
  const cb = P.centres[b]
  if (!ca || !cb) continue
  const line = overWater(ca, cb, P.shapes[a] || [], P.shapes[b] || []) ||
    [[ca.lat, ca.lon], [cb.lat, cb.lon]]
  // The casing underneath keeps the dashes legible against open water.
  L.polyline(line, {
    pane: "bridges", color: "#0b1a24", weight: 5, opacity: 0.85, interactive: false,
  }).addTo(map)
  L.polyline(line, {
    pane: "bridges", color: "#e8c56a", weight: 2, opacity: 0.95, dashArray: "6 4", interactive: false,
  }).addTo(map)
}

for (const t of P.territories) {
  const rings = P.shapes[t.id] || []
  if (!rings.length) continue
  // GeoJSON is [lon, lat]; Leaflet polygons are [lat, lon].
  //
  // Each ring is wrapped in its own array, making this a MULTI-polygon rather
  // than one polygon with holes. Leaflet reads a flat array of rings as
  // outer-then-holes, and every ring here is a separate landmass -- the build
  // drops holes at extraction. Flat, Nunavut's twenty Arctic islands were
  // punched out of the mainland as holes; 46 of 264 territories were affected.
  const latlngs = rings.map((r) => [r.map(([lon, lat]) => [lat, lon])])
  const poly = L.polygon(latlngs, { weight: 1, color: "#0b1a24", fillOpacity: 0.85 })
  poly.on("click", () => onTap(t.id))
  poly.bindTooltip(() => tooltip(t.id), { sticky: true })
  poly.addTo(map)
  layers[t.id] = poly
}

// The garrison AFTER the viewer's plan: deploys arrive, committed attacks
// leave. Only for territories the viewer owns -- an attack does not lower the
// TARGET's number, because the defender's tonight is unknown and drawing it
// would be a prediction wearing a fact's clothes.
function plannedGarrison(id) {
  const base = P.garrisons[id] ?? 0
  if (!mine(id)) return base
  const inbound =
    plan.deploys.filter((d) => d.territory === id).reduce((n, d) => n + d.count, 0) +
    plan.moves.filter((m) => m.to === id).reduce((n, m) => n + m.count, 0)
  const outbound =
    plan.attacks.filter((a) => a.from === id).reduce((n, a) => n + a.count, 0) +
    plan.moves.filter((m) => m.from === id).reduce((n, m) => n + m.count, 0)
  return base + inbound - outbound
}

function tooltip(id) {
  const g = P.garrisons[id] ?? 0
  const o = owner(id)
  const f = P.factions.find((x) => x.id === o)
  const eff = plannedGarrison(id)
  const delta = eff === g ? "" : " -> " + eff + " after your orders"
  return esc(nameOf(id)) + " — " + g + delta + (f ? " · " + esc(f.name) : " · unclaimed")
}

// ---- garrison counts --------------------------------------------------------
// The number on the territory, which is the single most-consulted fact on the
// board: every attack decision is a comparison of two of them. It was tooltip
// only, so comparing your border to the one facing it meant hovering each in
// turn and remembering.
//
// interactive:false throughout — a label must never eat the tap meant for the
// territory under it.
const countMarkers = {}
for (const t of P.territories) {
  // The label point, not the country centroid -- see Projection.labels.
  const c = (P.labels || {})[t.id] || P.centres[t.id]
  if (!c) continue
  const m = L.marker([c.lat, c.lon], {
    interactive: false,
    keyboard: false,
    icon: L.divIcon({ className: "gcount", html: "0", iconSize: [26, 16], iconAnchor: [13, 8] }),
  }).addTo(map)
  countMarkers[t.id] = m
}

function paintCounts() {
  for (const t of P.territories) {
    const m = countMarkers[t.id]
    if (!m) continue
    const el = m.getElement()
    if (!el) continue
    const base = P.garrisons[t.id] ?? 0
    const eff = plannedGarrison(t.id)
    el.textContent = String(eff)
    el.classList.toggle("planned", eff !== base)
    // classList, NEVER el.className. Leaflet puts its own classes on a marker's
    // icon element -- leaflet-marker-icon and leaflet-zoom-animated among them
    // -- and leaflet-zoom-animated is what repositions the marker when the map
    // zooms. Assigning className wiped them, so every count was correct on
    // first render and then stayed frozen in place from the first zoom onward,
    // sliding off its territory and bunching with its neighbours.
    el.classList.toggle("own", mine(t.id))
  }
}

// Hide a count that does not fit inside its territory.
//
// Measured against the largest rectangle that fits INSIDE the territory, not
// its bounding box. A bounding box overstates the room badly for anything that
// is not roughly rectangular: Norway's is enormous while its interior is a few
// kilometres wide, so the number passed the test and then sat in the sea.
//
// Zoomed out, a number wider than the country covers the thing it describes
// and collides with its neighbours'. The tooltip still has it, and zooming in
// brings it back -- which is the whole point of testing against real room
// rather than a zoom threshold: territories differ by orders of magnitude, and
// at the zoom where Luxembourg's number fits, Russia left the screen long ago.
function updateCountVisibility() {
  for (const t of P.territories) {
    const m = countMarkers[t.id]
    const b = (P.labelBoxes || {})[t.id]
    if (!m) continue
    const el = m.getElement()
    if (!el) continue
    if (!b) { el.classList.remove("hide"); continue }
    // Project the two corners. Arithmetic -- it reads nothing from the DOM.
    const sw = map.latLngToLayerPoint([b[1], b[0]])
    const ne = map.latLngToLayerPoint([b[3], b[2]])
    const wPx = Math.abs(ne.x - sw.x)
    const hPx = Math.abs(ne.y - sw.y)
    // Roughly what the glyphs occupy: ~7px per digit plus breathing room.
    const digits = String(plannedGarrison(t.id)).length
    el.classList.toggle("hide", wPx < 7 * digits + 4 || hPx < 12)
  }
}

// ---- region bonuses ---------------------------------------------------------
// A badge per region showing what holding all of it pays. The bonus is computed
// per board — a region's worth depends on which of its neighbours were selected
// — so it cannot be learned once and remembered across seasons, which is
// exactly why it belongs on the map rather than in a rulebook.
const regionOf = {}
for (const t of P.territories) (regionOf[t.region] = regionOf[t.region] || []).push(t.id)

// Where each region's badge goes.
//
// A badge must not cover playable ground -- it is the one overlay that sits
// outside the shape it names, precisely so it hides nothing. So each of the
// four sides is TESTED rather than guessed: the anchor is pushed a little way
// out from the region's bounding box, and if that point lands inside a
// territory somebody is playing, that side is rejected. Water and the unused
// backdrop are both fine to sit on; neither is anything you can act on.
//
// Among the sides that are free, the order is left, right, up, down -- reading
// order, so a scan across the map finds labels where the eye already is. A side
// already taken by another badge is skipped, since two badges in the same place
// is worse than one badge on a less preferred side.
//
// Decided ONCE, at the opening fit. The anchor is a lat/lon, so it travels with
// the map; recomputing per zoom would make badges hop between sides while you
// are reading them.
const boardRings = P.territories.map((t) => P.shapes[t.id] || [])

function insideBoard(lon, lat) {
  for (const rings of boardRings) {
    for (const ring of rings) {
      let hit = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit
      }
      if (hit) return true
    }
  }
  return false
}

// Roughly what a collapsed badge occupies. Only used to keep two of them apart,
// so an estimate is enough -- the name is hidden until hover.
const BADGE_W = 34
const BADGE_H = 22
const placed = []

function overlapsPlaced(lat, lon) {
  const p = map.latLngToLayerPoint([lat, lon])
  for (const q of placed) {
    if (Math.abs(p.x - q.x) < BADGE_W && Math.abs(p.y - q.y) < BADGE_H) return true
  }
  return false
}

// Called AFTER the opening fitBounds. Choosing a side needs pixel positions to
// keep two badges apart, and latLngToLayerPoint has no scale to work from until
// the map has a view.
// A five-point crown. __FILL__ is replaced with the holder's colour; the dark
// outline matches the map's territory borders.
const CROWN_SVG =
  '<svg class="rb-crown" viewBox="0 0 16 13" aria-hidden="true">' +
  '<path d="M2 11 L2.6 4 L5.6 6.6 L8 2 L10.4 6.6 L13.4 4 L14 11 Z"' +
  ' fill="__FILL__" stroke="#0b1a24" stroke-width="1.3" stroke-linejoin="round"/></svg>'

function placeRegionBadges() {
for (const r of P.regions) {
  const ids = regionOf[r.id] || []
  if (!ids.length) continue

  // Bounds over the real POLYGONS, not the centre points: a badge has to clear
  // the land it names, and a box over centres sits well inside the coastline of
  // anything bigger than a few territories.
  let north = -90, south = 90, east = -180, west = 180, any = false
  let cLat = 0, cLon = 0, cN = 0
  for (const id of ids) {
    for (const ring of (P.shapes[id] || [])) {
      for (const [lon, lat] of ring) {
        if (lat > north) north = lat
        if (lat < south) south = lat
        if (lon > east) east = lon
        if (lon < west) west = lon
        any = true
      }
    }
    const c = P.centres[id]
    if (c) { cLat += c.lat; cLon += c.lon; cN++ }
  }
  if (!any || !cN) continue
  const mid = { lat: cLat / cN, lon: cLon / cN }

  // A nudge outward, proportional to the region so a small one is not pushed
  // halfway across the board.
  const padLon = Math.max(0.4, (east - west) * 0.06)
  const padLat = Math.max(0.4, (north - south) * 0.06)

  const sides = [
    { side: "w", at: [mid.lat, west], probe: [mid.lat, west - padLon] },
    { side: "e", at: [mid.lat, east], probe: [mid.lat, east + padLon] },
    { side: "n", at: [north, mid.lon], probe: [north + padLat, mid.lon] },
    { side: "s", at: [south, mid.lon], probe: [south - padLat, mid.lon] },
  ]

  const free = sides.filter((o) => !insideBoard(o.probe[1], o.probe[0]))
  const pick =
    free.find((o) => !overlapsPlaced(o.at[0], o.at[1])) ||
    sides.find((o) => !overlapsPlaced(o.at[0], o.at[1])) ||
    free[0] ||
    sides[0]

  const pt = map.latLngToLayerPoint([pick.at[0], pick.at[1]])
  placed.push({ x: pt.x, y: pt.y })

  // Whoever holds every territory in the region owns the bonus. The badge says
  // so with a CROWN in their colour rather than a recoloured chip: ten faction
  // colours behind gold text made some sole-held badges unreadable, and a
  // completed region is exactly the thing that must read at a glance. The dark
  // outline keeps a light crown visible over sea and land alike.
  const holders = new Set(ids.map((id) => owner(id)))
  const sole = holders.size === 1 ? [...holders][0] : null
  const holderName = sole ? ((P.factions.find((f) => f.id === sole) || {}).name || sole) : null
  const crown = sole
    ? CROWN_SVG.replace("__FILL__", colorOf(sole))
    : ""
  L.marker(pick.at, {
    interactive: true,
    keyboard: false,
    icon: L.divIcon({
      // side-n, NOT rb-n: the number chip's class IS rb-n, so a badge placed on
      // its region's north side used to collide with it and drew the chip's
      // border on the whole badge -- a second, larger gold box behind the real
      // one, on exactly the north-placed badges and no others.
      className: "rbadge side-" + pick.side,
      // aria-label carries the name that CSS hides, so the badge still reads
      // as more than a bare number to a screen reader.
      html: '<span class="rb-in" data-region="' + esc(r.id) + '"' +
        ' aria-label="' + esc(r.name) + ', +' + r.bonus + ' for the whole region' +
        (holderName ? ', held by ' + esc(holderName) : "") + '">' +
        crown +
        '<span class="rb-n">+' + r.bonus + '</span>' +
        '<span class="rb-name">' + esc(r.name) + '</span></span>',
      // iconSize NULL, not omitted. DivIcon DEFAULTS to [12, 12] and writes it
      // as an inline width/height, which beats the stylesheet -- the badge came
      // out 12px square with its text overflowing, visible but with almost no
      // hit area. Explicit null makes Leaflet write nothing at all.
      iconSize: null,
      iconAnchor: null,
    }),
  }).addTo(map)
}
}

// ---- hover highlight --------------------------------------------------------
// One reusable layer, restyled and re-pathed as the hover moves. A region shows
// its OUTER boundary only -- stroking each of its territories draws every
// internal border too, and the region then reads as a bundle of shapes rather
// than one area.
// Its own pane ABOVE the territories. It was sharing the bridges pane at
// z-index 350, below the overlay pane at 400, so every territory painted over
// it -- most visibly the heavier stroke on the ones you own, which swallowed
// the outline exactly where it mattered. 450 clears the territories and stays
// under the marker pane at 600, so garrison counts and badges still sit on top.
map.createPane("highlight")
map.getPane("highlight").style.zIndex = 450
map.getPane("highlight").style.pointerEvents = "none"

const outline = L.polygon([[[0, 0], [0, 0], [0, 0]]], {
  pane: "highlight",
  fill: false,
  color: "#ffd479",
  weight: 3,
  interactive: false,
})
let outlineOn = false

function showOutline(rings) {
  if (!rings || !rings.length) return hideOutline()
  outline.setLatLngs(rings.map((r) => [r.map(([lon, lat]) => [lat, lon])]))
  if (!outlineOn) { outline.addTo(map); outlineOn = true }
}

function hideOutline() {
  if (outlineOn) { map.removeLayer(outline); outlineOn = false }
}

// Is this territory lit by the current hover -- a region badge or a player row?
const lit = (id) =>
  highlight !== null && highlight.kind === "faction" && owner(id) === highlight.id

// ...or by the plan row under the pointer. Both ends of an attack or a move
// light up, because the order is the PAIR: "with 4 from Kenya" is unreadable
// without seeing which Kenya, and a highlight on the target alone leaves the
// arrow's tail unexplained.
const litOrder = (id) =>
  hoverOrder !== null && (id === hoverOrder.to || id === hoverOrder.from)

// Colour is the INTENT, not the actor: red into someone else's ground, green
// into your own. Declared HERE rather than beside the arrows that spend most of
// them, for a reason that is easy to miss -- paint() reads them and paint()
// runs during load, while the arrow section further down has not been reached
// yet, so a const declared there is still in its dead zone.
const ARROW_ATTACK = "#ff6a3d"
const ARROW_MOVE = "#35f0a0"

// The ring an order's ground wears while its row is hovered: the arrow's own
// colour, so the two ends and the line between them are one mark rather than
// three. A deploy is green like a reinforcement -- soldiers landing on ground
// you already hold is the same sentence with a shorter walk -- and a shield
// keeps the neutral gold, because it names ground without sending anyone.
//
// Weight 4 rather than the faction hover's 3, and the DEPLOY is why. Its target
// is always your own territory, whose resting edge is already a near-white 2;
// gold at 3 against that is a difference you have to hunt for, and a highlight
// you have to hunt for is not one.
const ORDER_RING_WEIGHT = 4
const orderRingColor = () =>
  hoverOrder === null
    ? null
    : hoverOrder.kind === "attack"
      ? ARROW_ATTACK
      : hoverOrder.kind === "protect"
        ? "#ffd479"
        : ARROW_MOVE

function paint() {
  const front = []
  for (const t of P.territories) {
    const l = layers[t.id]
    if (!l) continue
    // Name the drawn element after its territory, so anything asking "where is
    // Gauteng on screen" -- a browser check, a bug report, this file's own
    // debugging -- can select it instead of hovering every path to read the
    // tooltip back.
    //
    // HERE rather than at creation, for a reason worth stating precisely because
    // the obvious guess is wrong: Leaflet 1.9.4's setLatLngs calls redraw() and
    // KEEPS the same path element, tag and all (verified against the vendored
    // bundle), so element churn is not the hazard. What is: getElement() returns
    // undefined until the layer has been added and the renderer has built its
    // path, and tagging at creation left every territory untagged on this board.
    // paint() runs after the opening fit and after every geometry swap, so the
    // element always exists by then. The guard makes it a no-op on repaints.
    //
    // dataset rather than className, and the reason is narrower than "Leaflet
    // rewrites classes": a zoom does NOT touch a path's class list (verified --
    // leaflet-interactive plus a custom class both survive). What breaks is
    // ASSIGNING className, which clobbers whatever Leaflet put there; that is the
    // paintCounts bug, and it bit on marker icons, where the class it wiped
    // (leaflet-zoom-animated) is what repositions them. dataset cannot collide
    // with any of it.
    const el = l.getElement ? l.getElement() : null
    if (el && el.dataset.territory !== t.id) el.dataset.territory = t.id
    const isMine = mine(t.id)
    const isSel = selected === t.id
    const isLit = lit(t.id)
    // The order ring outranks the selection ring. A hover is transient and
    // answers the question being asked right now; the selection will still be
    // there, saying the same thing, the moment the pointer leaves.
    const ring = litOrder(t.id) ? orderRingColor() : null
    l.setStyle({
      fillColor: colorOf(owner(t.id)),
      color: ring ? ring : isSel ? "#fff" : isLit ? "#ffd479" : isMine ? "#e6edf3" : "#0b1a24",
      weight: ring ? ORDER_RING_WEIGHT : isSel ? 3.5 : isLit ? 3 : isMine ? 2 : 1,
      // Lit territories keep their fill and gain an edge. Dimming everything
      // else instead would repaint 70 shapes on every pointer move and make the
      // rest of the board unreadable exactly when you are comparing against it.
      fillOpacity: isMine ? 0.9 : 0.55,
    })
    if (isLit || ring) front.push(l)
  }
  // Same reason the selection comes forward: SVG has no z-index, so a
  // neighbour drawn later would paint over the highlighted edge.
  for (const l of front) if (l.bringToFront) l.bringToFront()

  if (highlight !== null && highlight.kind === "region") {
    showOutline((P.regionOutlines || {})[highlight.id])
  } else {
    hideOutline()
  }
  // The selected outline traces the real border, so it has to be drawn LAST.
  // SVG has no z-index: a neighbour added after it paints its own edge over the
  // shared boundary, and the highlight comes out broken along exactly the sides
  // that touch another territory — which is most of them.
  const sel = selected && layers[selected]
  if (sel && sel.bringToFront) sel.bringToFront()
  paintCounts()
}

// Open on the BOARD -- every playable territory, not the whole world and not
// only your own ground.
//
// Your own holdings were too tight to read: on day one they are a handful of
// scattered territories, so the map opened at a zoom where the front line was
// off screen and there was no way to tell where you sat relative to anyone
// else. The world is the opposite problem — most of it is grey backdrop
// nobody can act on. The board is the thing being played.
// ---- level of detail --------------------------------------------------------
// Coarse rings while the whole board is in frame, fine rings once you are close
// enough to see the difference.
//
// The board simplified at 0.15 degrees is about 15 km per chord. That vanishes
// when 70 territories fill the screen and turns every coastline into visible
// straight lines when you zoom in -- which is what makes a close view look
// wrong even though nothing is misplaced. The fine set costs three times the
// points, so it is only worth carrying at the zoom where it shows.
//
// Swapped on THRESHOLD CROSSING, not on every zoom: setLatLngs re-projects the
// layer, so doing it per step would cost more than the detail is worth.
const FINE_FROM_ZOOM = 5
let usingFine = false

function updateDetail() {
  const want = map.getZoom() >= FINE_FROM_ZOOM
  if (want === usingFine) return
  usingFine = want
  const src = want ? (P.shapesFine || P.shapes) : P.shapes
  for (const t of P.territories) {
    const l = layers[t.id]
    const rings = src[t.id]
    if (!l || !rings || !rings.length) continue
    l.setLatLngs(rings.map((r) => [r.map(([lon, lat]) => [lat, lon])]))
  }
  // Leaflet 1.9.4 redraws the existing SVG path here; its element, dataset and
  // setStyle values survive (verified against the vendored bundle). paint() is
  // still cheap, and reapplies the board's state deliberately after the shape
  // changes instead of depending on renderer behaviour across Leaflet upgrades.
  paint()
}

// zoomend ONLY, and this is the map's only listener.
//
// A territory's pixel size depends on the SCALE alone, so nothing but a zoom
// can change which counts fit: not panning, not hovering, not selecting. The
// two calls that move the map -- fitBounds on load and flyToBounds when you
// click a player -- are the only ones in the file, but they were never the only
// SOURCES of a zoom: Leaflet's own handlers (wheel, keyboard, the +/- control)
// move it too, and double click did until it was turned off above.
map.on("zoomend", () => { updateCountVisibility(); updateDetail() })

const played = P.territories.map((t) => layers[t.id]).filter(Boolean)
if (played.length) map.fitBounds(L.featureGroup(played).getBounds(), { padding: [24, 24] })
else map.setView([20, 0], 2)

// The opening fit is done, so hand interaction a snap grid. The fit needed
// zoomSnap 0 to fill the frame exactly -- it is what took the board from 54%
// of the width to 88% -- but keeping it costs a full zoom cycle per wheel
// notch forever after. Set it back and the same gesture lands on a handful of
// steps instead of dozens.
//
// Override with ?zoomsnap=N to compare: 0 is the old continuous behaviour, 1
// is Leaflet's default.
const snapParam = params.get("zoomsnap")
map.options.zoomSnap = snapParam === null ? 0.25 : Number(snapParam)
paint()
updateCountVisibility()
updateDetail()
placeRegionBadges()

// ---- hover wiring -----------------------------------------------------------

function setHighlight(kind, id) {
  const next = kind === null ? null : { kind: kind, id: id }
  const same =
    (next === null && highlight === null) ||
    (next !== null && highlight !== null && next.kind === highlight.kind && next.id === highlight.id)
  if (same) return
  highlight = next
  paint()
  syncRailHighlight()
}

// Mirror the map highlight back into the rail, so hovering a badge also shows
// WHO holds it -- the two panels answer the same question from opposite ends.
function syncRailHighlight() {
  for (const row of document.querySelectorAll("[data-faction]")) {
    const on =
      highlight !== null &&
      highlight.kind === "faction" &&
      row.getAttribute("data-faction") === highlight.id
    row.classList.toggle("lit", on)
  }
}

// Region hover by DELEGATION on the map container rather than a listener per
// badge. Leaflet owns those icon elements and may recreate them; mouseover and
// mouseout bubble, so one pair of listeners on a node we own cannot go stale.
const mapEl = document.getElementById("map")
if (mapEl) {
  mapEl.addEventListener("mouseover", (e) => {
    const el = e.target && e.target.closest && e.target.closest("[data-region]")
    if (el) setHighlight("region", el.getAttribute("data-region"))
  })
  mapEl.addEventListener("mouseout", (e) => {
    const el = e.target && e.target.closest && e.target.closest("[data-region]")
    if (el) setHighlight(null)
  })
}

// Clicking a player flies to their ground, padded well past it: a faction's
// territories are the question, but the answer is usually who is next to them.
function zoomToFaction(id) {
  const theirs = P.territories
    .filter((t) => owner(t.id) === id)
    .map((t) => layers[t.id])
    .filter(Boolean)
  if (!theirs.length) return
  map.flyToBounds(L.featureGroup(theirs).getBounds(), { padding: [70, 70], duration: 0.5 })
}

for (const row of document.querySelectorAll("[data-faction]")) {
  const id = row.getAttribute("data-faction")
  row.addEventListener("mouseenter", () => setHighlight("faction", id))
  row.addEventListener("mouseleave", () => setHighlight(null))
  row.addEventListener("click", () => zoomToFaction(id))
  // Keyboard reaches the same states; the rows are focusable for this.
  row.setAttribute("tabindex", "0")
  row.setAttribute("role", "button")
  row.addEventListener("focus", () => setHighlight("faction", id))
  row.addEventListener("blur", () => setHighlight(null))
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zoomToFaction(id) }
  })
}

// ---- acting ----------------------------------------------------------------
//
// One gesture, repeated: tap your own territory to select it, tap it again to
// put a soldier there. Every tap is worth exactly ONE soldier, so a slip costs
// one tap to undo rather than a re-typed number, and the plan pane carries a
// minus next to every line.
//
// It replaced a window.prompt asking for a count. A prompt is a modal that
// blocks the map you are deciding against, it cannot be undone, and on a phone
// it covers the board entirely.
//
// Once the reserve is spent, selecting stops meaning "deploy here" and starts
// meaning "attack from here": the arrows appear and the same second tap on a
// neighbour commits one soldier to that attack.

// Snapshot-based undo. The plan is small and flat, so storing whole copies is
// simpler than inverting each kind of edit, and it cannot drift from the thing
// it is undoing.
const history = []
const MAX_UNDO = 50

function snapshot() {
  history.push(JSON.stringify(plan))
  if (history.length > MAX_UNDO) history.shift()
}

function undo() {
  const prev = history.pop()
  if (prev === undefined) return flash("Nothing to undo.")
  plan = JSON.parse(prev)
  if (!plan.moves) plan.moves = []
  save()
  drawArrows()
}

/**
 * Everything tonight's orders may draw on: what is banked, plus what the board
 * pays at the tick.
 *
 * The income half is not optimism. The engine grants at step 1 and allocates
 * claims at step 3 of the same tick, so a deploy funded by tonight's income is
 * legal -- and budgeting against the banked reserve alone meant that on day 1,
 * when createSeason leaves every faction at zero, nobody could place a soldier
 * or stake a wager at all. The rules panel promised otherwise on the same page.
 *
 * It is a FLOOR: workouts, wager payouts and rule grants land at the tick too
 * and none of them is knowable while a plan is being written. Spending past it
 * is not a disaster -- the engine drops what does not fit, wagers senior -- so
 * the number to budget against is the one the player can count on.
 */
const budget = () => P.reserve + P.income

/** Soldiers not yet committed. Attacks come from garrisons, not the reserve. */
const unspent = () => budget() - spent()

function deployTo(id) {
  if (unspent() <= 0) return false
  snapshot()
  const existing = plan.deploys.find((d) => d.territory === id)
  if (existing) existing.count += 1
  else plan.deploys.push({ territory: id, count: 1 })
  save()
  return true
}

// ---- the attack panel -------------------------------------------------------
// Deploys stay one-per-tap -- each one is a small decision made against the
// map. An assault is ONE decision about a number, and ten taps to express "ten
// soldiers" is busywork, so tapping a neighbour opens a compact panel: slider
// for the sweep, the exact count beside it, Okay to commit. It floats at the
// foot of the map rather than over its middle, and Esc or Cancel closes it
// without changing anything.
let atkPending = null

function openMove(from, to) {
  const el = $("atk")
  if (!el) return
  atkPending = { from: from, to: to, kind: "move" }
  const max = originCap(from, to)
  const existing = plan.moves.find((m) => m.from === from && m.to === to)
  if (max <= 0 && !existing) {
    atkPending = null
    return flash("Nothing left in " + nameOf(from) + " to send.")
  }
  const slider = $("atk-slider")
  slider.max = String(Math.max(max, existing ? existing.count : 0))
  slider.min = existing ? "0" : "1"
  slider.value = String(existing ? existing.count : Math.min(1, max))
  $("atk-from").textContent = nameOf(from)
  $("atk-from-g").textContent = plannedGarrison(from) + " there"
  $("atk-to").textContent = nameOf(to)
  $("atk-to-g").textContent = plannedGarrison(to) + " there"
  $("atk-n").textContent = slider.value
  $("atk-need").hidden = true
  $("atk-select").hidden = false
  paintVerdict()
  el.hidden = false
  slider.focus()
}

// What an origin can still send at TARGET, mirroring the engine's own rule:
// the aggregate of attacks from one origin is capped at its POST-DEPLOY
// garrison minus one, so tonight's deploys into a launch point raise the
// ceiling and every other attack already planned from it lowers it. The
// engine enforces this at the tick regardless -- an over-committed second
// attack is rejected there, publicly, in the recap. This mirror exists so the
// panel cannot draw an order that is already doomed: it used to cap each
// attack independently at garrison - 1, which let 7 + 7 leave a garrison of 8
// on paper and die at the tick.
function originCap(from, target) {
  const deployed = plan.deploys
    .filter((d) => d.territory === from)
    .reduce((n, d) => n + d.count, 0)
  const others = plan.attacks
    .filter((a) => a.from === from && a.to !== target)
    .reduce((n, a) => n + a.count, 0)
  const moved = plan.moves
    .filter((m) => m.from === from && m.to !== target)
    .reduce((n, m) => n + m.count, 0)
  return Math.max(0, (P.garrisons[from] ?? 0) + deployed - 1 - others - moved)
}

function openAttack(from, to) {
  const el = $("atk")
  if (!el) return
  atkPending = { from: from, to: to, kind: "attack" }
  const max = originCap(from, to)
  const existing = plan.attacks.find((a) => a.from === from && a.to === to)
  $("atk-select").hidden = true
  if (max <= 0 && !existing) {
    atkPending = null
    return flash("Nothing left in " + nameOf(from) + " to attack with.")
  }
  const slider = $("atk-slider")
  slider.max = String(max)
  // 0 is a real choice when an attack already exists: it means call it off.
  slider.min = existing ? "0" : "1"
  slider.value = String(existing ? existing.count : Math.min(1, max))
  $("atk-from").textContent = nameOf(from)
  $("atk-from-g").textContent = (P.garrisons[from] ?? 0) + " there"
  $("atk-to").textContent = nameOf(to)
  $("atk-to-g").textContent = (P.garrisons[to] ?? 0) + " defending"
  $("atk-n").textContent = slider.value

  // The tick: the smallest force that TAKES the territory. The engine holds a
  // target on total <= defense, so defense + 1 captures and the casualties
  // total exactly the defense. Marked as "if nothing changes": resolution is
  // simultaneous, so tonight's enemy deploys or a rival attack on the same
  // territory move the real number, and the engine is the only judge.
  atkPending.need = (P.garrisons[to] ?? 0) + 1
  const need = atkPending.need
  const min = Number(slider.min)
  const tick = $("atk-need")
  if (need <= max) {
    const frac = max === min ? 1 : (need - min) / (max - min)
    tick.style.left = (frac * 100).toFixed(1) + "%"
    tick.querySelector("b").textContent = String(need)
    tick.hidden = false
  } else {
    tick.hidden = true
  }
  paintVerdict()
  el.hidden = false
  slider.focus()
}

// Below the slider, in words, so the tick never has to be decoded: taking,
// weakening, or calling it off.
function paintVerdict() {
  const v = $("atk-verdict")
  if (!v || !atkPending) return
  const c = $("atk-caveat")
  const n = Math.floor(Number($("atk-slider").value))
  if (atkPending.kind === "move") {
    v.textContent = n <= 0 ? "No move." : "Reinforces " + nameOf(atkPending.to) + " before any fighting tonight."
    v.classList.toggle("takes", n > 0)
    // Troops ordered out have already gone, so the origin defends without them.
    if (c) c.textContent = n <= 0 ? "" : nameOf(atkPending.from) + " defends tonight without them."
    return
  }
  const need = atkPending.need
  const d = P.garrisons[atkPending.to] ?? 0
  if (n <= 0) v.textContent = "No attack."
  else if (n >= need) v.textContent = "Takes it with " + (n - d) + " if nothing changes tonight."
  else v.textContent = "Falls short — weakens the garrison to " + (d - n) + "."
  v.classList.toggle("takes", n >= need)
  // ALWAYS conditional. Whether they ordered an attack back is deliberately not
  // in the projection, so this states the rule and never guesses the outcome.
  if (c) {
    c.textContent =
      n <= 0
        ? ""
        : "If they attack " + nameOf(atkPending.from) + " too, the smaller force dies outright."
  }
}

function closeAttack() {
  const el = $("atk")
  if (el) el.hidden = true
  atkPending = null
}

function commitAttack() {
  if (!atkPending) return
  const n = Math.floor(Number($("atk-slider").value))
  snapshot()
  const list = atkPending.kind === "move" ? plan.moves : plan.attacks
  const i = list.findIndex((x) => x.from === atkPending.from && x.to === atkPending.to)
  if (n <= 0) {
    if (i >= 0) list.splice(i, 1)
  } else if (i >= 0) {
    list[i].count = n
  } else {
    list.push({ from: atkPending.from, to: atkPending.to, count: n })
  }
  closeAttack()
  save()
}

function onTap(id) {
  if (P.locked) return

  // Out of the game: a tap picks a shield target, anyone's, and that is all.
  if (eliminated) {
    if (!canVeto) return flash("You are out, and the veto is off this season.")
    selected = id
    paint()
    render()
    return
  }

  if (mine(id)) {
    if (selected !== id) {
      // An ADJACENT own territory is a reinforcement target ONCE THE SOLDIERS
      // ARE PLACED; while any are still in hand it just moves the selection, so
      // the next tap deploys there. Same line the arrows draw -- they appear at
      // unspent() zero "because that is when the question changes from where do
      // these go to where do I send them" -- and the tap has to answer the same
      // question they do.
      //
      // It read as a reinforcement unconditionally until day 1 of season 1,
      // where it was reported within the hour: nobody had ever tapped this
      // branch with soldiers in hand, because until tonight's income was
      // budgeted a day-1 player never had any.
      //
      // The panel's "Select instead" remains the escape hatch the other way.
      if (
        unspent() <= 0 &&
        selected &&
        mine(selected) &&
        byId[selected].neighbors.includes(id)
      ) {
        openMove(selected, id)
        return
      }
      selected = id
      paint()
      drawArrows()
      render()
      return
    }
    // Tapping the selection again spends a soldier on it. With none left, the
    // second tap is what reveals where they can go instead.
    if (!deployTo(id)) {
      flash("No soldiers left to deploy. Tap a neighbour to attack it.")
      drawArrows()
    }
    return
  }

  if (!selected) return flash("Pick one of your territories first.")
  if (!byId[selected].neighbors.includes(id)) {
    // Out of reach means "never mind", not an error. Holding the selection left
    // the only way to let go of a territory being to find another of your own
    // to tap -- and on a phone the flash sits in the rail behind the map, so
    // the board looked like it had ignored the tap. Still says why; the
    // selection simply goes with it.
    flash(nameOf(id) + " does not border " + nameOf(selected) + ".")
    selected = null
    paint()
    drawArrows()
    render()
    return
  }
  openAttack(selected, id)
}

// ---- movement arrows --------------------------------------------------------
// Shown once the reserve is spent, because that is when the question changes
// from "where do these go" to "where do I send them". Each arrow points at a
// neighbour you could send soldiers to; tapping one is the same as tapping the
// territory beneath it.
//
// Colour is the INTENT, not the actor: red into someone else's ground, green
// into your own. Both still mean "tonight, if your orders happen" -- the same
// voice the gold planned garrison count speaks in -- but the two gestures cost
// different things, and a player reads the difference faster than a label.
//
// They are drawn as arcs rather than straight runs so that several arrows off
// one origin fan apart instead of stacking, and each carries a dark casing with
// a drop shadow, which is what lifts it clear of the territory underneath.
// Both are hotter than any territory fill, and that is the point rather than a
// taste. Faction colours are golden-angle hues at 46% saturation, so one seat
// each season IS crimson and another IS green -- and an arrow leaves from your
// own ground, which is the seat whose colour it is most likely to sit on. A
// deeper red (#e2564c) vanished into the crimson seat's territories and a
// leafier green (#3fb87a) vanished into the green seat's, both confirmed in a
// browser. A reinforcement arrow is the sharper case: it runs between two of
// YOUR territories, so it spends its whole length on the one colour it is most
// likely to disappear into.
// The two hexes are declared with the state, above paint() -- see there.

const arrowLines = []
const arrowMarks = []

// A quadratic Bezier from 'a' toward 'b', sampled in lat/lon and truncated at
// 'end' so the head stops short of the garrison count it points at. The control
// point is the midpoint pushed perpendicular to the run, always to the same
// side, so the fan is consistent rather than arbitrary. Pure arithmetic on
// degrees: no projection, so the curve is fixed once and never re-sampled.
const ARC_BOW = 0.18
const ARC_STEPS = 16

function arcPoints(a, b, end) {
  const dLat = b.lat - a.lat
  const dLon = b.lon - a.lon
  const c = {
    lat: (a.lat + b.lat) / 2 + dLon * ARC_BOW,
    lon: (a.lon + b.lon) / 2 - dLat * ARC_BOW,
  }
  const out = []
  for (let i = 0; i <= ARC_STEPS; i++) {
    const s = (i / ARC_STEPS) * end
    const u = 1 - s
    out.push([
      u * u * a.lat + 2 * u * s * c.lat + s * s * b.lat,
      u * u * a.lon + 2 * u * s * c.lon + s * s * b.lon,
    ])
  }
  return out
}

function clearArrows() {
  for (const l of arrowLines) map.removeLayer(l)
  for (const m of arrowMarks) map.removeLayer(m)
  arrowLines.length = 0
  arrowMarks.length = 0
}

/** Where an arrow touches a territory: its label anchor, or its centre. */
const aimOf = (id) => (P.labels || {})[id] || P.centres[id]

// One arc -- casing, line and head -- pushed into the caller's own arrays.
// Shared by the neighbour fan and the plan-row hover on purpose: the hover's
// whole job is to say "this is the arrow that order draws", so the two must be
// the same drawing, not two that look alike until one of them is edited.
// 'tap' is null for the hover, which is a readout rather than a control.
function addArrow(from, to, color, tap, lines, marks) {
  // Stop short of the target so the head sits in open ground rather than on
  // top of the garrison count it is pointing at.
  const pts = arcPoints(from, to, 0.72)
  const tip = pts[pts.length - 1]

  // Casing first: it is wider, carries the shadow, and being underneath makes
  // it the fatter tap target for the same gesture.
  const cast = L.polyline(pts, {
    pane: "highlight", className: "arrow-cast",
    color: "#0b1a24", weight: 6, opacity: 0.55,
  }).addTo(map)
  if (tap) cast.on("click", tap)
  lines.push(cast)

  const line = L.polyline(pts, {
    pane: "highlight", color: color, weight: 2.5, opacity: 0.95,
  }).addTo(map)
  if (tap) line.on("click", tap)
  lines.push(line)

  // The head takes the bearing of the curve's LAST segment, not of the whole
  // run: on an arc those differ, and the straight bearing points the head off
  // the line it is meant to cap. Layer points rather than degrees, because
  // the projection is what decides which way the tip actually leans.
  const prev = pts[pts.length - 2] || [from.lat, from.lon]
  const a = map.latLngToLayerPoint(prev)
  const b = map.latLngToLayerPoint(tip)
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  const mark = L.marker(tip, {
    pane: "highlight",
    keyboard: false,
    icon: L.divIcon({
      className: "arrow",
      html:
        '<span class="arrow-head" style="border-left-color:' + color +
        ';transform:rotate(' + deg.toFixed(1) + 'deg)"></span>',
      iconSize: null,
      iconAnchor: null,
    }),
  }).addTo(map)
  if (tap) {
    const el = mark.getElement()
    if (el) el.addEventListener("click", tap)
  }
  marks.push(mark)
}

function drawArrows() {
  clearArrows()
  // Only ever out of your OWN ground. An eliminated player selects anyone's
  // territory to shield it and has a reserve of zero, which cleared the spend
  // gate and drew a fan of routes off a stranger's border.
  if (P.locked || !selected || !mine(selected) || unspent() > 0) return
  const from = aimOf(selected)
  if (!from) return

  for (const n of byId[selected].neighbors) {
    const to = aimOf(n)
    if (!to) continue
    const color = mine(n) ? ARROW_MOVE : ARROW_ATTACK
    addArrow(from, to, color, () => onTap(n), arrowLines, arrowMarks)
  }
}

// ---- the hovered order ------------------------------------------------------
// A saved order is a sentence in the rail: "Attack Kenya from Tanzania with 4".
// Hovering it draws the same sentence on the board -- both territories lit, and
// for the two orders that MOVE soldiers, the arrow the fan would have drawn,
// in the colour that already means what it means here. Nothing new to learn.
//
// Its own layer arrays rather than the fan's, because the two are live at
// different times and clearing one must never clear the other: the fan needs a
// selection and a spent reserve, the hover needs neither.
const hoverLines = []
const hoverMarks = []

function clearHoverArrow() {
  for (const l of hoverLines) map.removeLayer(l)
  for (const m of hoverMarks) map.removeLayer(m)
  hoverLines.length = 0
  hoverMarks.length = 0
}

function drawHoverArrow() {
  clearHoverArrow()
  // A deploy and a shield name one territory and no route, so they light the
  // ground and draw nothing. An arrow from nowhere would be a lie about what
  // the order does.
  if (hoverOrder === null || !hoverOrder.from) return
  const from = aimOf(hoverOrder.from)
  const to = aimOf(hoverOrder.to)
  if (!from || !to) return
  addArrow(
    from, to,
    hoverOrder.kind === "attack" ? ARROW_ATTACK : ARROW_MOVE,
    null, hoverLines, hoverMarks,
  )
}

function setHoverOrder(next) {
  const same =
    (next === null && hoverOrder === null) ||
    (next !== null && hoverOrder !== null &&
      next.kind === hoverOrder.kind && next.from === hoverOrder.from && next.to === hoverOrder.to)
  if (same) return
  hoverOrder = next
  paint()
  drawHoverArrow()
}

function protect() {
  // Living factions cannot veto at all; the engine rejects it with "faction is
  // not eliminated". The button is disabled for them, so this is the belt to
  // that braces.
  if (!canVeto) return flash("A shield is only for a player with nothing left.")
  if (!selected) return flash("Tap any territory to shield it.")
  snapshot()
  plan.protect = plan.protect === selected ? null : selected
  save()
}

/** Adjust one line of the plan by +1, -1, or remove it entirely. */
function adjust(kind, i, delta) {
  snapshot()
  // The row under the pointer is about to be rebuilt. Stepping a count leaves
  // it naming the same two territories, so the highlight is still true; a
  // REMOVAL leaves it naming an order that no longer exists, and no mouseover
  // is guaranteed to fire under a pointer that never moved.
  let gone = false
  if (kind === "protect") {
    plan.protect = null
    gone = true
  } else {
    const list = kind === "deploy" ? plan.deploys : kind === "move" ? plan.moves : plan.attacks
    const entry = list[i]
    if (!entry) return
    if (delta === 0) { list.splice(i, 1); gone = true }
    else {
      // A deploy cannot grow past what is left in the reserve, and an attack
      // cannot grow past what its origin can still send -- the same per-origin
      // cap the engine applies at the tick.
      if (delta > 0 && kind === "deploy" && unspent() <= 0) return flash("No soldiers left.")
      if (
        delta > 0 &&
        (kind === "attack" || kind === "move") &&
        entry.count >= originCap(entry.from, entry.to)
      ) {
        return flash("Nothing left in " + nameOf(entry.from) + " to send.")
      }
      entry.count += delta
      if (entry.count <= 0) { list.splice(i, 1); gone = true }
    }
  }
  if (gone) setHoverOrder(null)
  save()
  drawArrows()
}

// ---- saving ----------------------------------------------------------------
// Autosave, and a failure is LOUD and stays loud. A silent write failure costs
// a season, and it is the worst thing this page can do.
let inflight = null
function save() {
  render()
  drawArrows()
  paintCounts()
  saveState = "saving"
  render()
  const body = JSON.stringify(plan)
  inflight = fetch("/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      saveState = ok && j.ok ? "saved" : "error:" + (j.reason || "rejected")
      render()
    })
    .catch(() => {
      saveState = "error:offline"
      render()
    })
}

let flashMsg = ""
function flash(m) {
  flashMsg = m
  render()
  setTimeout(() => { if (flashMsg === m) { flashMsg = ""; render() } }, 4000)
}

// ---- rendering -------------------------------------------------------------
function countdown() {
  if (P.locked) return "Orders are locked. Resolving tonight."
  const ms = Math.max(0, P.msToTick - (Date.now() - P.loadedAt))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return "Resolves in " + h + "h " + String(m).padStart(2, "0") + "m"
}

function render() {
  $("countdown").textContent = countdown()
  $("countdown").className = P.locked ? "count locked" : "count"

  const rows = []
  plan.deploys.forEach((d, i) =>
    rows.push(row("deploy", i, "Deploy " + d.count + " to " + esc(nameOf(d.territory)), true,
      null, d.territory)))
  plan.attacks.forEach((a, i) =>
    rows.push(row("attack", i, "Attack " + esc(nameOf(a.to)) + " from " + esc(nameOf(a.from)) + " with " + a.count, true,
      a.from, a.to)))
  plan.moves.forEach((m, i) =>
    rows.push(row("move", i, "Move " + m.count + " from " + esc(nameOf(m.from)) + " to " + esc(nameOf(m.to)), true,
      m.from, m.to)))
  if (plan.protect) rows.push(row("protect", 0, "Protect " + esc(nameOf(plan.protect)), false,
    null, plan.protect))
  const emptyPlan = eliminated
    ? "Nothing yet. Pick a territory to Protect."
    : "No orders yet. Tap one of your territories."
  $("plan").innerHTML = rows.length ? rows.join("") : '<p class="hint">' + emptyPlan + "</p>"

  const left = unspent()
  const total = budget()
  // The over-budget hint names WHICH orders give way: under claim seniority
  // the wagers are locked at their market's close, so a short reserve drops
  // deploys, not wagers. Without this line the first player whose later
  // wagers push a saved plan negative files the allocation as a bug.
  $("reserve").textContent =
    left < 0 ? left + " of " + total + " — wagers are locked; deploys give way" : left + " of " + total
  $("reserve").className = left < 0 ? "n over" : "n"

  const s = $("save")
  if (saveState === "saved") { s.textContent = "saved"; s.className = "save ok" }
  else if (saveState === "saving") { s.textContent = "saving…"; s.className = "save" }
  else { s.textContent = "NOT SAVED — " + saveState.slice(6); s.className = "save bad" }

  // An eliminated player can do exactly one thing, so neither the deploy nor
  // the attack prompt applies to them.
  $("selected").textContent = selected
    ? nameOf(selected) +
      (eliminated
        ? plan.protect === selected
          ? " — protected tonight"
          : " — press Protect to shield it"
        : left > 0
          ? " — tap again to add a soldier"
          : " — tap a neighbour to attack or reinforce")
    : eliminated
      ? "nothing selected — tap any territory"
      : "nothing selected"
  $("flash").textContent = flashMsg
  $("btn-protect").disabled = !canVeto || !selected || P.locked
  $("btn-undo").disabled = history.length === 0 || P.locked
}

// 'from' and 'to' are the GROUND the order names, carried on the row so the
// hover can read it back without a second copy of the plan to index into --
// the same reason the buttons carry their kind and index.
function row(kind, i, text, steppable, from, to) {
  const btn = (delta, glyph, label) =>
    '<button data-kind="' + kind + '" data-i="' + i + '" data-delta="' + delta +
    '" aria-label="' + label + '">' + glyph + '</button>'
  return '<div class="prow" data-order="' + kind + '"' +
    (from ? ' data-from="' + esc(from) + '"' : "") + ' data-to="' + esc(to) + '">' +
    '<span>' + text + '</span><span class="pbtns">' +
    (steppable ? btn(-1, "−", "one fewer") + btn(1, "+", "one more") : "") +
    btn(0, "×", "remove") + '</span></div>'
}

$("plan").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]")
  if (b) adjust(b.dataset.kind, Number(b.dataset.i), Number(b.dataset.delta))
})

// Hover by DELEGATION, for the reason the region badges use it: render()
// replaces this list's whole innerHTML on every keystroke of the plan, so a
// listener per row would be stale the moment anything changed.
//
// mouseover plus mouseleave rather than mouseover/mouseout: mouseout fires on
// the way into a row's OWN stepper buttons, and clearing there would strobe the
// highlight off and on as the pointer crossed them. mouseover alone answers
// "what is under the pointer now" -- including the gaps between rows, which
// resolve to no order -- and mouseleave is bound to the list itself.
$("plan").addEventListener("mouseover", (e) => {
  const el = e.target && e.target.closest ? e.target.closest("[data-order]") : null
  setHoverOrder(el === null ? null : {
    kind: el.getAttribute("data-order"),
    from: el.getAttribute("data-from"),
    to: el.getAttribute("data-to"),
  })
})
$("plan").addEventListener("mouseleave", () => setHoverOrder(null))
$("btn-protect").addEventListener("click", protect)
$("btn-undo").addEventListener("click", undo)

/*
 * Renaming. The faction id never moves -- the server passes the existing one
 * straight back to the roster -- so nothing on the board needs re-deriving. The
 * only thing that changes is the label, and the standings row for the viewer,
 * both of which read from P.factions.
 */
;(function () {
  const form = $("rename")
  const input = $("rename-input")
  const button = $("btn-rename")
  const open = function (on) {
    form.hidden = !on
    button.hidden = on
    if (on) {
      const me = P.factions.filter(function (f) { return f.id === P.factionId })[0]
      input.value = me ? me.name : ""
      input.focus()
      input.select()
    }
  }
  button.addEventListener("click", function () { open(true) })
  $("rename-cancel").addEventListener("click", function () { open(false) })
  form.addEventListener("submit", function (e) {
    e.preventDefault()
    const wanted = input.value
    fetch("/api/name", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: wanted }),
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b } }) })
      .then(function (res) {
        if (!res.ok || !res.body.ok) {
          return flash(res.body && res.body.reason ? res.body.reason : "could not save that name")
        }
        // The SERVER's name, not the typed one: it trims and collapses
        // whitespace, so echoing the input would show something the database
        // does not hold.
        for (const f of P.factions) if (f.id === P.factionId) f.name = res.body.name
        button.textContent = res.body.name
        open(false)
        flash("You're " + res.body.name + " now.")
        render()
      })
      .catch(function () { flash("Offline — name not saved.") })
  })
})()
$("atk-slider").addEventListener("input", () => {
  $("atk-n").textContent = $("atk-slider").value
  paintVerdict()
})
$("atk-ok").addEventListener("click", commitAttack)
$("atk-select").addEventListener("click", () => {
  const to = atkPending && atkPending.to
  closeAttack()
  if (to) {
    selected = to
    paint()
    drawArrows()
    render()
  }
})
$("atk-cancel").addEventListener("click", closeAttack)

// Cmd+Z / Ctrl+Z, because every order here is built one tap at a time and undo
// is the whole safety net. Shift+Cmd+Z is left alone rather than wired to a
// redo that does not exist -- swallowing it would be worse than ignoring it.
//
// Guarded on the event target: if a text field ever lands in the rail, the
// browser's own undo has to keep working inside it.
document.addEventListener("keydown", (e) => {
  if ((e.key || "") === "Escape") {
    // Escape peels ONE layer at a time, outermost first: the attack/move panel
    // if it is open, otherwise the selection. Clearing both at once would let a
    // cancelled assault also drop the territory it was launched from, which is
    // the one thing the panel's own Cancel has never done.
    //
    // The wagers sheet owns the key while it is open -- its handler is bound
    // separately below -- so this leaves the selection alone underneath it.
    if (atkPending) return closeAttack()
    const sheet = $("wagers")
    if (sheet && !sheet.hidden) return
    if (!selected) return
    selected = null
    paint()
    drawArrows()
    render()
    return
  }
  const k = e.key || ""
  if (k.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey) return
  const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : ""
  if (tag === "input" || tag === "textarea" || (e.target && e.target.isContentEditable)) return
  e.preventDefault()
  undo()
})

// ---- wagers ----------------------------------------------------------------
// Folded into the board's client rather than kept as its own page script,
// because a wager and a deploy draw on the SAME reserve. spent() above has
// always counted both; a separate page counted wagers alone, so a player could
// plan deploys here and stake the whole reserve there with neither objecting --
// and the tick then dropped the deploys, silently, because wagers lock earlier
// and are senior.
const WG = window.__RRW__ || { bonus: 1.1, odds: {} }

// Live stakes, read off the panel rather than P.wagers: the player may have
// changed them since the page loaded and not yet saved.
function stakedNow() {
  let total = 0
  for (const el of document.querySelectorAll("#wagers .stake")) total += Number(el.textContent) || 0
  return total
}

// The reserve after deploys AND wagers. P.wagers is what the server last saved;
// the panel is what is on screen, so the saved figure is swapped out for the
// live one to avoid counting the same stake twice.
function reserveLeft() {
  const savedStakes = P.wagers.reduce((n, w) => n + w.stake, 0)
  return budget() - (spent() - savedStakes) - stakedNow()
}

function sideOfRow(row) {
  const on = row.querySelector('.side[aria-pressed="true"]')
  return on ? on.getAttribute("data-side") : null
}

/**
 * What this stake pays if it wins.
 *
 * The SAME expression as the engine's payout(), in the same order, against
 * prices the server already clamped with the engine's own bounds. Written as
 * (stake / p) * bonus rather than stake * (bonus / p) on purpose: the two
 * differ in the last bit and can land either side of a round() sitting on .5.
 */
function paintPayout(row) {
  const el = row.querySelector(".payout")
  if (!el) return
  const o = WG.odds[row.getAttribute("data-market")]
  const side = sideOfRow(row)
  const stake = Number(row.querySelector(".stake").textContent) || 0
  if (!o || !side || stake <= 0) { el.textContent = ""; return }
  const win = Math.round((stake / o[side]) * WG.bonus)
  // Profit as well as the total: "wins 9" on a stake of 5 reads as either 9
  // back or 14 back until you say which.
  el.textContent = "wins " + win + " (+" + (win - stake) + ")"
}

function paintWagers() {
  const left = reserveLeft()
  const none = left <= 0
  for (const b of document.querySelectorAll('#wagers .step[data-delta="1"]')) b.disabled = none
  for (const row of document.querySelectorAll("#wagers .bet")) paintPayout(row)
  const el = $("wagers-left")
  if (el) el.textContent = String(left)
}

function betState(row, text, bad) {
  const el = row.querySelector(".bet-state")
  if (!el) return
  el.textContent = text
  el.className = "hint bet-state" + (bad ? " save bad" : "")
}

function saveWager(row) {
  const marketId = row.getAttribute("data-market")
  const stake = Number(row.querySelector(".stake").textContent) || 0
  const side = sideOfRow(row)
  // A stake of zero is not a wager and there is no delete endpoint, so say so
  // rather than posting something the server would refuse.
  if (stake <= 0) return betState(row, side ? "pick a stake" : "", false)
  if (!side) return betState(row, "pick a side", false)
  betState(row, "saving...", false)
  fetch("/api/wager", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marketId: marketId, side: side, stake: stake }),
  })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b } }) })
    .then(function (res) {
      if (!res.ok) return betState(row, res.body && res.body.reason ? res.body.reason : "not saved", true)
      betState(row, "saved", false)
      // Adopt the saved stake so the shared reserve stops double-counting it.
      const existing = P.wagers.filter(function (w) { return w.marketId !== marketId })
      existing.push({ marketId: marketId, side: side, stake: stake, firstStakedAt: "" })
      P.wagers = existing
      render()
    })
    .catch(function () { betState(row, "not saved -- offline?", true) })
}

const sheet = $("wagers")
if (sheet) {
  const open = (on) => {
    sheet.hidden = !on
    // Bookmarkable: #wager reopens it on load. replaceState rather than a hash
    // assignment so closing it does not stack history entries you must press
    // back through.
    // window.history, NOT history: this file declares its own history array
    // for undo (see MAX_UNDO), which shadows the global. Bare
    // history.replaceState is undefined here, and the resulting throw left the
    // sheet open with the URL untouched -- and killed the deep-link line at
    // the end of this block, so #wager did not reopen it either.
    window.history.replaceState(null, "", on ? "#wager" : location.pathname)
    if (on) paintWagers()
  }
  $("btn-wagers").addEventListener("click", () => open(true))
  $("wagers-close").addEventListener("click", () => open(false))
  sheet.addEventListener("click", (e) => { if (e.target === sheet) open(false) })
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) open(false) })

  sheet.addEventListener("click", function (e) {
    const btn = e.target.closest ? e.target.closest("button") : null
    if (!btn) return
    const row = btn.closest ? btn.closest(".bet") : null
    if (!row) return

    if (btn.classList.contains("side")) {
      const already = btn.getAttribute("aria-pressed") === "true"
      for (const t of row.querySelectorAll(".side")) t.removeAttribute("aria-pressed")
      // Tapping the chosen side again clears it -- the only way to say "not
      // decided" once you have touched the row.
      if (!already) btn.setAttribute("aria-pressed", "true")
      paintWagers()
      saveWager(row)
      return
    }

    if (btn.classList.contains("step")) {
      const out = row.querySelector(".stake")
      const delta = Number(btn.getAttribute("data-delta"))
      // Never past the reserve, counting deploys too. Raising it further would
      // commit soldiers that do not exist.
      if (delta > 0 && reserveLeft() <= 0) return
      out.textContent = String(Math.max(0, (Number(out.textContent) || 0) + delta))
      paintWagers()
      render()
      // Debounced: holding + would post once per tap, and each post re-prices.
      clearTimeout(row.__t)
      row.__t = setTimeout(function () { saveWager(row) }, 450)
    }
  })

  // On load, and on any later hash change. The second is not redundant:
  // following a #wager link from within the page is a SAME-DOCUMENT
  // navigation, so the script does not re-run and only this event fires.
  const syncToHash = () => open(location.hash === "#wager")
  window.addEventListener("hashchange", syncToHash)
  if (location.hash === "#wager") open(true)
  paintWagers()
}

P.loadedAt = Date.now()
setInterval(() => { $("countdown").textContent = countdown() }, 30000)

// ---- reload once the night lands -------------------------------------------
// A board left open through midnight shows yesterday's map until someone thinks to
// refresh, and the countdown hitting zero is NOT the signal to reload: the tick
// fires at 00:05 and the transaction takes a moment, so a reload on the
// countdown races it and lands on the same stale board -- then never tries
// again. So poll for the day actually RESOLVING, which is a fact, not a
// prediction.
//
// Only after the lock, and it stops the moment it fires: no polling all
// afternoon while orders are still editable, and no request loop on a page
// nobody closed for a week.
var pollTimer = 0
function pollForTick() {
  fetch("/api/day", { headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (d) {
      if (d && Number(d.resolved) > P.resolvedDay) {
        clearInterval(pollTimer)
        // A hard reload, not a redirect: the board's own markup decides whether
        // the new night is unwatched and sends them to the replay itself.
        location.reload()
      }
    })
    .catch(function () {})
}
function watchForTick() {
  if (pollTimer) return
  pollTimer = setInterval(pollForTick, 20000)
  pollForTick()
}
if (P.locked) watchForTick()
else setTimeout(watchForTick, Math.max(0, P.msToTick) + 15000)

render()
})()
`
