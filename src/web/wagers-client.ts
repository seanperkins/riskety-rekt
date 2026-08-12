/**
 * The wagers page, made usable.
 *
 * It was a read-only table: the slate rendered, and the ONLY way to actually
 * place a bet was the operator CLI. The markets module was unplayable from the
 * web app, which is where players live.
 *
 * Deliberately its own small script rather than a mode of the board's client.
 * The board is a map with selection, an attack panel and undo, none of which a
 * list of markets has, and the two save to different endpoints against
 * different deadlines: a plan locks at 21:00, a wager at its own market's close.
 *
 * NOTE for editors: this file is a template literal. A backtick or a
 * dollar-brace in a comment ends it early -- wagers.test.ts parses it for
 * exactly that reason.
 */
export const WAGERS = `(function(){
const W = window.__RRW__ || { reserve: 0 }
const $ = (id) => document.getElementById(id)

// Stakes committed across every market. One wager per market, so this is a sum
// over the rows rather than anything the server has to tell us.
function staked() {
  let total = 0
  for (const el of document.querySelectorAll(".bet .stake")) total += Number(el.textContent) || 0
  return total
}

function paintReserve() {
  const left = W.reserve - staked()
  const el = $("reserve")
  if (!el) return
  el.textContent = String(left)
  // Over-committing is not blocked here -- the engine's allocation phase
  // decides who gets paid when several claims compete, and duplicating that
  // rule in the browser would be a second implementation of it. It is only
  // flagged, so nobody is surprised at 21:00.
  el.className = left < 0 ? "n over" : ""
}

function setState(row, text, bad) {
  const el = row.querySelector(".bet-state")
  if (!el) return
  el.textContent = text
  el.className = "hint bet-state" + (bad ? " save bad" : "")
}

function sideOf(row) {
  const on = row.querySelector('.side[aria-pressed="true"]')
  return on ? on.getAttribute("data-side") : null
}

function save(row) {
  const marketId = row.getAttribute("data-market")
  const stake = Number(row.querySelector(".stake").textContent) || 0
  const side = sideOf(row)
  // A stake of zero is not a wager, and there is no delete endpoint: the engine
  // reads what is saved, so the way to back out is to leave it at zero and
  // never have saved one. Say so rather than posting something refusable.
  if (stake <= 0) return setState(row, side ? "pick a stake" : "", false)
  if (!side) return setState(row, "pick a side", false)

  setState(row, "saving...", false)
  fetch("/api/wager", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marketId: marketId, side: side, stake: stake }),
  })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b } }) })
    .then(function (res) {
      if (res.ok) setState(row, "saved", false)
      else setState(row, res.body && res.body.reason ? res.body.reason : "not saved", true)
    })
    .catch(function () { setState(row, "not saved -- offline?", true) })
}

for (const row of document.querySelectorAll(".bet")) {
  row.addEventListener("click", function (e) {
    const btn = e.target.closest ? e.target.closest("button") : null
    if (!btn) return

    if (btn.classList.contains("side")) {
      const already = btn.getAttribute("aria-pressed") === "true"
      for (const s of row.querySelectorAll(".side")) s.removeAttribute("aria-pressed")
      // Tapping the chosen side again clears it, which is the only way to say
      // "I have not decided" once you have touched the row.
      if (!already) btn.setAttribute("aria-pressed", "true")
      // Picking a side with a stake already set is a change of bet, so it
      // re-prices -- the server records the price at save time.
      save(row)
      return
    }

    if (btn.classList.contains("step")) {
      const out = row.querySelector(".stake")
      const next = Math.max(0, (Number(out.textContent) || 0) + Number(btn.getAttribute("data-delta")))
      out.textContent = String(next)
      paintReserve()
      // Debounced: holding + would otherwise post once per tap, and each post
      // re-prices the wager.
      clearTimeout(row.__t)
      row.__t = setTimeout(function () { save(row) }, 450)
    }
  })
}

paintReserve()
})()
`
