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
let saveState = "saved"

const mine = (id) => P.ownership[id] === P.factionId
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

function paint() {
  const front = []
  for (const t of P.territories) {
    const l = layers[t.id]
    if (!l) continue
    const isMine = mine(t.id)
    const isSel = selected === t.id
    const isLit = lit(t.id)
    l.setStyle({
      fillColor: colorOf(owner(t.id)),
      color: isSel ? "#fff" : isLit ? "#ffd479" : isMine ? "#e6edf3" : "#0b1a24",
      weight: isSel ? 3.5 : isLit ? 3 : isMine ? 2 : 1,
      // Lit territories keep their fill and gain an edge. Dimming everything
      // else instead would repaint 70 shapes on every pointer move and make the
      // rest of the board unreadable exactly when you are comparing against it.
      fillOpacity: isMine ? 0.9 : 0.55,
    })
    if (isLit) front.push(l)
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
  // setLatLngs rebuilds the path, which drops the styling paint() applied.
  paint()
}

// zoomend ONLY, and this is the map's only listener.
//
// A territory's pixel size depends on the SCALE alone, so nothing but a zoom
// can change which counts fit: not panning, not hovering, not selecting. The
// two calls that move the map -- fitBounds on load and flyToBounds when you
// click a player -- are the only ones in the file.
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

/** Soldiers not yet committed. Attacks come from garrisons, not the reserve. */
const unspent = () => P.reserve - spent()

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

  if (mine(id)) {
    if (selected !== id) {
      // An ADJACENT own territory is a reinforcement target; anywhere else of
      // yours just moves the selection. The panel's "Select instead" is the
      // escape hatch for when the tap meant selection after all.
      if (selected && mine(selected) && byId[selected].neighbors.includes(id)) {
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
    return flash(nameOf(id) + " does not border " + nameOf(selected) + ".")
  }
  openAttack(selected, id)
}

// ---- attack arrows ----------------------------------------------------------
// Shown once the reserve is spent, because that is when the question changes
// from "where do these go" to "where do I send them". Each arrow points at a
// neighbour you could attack; tapping one is the same as tapping the territory.
const arrowLines = []
const arrowMarks = []

function clearArrows() {
  for (const l of arrowLines) map.removeLayer(l)
  for (const m of arrowMarks) map.removeLayer(m)
  arrowLines.length = 0
  arrowMarks.length = 0
}

function drawArrows() {
  clearArrows()
  if (P.locked || !selected || unspent() > 0) return
  const from = (P.labels || {})[selected] || P.centres[selected]
  if (!from) return

  for (const n of byId[selected].neighbors) {
    if (mine(n)) continue
    const to = (P.labels || {})[n] || P.centres[n]
    if (!to) continue
    // Stop short of the target so the head sits in open ground rather than on
    // top of the garrison count it is pointing at.
    const t = 0.72
    const tip = { lat: from.lat + (to.lat - from.lat) * t, lon: from.lon + (to.lon - from.lon) * t }
    const line = L.polyline([[from.lat, from.lon], [tip.lat, tip.lon]], {
      pane: "highlight", color: "#ffd479", weight: 2.5, opacity: 0.95,
    }).addTo(map)
    line.on("click", () => onTap(n))
    arrowLines.push(line)

    const a = map.latLngToLayerPoint([from.lat, from.lon])
    const b = map.latLngToLayerPoint([to.lat, to.lon])
    const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
    const mark = L.marker([tip.lat, tip.lon], {
      pane: "highlight",
      keyboard: false,
      icon: L.divIcon({
        className: "arrow",
        html: '<span class="arrow-head" style="transform:rotate(' + deg.toFixed(1) + 'deg)"></span>',
        iconSize: null,
        iconAnchor: null,
      }),
    }).addTo(map)
    const el = mark.getElement()
    if (el) el.addEventListener("click", () => onTap(n))
    arrowMarks.push(mark)
  }
}

function protect() {
  if (!selected) return flash("Pick one of your territories first.")
  snapshot()
  plan.protect = plan.protect === selected ? null : selected
  save()
}

/** Adjust one line of the plan by +1, -1, or remove it entirely. */
function adjust(kind, i, delta) {
  snapshot()
  if (kind === "protect") {
    plan.protect = null
  } else {
    const list = kind === "deploy" ? plan.deploys : kind === "move" ? plan.moves : plan.attacks
    const entry = list[i]
    if (!entry) return
    if (delta === 0) list.splice(i, 1)
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
      if (entry.count <= 0) list.splice(i, 1)
    }
  }
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
    rows.push(row("deploy", i, "Deploy " + d.count + " to " + esc(nameOf(d.territory)), true)))
  plan.attacks.forEach((a, i) =>
    rows.push(row("attack", i, "Attack " + esc(nameOf(a.to)) + " from " + esc(nameOf(a.from)) + " with " + a.count, true)))
  plan.moves.forEach((m, i) =>
    rows.push(row("move", i, "Move " + m.count + " from " + esc(nameOf(m.from)) + " to " + esc(nameOf(m.to)), true)))
  if (plan.protect) rows.push(row("protect", 0, "Protect " + esc(nameOf(plan.protect)), false))
  $("plan").innerHTML = rows.length ? rows.join("") : '<p class="hint">No orders yet. Tap one of your territories.</p>'

  const left = P.reserve - spent()
  // The over-budget hint names WHICH orders give way: under claim seniority
  // the wagers are locked at their market's close, so a short reserve drops
  // deploys, not wagers. Without this line the first player whose later
  // wagers push a saved plan negative files the allocation as a bug.
  $("reserve").textContent =
    left < 0 ? left + " of " + P.reserve + " — wagers are locked; deploys give way" : left + " of " + P.reserve
  $("reserve").className = left < 0 ? "n over" : "n"

  const s = $("save")
  if (saveState === "saved") { s.textContent = "saved"; s.className = "save ok" }
  else if (saveState === "saving") { s.textContent = "saving…"; s.className = "save" }
  else { s.textContent = "NOT SAVED — " + saveState.slice(6); s.className = "save bad" }

  $("selected").textContent = selected
    ? nameOf(selected) +
      (left > 0 ? " — tap again to add a soldier" : " — tap a neighbour to attack or reinforce")
    : "nothing selected"
  $("flash").textContent = flashMsg
  $("btn-protect").disabled = !selected || P.locked
  $("btn-undo").disabled = history.length === 0 || P.locked
}

function row(kind, i, text, steppable) {
  const btn = (delta, glyph, label) =>
    '<button data-kind="' + kind + '" data-i="' + i + '" data-delta="' + delta +
    '" aria-label="' + label + '">' + glyph + '</button>'
  return '<div class="prow"><span>' + text + '</span><span class="pbtns">' +
    (steppable ? btn(-1, "−", "one fewer") + btn(1, "+", "one more") : "") +
    btn(0, "×", "remove") + '</span></div>'
}

$("plan").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]")
  if (b) adjust(b.dataset.kind, Number(b.dataset.i), Number(b.dataset.delta))
})
$("btn-protect").addEventListener("click", protect)
$("btn-undo").addEventListener("click", undo)
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
  if ((e.key || "") === "Escape") return closeAttack()
  const k = e.key || ""
  if (k.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey) return
  const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : ""
  if (tag === "input" || tag === "textarea" || (e.target && e.target.isContentEditable)) return
  e.preventDefault()
  undo()
})

P.loadedAt = Date.now()
setInterval(() => { $("countdown").textContent = countdown() }, 30000)
render()
})()
`
