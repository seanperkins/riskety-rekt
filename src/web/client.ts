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
let plan = { deploys: [], attacks: [], protect: P.plan.protect ?? null }
plan.deploys = P.plan.deploys.map((d) => ({ ...d }))
plan.attacks = P.plan.attacks.map((a) => ({ ...a }))
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
// OFF by default while we find out what makes zooming feel slow. Add
// ?backdrop=1 to draw it and compare the two directly -- same board, same
// build, one variable.
//
// It began as 451 separate SVG polygons -- one per ring across 194
// territories, against 70 for the board itself -- so every zoom re-projected
// all of them and the browser laid out 451 DOM nodes. Collapsing it to a
// single multi-polygon on a canvas made that one draw call, which is free
// because the backdrop is uniform and inert: no CSS, no hit testing, no focus
// ring, which are the only reasons to prefer SVG.
const wantBackdrop = new URLSearchParams(location.search).get("backdrop") === "1"

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

function tooltip(id) {
  const g = P.garrisons[id] ?? 0
  const o = owner(id)
  const f = P.factions.find((x) => x.id === o)
  return esc(nameOf(id)) + " — " + g + (f ? " · " + esc(f.name) : " · unclaimed")
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
    el.textContent = String(P.garrisons[t.id] ?? 0)
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
    const digits = String(P.garrisons[t.id] ?? 0).length
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

// The board's centre, so each badge can be pushed AWAY from it.
let bLat = 0, bLon = 0, bN = 0
for (const t of P.territories) {
  const c = P.centres[t.id]
  if (c) { bLat += c.lat; bLon += c.lon; bN++ }
}
const boardCentre = bN ? { lat: bLat / bN, lon: bLon / bN } : { lat: 0, lon: 0 }

for (const r of P.regions) {
  const ids = regionOf[r.id] || []
  if (!ids.length) continue

  // Bounds over the real POLYGONS, not the centre points. A region's badge has
  // to clear the land it names, and a centre-of-centres box sits well inside
  // the coastline of anything larger than a few territories.
  let n0 = 90, s0 = -90, e0 = -180, w0 = 180, any = false
  let cLat = 0, cLon = 0, cN = 0
  for (const id of ids) {
    for (const ring of (P.shapes[id] || [])) {
      for (const [lon, lat] of ring) {
        if (lat < n0) n0 = lat
        if (lat > s0) s0 = lat
        if (lon > e0) e0 = lon
        if (lon < w0) w0 = lon
        any = true
      }
    }
    const c = P.centres[id]
    if (c) { cLat += c.lat; cLon += c.lon; cN++ }
  }
  if (!any || !cN) continue
  const mid = { lat: cLat / cN, lon: cLon / cN }

  // One of four sides, chosen by whichever way the region already sits relative
  // to the board's middle -- so badges radiate outward and the ones on the rim
  // land in open water. The dominant axis decides, so a region north-east of
  // centre goes north if it is more north than east.
  const dLat = mid.lat - boardCentre.lat
  const dLon = (mid.lon - boardCentre.lon) * Math.cos((mid.lat * Math.PI) / 180)
  let side, at
  if (Math.abs(dLat) >= Math.abs(dLon)) {
    side = dLat >= 0 ? "n" : "s"
    at = [dLat >= 0 ? s0 : n0, mid.lon]
  } else {
    side = dLon >= 0 ? "e" : "w"
    at = [mid.lat, dLon >= 0 ? e0 : w0]
  }

  // Whoever holds every territory in the region owns the bonus; the badge says
  // so by taking their colour.
  const holders = new Set(ids.map((id) => owner(id)))
  const sole = holders.size === 1 ? [...holders][0] : null
  const badge = L.marker(at, {
    // Interactive, unlike every other overlay: hovering it lights the region.
    // Safe because a badge now sits OUTSIDE its region's bounding box, so it
    // covers no territory whose tap it could steal.
    interactive: true,
    keyboard: false,
    // The final gap is a CSS translate rather than a degree offset, so it stays
    // the same number of pixels at every zoom instead of growing as you zoom in.
    icon: L.divIcon({
      className: "rbadge rb-" + side,
      // aria-label carries the name that CSS hides, so the badge still reads
      // as more than a bare number to a screen reader.
      html: '<span class="rb-in" data-region="' + esc(r.id) + '"' +
        ' aria-label="' + esc(r.name) + ', +' + r.bonus + ' for the whole region">' +
        '<span class="rb-n"' + (sole ? ' style="background:' + colorOf(sole) + '"' : "") +
        '>+' + r.bonus + '</span><span class="rb-name">' + esc(r.name) + '</span></span>',
      // iconSize NULL, not omitted. DivIcon DEFAULTS to [12, 12] and writes it
      // as an inline width/height, which beats the stylesheet -- the badge came
      // out 12px square with its text overflowing, visible but with almost no
      // hit area. Explicit null makes Leaflet write nothing at all.
      iconSize: null,
      iconAnchor: null,
    }),
  }).addTo(map)
}

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

// Mirror the map highlight back into the rail, so hovering a region badge also
// shows WHO holds it -- the two panels answer the same question from opposite
// ends.
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
mapEl.addEventListener("mouseover", (e) => {
  const el = e.target && e.target.closest && e.target.closest("[data-region]")
  if (el) setHighlight("region", el.getAttribute("data-region"))
})
mapEl.addEventListener("mouseout", (e) => {
  const el = e.target && e.target.closest && e.target.closest("[data-region]")
  if (el) setHighlight(null)
})

// Hovering a player lights everything they hold; clicking flies to it.
function zoomToFaction(id) {
  const theirs = P.territories
    .filter((t) => owner(t.id) === id)
    .map((t) => layers[t.id])
    .filter(Boolean)
  if (!theirs.length) return
  // Padded well past the holding itself: a faction's territories are the
  // question, but the answer is usually who is next to them, and a bounds
  // hugging their coastline shows the ground without the threat.
  map.flyToBounds(L.featureGroup(theirs).getBounds(), {
    padding: [70, 70],
    duration: 0.5,
  })
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

const lit = (id) =>
  highlight !== null &&
  (highlight.kind === "region"
    ? byId[id] && byId[id].region === highlight.id
    : owner(id) === highlight.id)

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

// ---- acting ----------------------------------------------------------------
function onTap(id) {
  if (P.locked) return
  if (mine(id)) {
    selected = selected === id ? null : id
    paint()
    render()
    return
  }
  // An enemy territory: attack it from the selected neighbour.
  if (!selected) return flash("Pick one of your territories first.")
  if (!byId[selected].neighbors.includes(id)) return flash(nameOf(id) + " does not border " + nameOf(selected) + ".")
  const max = Math.max(0, (P.garrisons[selected] ?? 0) - 1)
  const n = ask("Attack " + nameOf(id) + " from " + nameOf(selected) + " with how many? (max " + max + ")", max)
  if (n === null) return
  plan.attacks.push({ from: selected, to: id, count: n })
  save()
}

function ask(label, suggested) {
  const raw = window.prompt(label, String(suggested))
  if (raw === null) return null
  const n = Number(raw)
  // The server decides legality. This only rejects what is not a number at all.
  if (!Number.isFinite(n) || n <= 0) { flash("That is not a number of soldiers."); return null }
  return Math.floor(n)
}

function deploy() {
  if (!selected) return flash("Pick one of your territories first.")
  const n = ask("Deploy how many to " + nameOf(selected) + "? (reserve " + (P.reserve - spent()) + ")", 1)
  if (n === null) return
  const existing = plan.deploys.find((d) => d.territory === selected)
  if (existing) existing.count += n
  else plan.deploys.push({ territory: selected, count: n })
  save()
}

function protect() {
  if (!selected) return flash("Pick one of your territories first.")
  plan.protect = plan.protect === selected ? null : selected
  save()
}

function remove(kind, i) {
  if (kind === "deploy") plan.deploys.splice(i, 1)
  if (kind === "attack") plan.attacks.splice(i, 1)
  if (kind === "protect") plan.protect = null
  save()
}

// ---- saving ----------------------------------------------------------------
// Autosave, and a failure is LOUD and stays loud. A silent write failure costs
// a season, and it is the worst thing this page can do.
let inflight = null
function save() {
  render()
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
    rows.push(row("deploy", i, "Deploy " + d.count + " to " + esc(nameOf(d.territory)))))
  plan.attacks.forEach((a, i) =>
    rows.push(row("attack", i, "Attack " + esc(nameOf(a.to)) + " from " + esc(nameOf(a.from)) + " with " + a.count)))
  if (plan.protect) rows.push(row("protect", 0, "Protect " + esc(nameOf(plan.protect))))
  $("plan").innerHTML = rows.length ? rows.join("") : '<p class="hint">No orders yet. Tap one of your territories.</p>'

  const left = P.reserve - spent()
  $("reserve").textContent = left + " of " + P.reserve
  $("reserve").className = left < 0 ? "n over" : "n"

  const s = $("save")
  if (saveState === "saved") { s.textContent = "saved"; s.className = "save ok" }
  else if (saveState === "saving") { s.textContent = "saving…"; s.className = "save" }
  else { s.textContent = "NOT SAVED — " + saveState.slice(6); s.className = "save bad" }

  $("selected").textContent = selected ? nameOf(selected) : "nothing selected"
  $("flash").textContent = flashMsg
  for (const b of ["deploy", "protect"]) $("btn-" + b).disabled = !selected || P.locked
}

function row(kind, i, text) {
  return '<div class="prow"><span>' + text + '</span>' +
    '<button data-kind="' + kind + '" data-i="' + i + '" aria-label="remove">×</button></div>'
}

$("plan").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]")
  if (b) remove(b.dataset.kind, Number(b.dataset.i))
})
$("btn-deploy").addEventListener("click", deploy)
$("btn-protect").addEventListener("click", protect)

P.loadedAt = Date.now()
setInterval(() => { $("countdown").textContent = countdown() }, 30000)
render()
})()
`
