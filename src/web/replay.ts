/**
 * The night, animated.
 *
 * A SEPARATE script from the board's, not a mode of it. The board is one big
 * interaction loop -- taps, selection, the attack panel, undo, autosave -- and
 * none of it applies to a night that already happened. Threading a read-only
 * flag through 1,100 lines of that would leave every one of those paths one
 * missed branch away from letting a player "order" something in the past.
 *
 * It recomputes NOTHING. The log supplies the narrative and the beats; the
 * closing frame is the persisted `after` state verbatim. Mid-flight the counts
 * are nudged by each event's own numbers, and the final snap corrects any
 * drift -- which is the point: the alternative is a second implementation of
 * the engine's bookkeeping that disagrees with the game and says nothing.
 *
 * NOTE for editors: this whole file is a template literal. A backtick or a
 * dollar-brace in a comment ends it early, and the parse test in
 * replay.test.ts is what catches that.
 */
export const REPLAY = `(function(){
const R = window.__RRP__
const $ = (id) => document.getElementById(id)
const colorOf = (f) => (R.factions.find((x) => x.id === f) || {}).color || "#888"
const who = (f) => (R.factions.find((x) => x.id === f) || {}).name || f
// Must match replay-data's MARKETS.
const MARKETS = "—"
// Beat text and player names both reach innerHTML. Player names are typed by an
// operator into roster:add, so they are not markup by construction.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// ---- the map ---------------------------------------------------------------
const map = L.map("map", {
  zoomControl: true, attributionControl: false, worldCopyJump: false,
  zoomSnap: 0, scrollWheelZoom: true, zoomDelta: 0.5,
})
map.createPane("backdrop").style.zIndex = 350
map.createPane("bridges").style.zIndex = 450

for (const id of Object.keys(R.offBoard || {})) {
  const rings = R.offBoard[id] || []
  if (!rings.length) continue
  L.polygon(rings.map((r) => [r.map(([lon, lat]) => [lat, lon])]), {
    pane: "backdrop", weight: 0.5, color: "#22303c", fillColor: "#22303c",
    fillOpacity: 0.45, interactive: false,
  }).addTo(map)
}

for (const pair of (R.seaLinks || [])) {
  const ca = R.centres[pair[0]], cb = R.centres[pair[1]]
  if (!ca || !cb) continue
  const line = [[ca.lat, ca.lon], [cb.lat, cb.lon]]
  L.polyline(line, { pane: "bridges", color: "#0b1a24", weight: 5, opacity: 0.85, interactive: false }).addTo(map)
  L.polyline(line, { pane: "bridges", color: "#e8c56a", weight: 2, opacity: 0.95, dashArray: "6 4", interactive: false }).addTo(map)
}

const layers = {}
const counts = {}
for (const t of R.territories) {
  const rings = R.shapes[t.id] || []
  if (!rings.length) continue
  // Each ring in its own array: a MULTI-polygon, not one polygon with holes.
  // Flat, Leaflet reads ring 2+ as holes punched in ring 1 -- see the board.
  const poly = L.polygon(rings.map((r) => [r.map(([lon, lat]) => [lat, lon])]), {
    weight: 1, color: "#0b1a24", fillOpacity: 0.85, interactive: false,
  }).addTo(map)
  layers[t.id] = poly
  const at = R.labels[t.id] || R.centres[t.id]
  if (at) {
    counts[t.id] = L.marker([at.lat, at.lon], {
      pane: "markerPane", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "gcount", html: "0", iconSize: [26, 16], iconAnchor: [13, 8] }),
    }).addTo(map)
  }
}

const drawn = R.territories.map((t) => layers[t.id]).filter(Boolean)
if (drawn.length) map.fitBounds(L.featureGroup(drawn).getBounds(), { padding: [24, 24] })

// ---- working state ---------------------------------------------------------
// Starts at the night's opening board and is walked forward by the beats.
const own = Object.assign({}, R.before.ownership)
const gar = Object.assign({}, R.before.garrisons)

function paint() {
  for (const t of R.territories) {
    const l = layers[t.id]
    if (l) l.setStyle({ fillColor: colorOf(own[t.id]) })
    const m = counts[t.id]
    if (!m) continue
    const el = m.getElement()
    if (el) el.textContent = String(gar[t.id] || 0)
  }
}

function flash(id, cls) {
  const l = layers[id]
  if (!l) return
  const el = l.getElement()
  if (!el) return
  el.classList.add(cls)
  setTimeout(() => { try { el.classList.remove(cls) } catch (e) {} }, 900)
}

// A soldier travelling. Straight line between label points -- the map is not a
// pathfinder and the arc would imply a route that does not exist.
function travel(from, to, color, ms) {
  const a = R.labels[from] || R.centres[from]
  const b = R.labels[to] || R.centres[to]
  if (!a || !b) return
  const line = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
    color: color, weight: 3, opacity: 0.9, dashArray: "5 4", interactive: false,
  }).addTo(map)
  const dot = L.circleMarker([a.lat, a.lon], {
    radius: 5, color: "#0b1a24", weight: 1, fillColor: color, fillOpacity: 1, interactive: false,
  }).addTo(map)
  // Cleanup is on a TIMER, not on the animation finishing. requestAnimationFrame
  // is throttled to a standstill in a background tab, so a player who switches
  // away mid-flight used to come back to a map littered with every dashed line
  // and dot the replay had ever drawn -- they were removed only by the frame
  // that never ran. The frames are decoration; the removal is not.
  let gone = false
  const clear = () => {
    if (gone) return
    gone = true
    map.removeLayer(dot)
    map.removeLayer(line)
  }
  setTimeout(clear, ms + 260)
  const t0 = Date.now()
  function frame() {
    if (gone) return
    const k = Math.min(1, (Date.now() - t0) / ms)
    dot.setLatLng([a.lat + (b.lat - a.lat) * k, a.lon + (b.lon - a.lon) * k])
    if (k < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

// ---- beats -----------------------------------------------------------------
// Narrated and typed server-side (replay-data.ts). All this does is animate a
// kind it recognises; one it does not is simply read out, which is why a new
// event variant degrades to a caption instead of throwing.
const beats = R.beats

function runBeat(b, ms) {
  if (b.kind === "deploy") {
    gar[b.territory] = (gar[b.territory] || 0) + b.count
    flash(b.territory, "lit-own")
    return
  }
  if (b.kind === "move") {
    travel(b.from, b.to, colorOf(b.faction), ms * 0.7)
    gar[b.from] = (gar[b.from] || 0) - b.count
    setTimeout(() => { gar[b.to] = (gar[b.to] || 0) + b.count; paint() }, ms * 0.7)
    return
  }
  if (b.kind === "battle") { flash(b.a, "lit-hit"); flash(b.b, "lit-hit"); return }
  if (b.kind === "protect") { flash(b.territory, "lit-shield"); return }
  if (b.kind === "attack") {
    travel(b.from, b.to, colorOf(b.attacker), ms * 0.6)
    gar[b.from] = Math.max(0, (gar[b.from] || 0) - b.committed - b.fee)
    setTimeout(() => {
      if (b.captured) { own[b.to] = b.attacker; gar[b.to] = b.survivors; flash(b.to, "lit-taken") }
      else { gar[b.to] = Math.max(0, (gar[b.to] || 0) - b.defenderLost); flash(b.to, "lit-hit") }
      paint()
    }, ms * 0.6)
  }
}

// ---- playback --------------------------------------------------------------
let i = -1
let playing = false
let speed = 1
let timer = 0

function renderBank() {
  const by = {}
  for (const row of R.bank) { (by[row.faction] = by[row.faction] || []).push(row.text) }
  const keys = Object.keys(by)
  $("bank").innerHTML = keys.length === 0
    ? '<tr><td class="hint">Nobody earned.</td></tr>'
    : keys.map((f) => '<tr><td>' + esc(f === MARKETS ? "markets" : who(f)) + '</td><td class="n">' +
        esc(by[f].join(", ")) + '</td></tr>').join("")
}

function renderSteps() {
  $("steps").innerHTML = beats.map((b, n) =>
    '<li class="prow' + (n === i ? " on" : "") + (n < i ? " done" : "") + '"><span>' + esc(b.text) + "</span></li>").join("")
  const el = $("steps").children[i]
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" })
  $("progress").textContent = beats.length === 0 ? "nothing happened" : (Math.max(0, i + 1) + " of " + beats.length)
  $("btn-play").textContent = playing ? "Pause" : (i >= beats.length - 1 ? "Replay" : "Play")
}

function finish() {
  // The persisted end-state, verbatim. Anything the beats got wrong is gone.
  Object.assign(own, R.after.ownership)
  Object.assign(gar, R.after.garrisons)
  paint()
  markSeen()
}

function stepTo(n) {
  if (n <= i) return
  while (i < n) {
    i++
    const b = beats[i]
    if (b) runBeat(b, 900 / speed)
  }
  paint()
  renderSteps()
  if (i >= beats.length - 1) { playing = false; finish(); renderSteps() }
}

function tick() {
  if (!playing) return
  if (i >= beats.length - 1) { playing = false; finish(); renderSteps(); return }
  stepTo(i + 1)
  if (playing) timer = setTimeout(tick, 1100 / speed)
}

function play() {
  if (i >= beats.length - 1) { // restart
    i = -1
    Object.assign(own, R.before.ownership)
    Object.assign(gar, R.before.garrisons)
    paint()
  }
  playing = true
  renderSteps()
  tick()
}

function pause() { playing = false; clearTimeout(timer); renderSteps() }

// ---- seen marker -----------------------------------------------------------
// localStorage, so this is per-device on purpose: watch on a phone and the
// laptop offers it again. The board reads the same key before it paints.
function markSeen() {
  try {
    const k = "rr.seen." + R.seasonId
    if (Number(localStorage.getItem(k) || 0) < R.day) localStorage.setItem(k, String(R.day))
  } catch (e) {}
}

// from=replay so the board does not bounce back here if the write above failed.
function leave() { markSeen(); location.href = "/?from=replay" }

$("btn-play").addEventListener("click", () => (playing ? pause() : play()))
$("btn-step").addEventListener("click", () => { pause(); stepTo(Math.min(beats.length - 1, i + 1)) })
$("btn-skip").addEventListener("click", () => { pause(); finish(); leave() })
for (const s of [1, 2, 4]) {
  $("spd-" + s).addEventListener("click", () => {
    speed = s
    for (const o of [1, 2, 4]) $("spd-" + o).classList.toggle("on", o === s)
    if (playing) { clearTimeout(timer); tick() }
  })
}

paint()
renderBank()
renderSteps()
if (beats.length === 0) finish()
else setTimeout(play, 400)
})()
`
