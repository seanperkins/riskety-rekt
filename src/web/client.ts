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
const map = L.map("map", { zoomControl: true, attributionControl: false, worldCopyJump: false })
const layers = {}

// The rest of the world, drawn first so every playable territory sits on top of
// it. Inert: no click, no tooltip, no pointer events at all, so it can never
// swallow a tap meant for a territory you actually own.
for (const id in (P.offBoard || {})) {
  for (const ring of P.offBoard[id]) {
    L.polygon([ring.map(([lon, lat]) => [lat, lon])], {
      stroke: true, weight: 0.5, color: "#16242f",
      fillColor: "#22303c", fillOpacity: 0.45,
      interactive: false,
    }).addTo(map)
  }
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

function paint() {
  for (const t of P.territories) {
    const l = layers[t.id]
    if (!l) continue
    const isMine = mine(t.id)
    const isSel = selected === t.id
    l.setStyle({
      fillColor: colorOf(owner(t.id)),
      color: isSel ? "#fff" : isMine ? "#e6edf3" : "#0b1a24",
      weight: isSel ? 3.5 : isMine ? 2 : 1,
      fillOpacity: isMine ? 0.9 : 0.55,
    })
  }
  // The selected outline traces the real border, so it has to be drawn LAST.
  // SVG has no z-index: a neighbour added after it paints its own edge over the
  // shared boundary, and the highlight comes out broken along exactly the sides
  // that touch another territory — which is most of them.
  const sel = selected && layers[selected]
  if (sel && sel.bringToFront) sel.bringToFront()
}

// Open on the BOARD -- every playable territory, not the whole world and not
// only your own ground.
//
// Your own holdings were too tight to read: on day one they are a handful of
// scattered territories, so the map opened at a zoom where the front line was
// off screen and there was no way to tell where you sat relative to anyone
// else. The world is the opposite problem — most of it is grey backdrop
// nobody can act on. The board is the thing being played.
const played = P.territories.map((t) => layers[t.id]).filter(Boolean)
if (played.length) map.fitBounds(L.featureGroup(played).getBounds(), { padding: [24, 24] })
else map.setView([20, 0], 2)
paint()

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
