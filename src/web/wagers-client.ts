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

const left = () => W.reserve - staked()

function paintReserve() {
  const el = $("reserve")
  if (el) el.textContent = String(left())
  // The cap is the point, not decoration. Over-commit and the engine's
  // allocation phase drops the JUNIOR claims at the tick -- silently, hours
  // later, with the player believing all five bets stand. Better to stop the
  // plus button than to explain that afterwards.
  const none = left() <= 0
  for (const b of document.querySelectorAll('.bet .step[data-delta="1"]')) b.disabled = none
}

/**
 * What this stake pays if it wins.
 *
 * The SAME expression the engine's payout() uses, in the same order, against
 * prices this page was handed already clamped. Written as (stake / p) * bonus
 * rather than stake * (bonus / p) on purpose: the two differ in the last bit
 * and can land on opposite sides of a round() sitting exactly on .5.
 */
function payoutFor(row, stake) {
  const o = W.odds[row.getAttribute("data-market")]
  const side = sideOf(row)
  if (!o || !side || stake <= 0) return 0
  return Math.round((stake / o[side]) * W.bonus)
}

function paintPayout(row) {
  const el = row.querySelector(".payout")
  if (!el) return
  const stake = Number(row.querySelector(".stake").textContent) || 0
  const win = payoutFor(row, stake)
  // Profit as well as the total, because "wins 8" on a stake of 3 reads as
  // either 8 back or 11 back until you say which.
  el.textContent = win === 0 ? "" : "wins " + win + " (+" + (win - stake) + ")"
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
      paintPayout(row)
      // Picking a side with a stake already set is a change of bet, so it
      // re-prices -- the server records the price at save time.
      save(row)
      return
    }

    if (btn.classList.contains("step")) {
      const out = row.querySelector(".stake")
      const delta = Number(btn.getAttribute("data-delta"))
      // Never past the reserve. Raising a stake by more than is left would be
      // committing soldiers that do not exist.
      if (delta > 0 && left() <= 0) return
      const next = Math.max(0, (Number(out.textContent) || 0) + delta)
      out.textContent = String(next)
      paintReserve()
      paintPayout(row)
      // Debounced: holding + would otherwise post once per tap, and each post
      // re-prices the wager.
      clearTimeout(row.__t)
      row.__t = setTimeout(function () { save(row) }, 450)
    }
  })
}

paintReserve()
for (const row of document.querySelectorAll(".bet")) paintPayout(row)
})()
`
