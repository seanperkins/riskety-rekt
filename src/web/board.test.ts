import { describe, expect, it } from "vitest"
import { ENGINE_VERSION, RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction } from "../engine/index.js"
import { projectionFor } from "./projection-data.js"
import { renderBoard } from "./render.js"
import { STYLE } from "./style.js"

const factions: Faction[] = ["f1", "f2", "f3"].map((id) => ({
  id,
  playerName: `Player ${id}`,
  color: "#123456",
}))
const state = createSeason(
  "s1",
  factions,
  RISK_MAP.territories.map((t) => t.id),
)
const TICK = new Date("2026-09-05T01:00:00Z")
const NOW = new Date("2026-09-04T20:00:00Z")

const project = (over = {}) =>
  projectionFor({
    state,
    day: 1,
    factionId: "f1",
    plan: { deploys: [{ territory: "alaska", count: 3 }], attacks: [], protect: "peru" },
    wagers: [],
    slate: [],
    modules: ["markets", "irl", "veto"],
    tickAt: TICK,
    now: NOW,
    ...over,
  })

describe("the projection", () => {
  it("carries the viewer's own plan", () => {
    const p = project()
    expect(p.plan.deploys).toEqual([{ territory: "alaska", count: 3 }])
    expect(p.plan.protect).toBe("peru")
  })

  /**
   * The serialized projection only. The client script is inlined into the page
   * and legitimately contains the word "wagers" all over — a whole-document
   * check reports a leak on every board.
   */
  const payloadOf = (html: string) =>
    html.slice(html.indexOf("window.__RR__"), html.indexOf("</script>", html.indexOf("window.__RR__")))

  it("a markets-off season carries NO wagers or slate keys — absent, not empty", () => {
    const p = project({ modules: ["irl", "veto"] })
    expect("wagers" in p).toBe(false)
    expect("slate" in p).toBe(false)
    const payload = payloadOf(renderBoard(p))
    expect(payload).not.toContain('"wagers"')
    expect(payload).not.toContain('"slate"')
  })

  it("a markets-off season offers no way to wager — absent, not dead", () => {
    // The panel and its odds payload are gone entirely, and the button that
    // opens it is hidden. A control that opens an empty sheet is ghost UI.
    const html = renderBoard(project({ modules: ["irl", "veto"] }))
    expect(html).not.toContain('id="wagers"')
    // The ASSIGNMENT, not the identifier: the client reads window.__RRW__ with
    // a fallback, so the name is in the script either way. What must be absent
    // is the odds payload the panel emits.
    expect(html).not.toMatch(/__RRW__\s*=/)
    expect(html).toMatch(/id="btn-wagers"[^>]*\shidden/)
  })

  it("a markets-on season ships the panel and the button that opens it", () => {
    const html = renderBoard(project())
    expect(html).toContain('id="wagers"')
    expect(html).toMatch(/__RRW__\s*=/)
    expect(html).toMatch(/id="btn-wagers"(?![^>]*\shidden)/)
  })

  it("carries public ownership and garrisons", () => {
    const p = project()
    expect(Object.keys(p.ownership).length).toBe(42)
    expect(Object.keys(p.garrisons).length).toBe(42)
  })

  it("carries only the viewer's reserve", () => {
    const p = project()
    expect(p.reserve).toBe(0)
    expect(JSON.stringify(p)).not.toContain('"reserves"')
  })

  it("contains NO other faction's plan, anywhere in the rendered page", () => {
    // THE test. The secrecy model is that a foreign plan is absent from the
    // bytes, not hidden with CSS -- and nothing in the type system enforces it.
    //
    // protect matters most: it is legal only for an eliminated faction, so
    // leaking it tells the table who is about to go out.
    const html = renderBoard(project())
    // A distinctive marker no other field would produce.
    expect(html).not.toContain("kamchatka-is-f2s-secret")
    // Structurally: the serialised projection has exactly one plan, and its
    // shape is the viewer's.
    const json = /window\.__RR__ = (\{.*?\})<\/script>/s.exec(html)?.[1]
    expect(json).toBeDefined()
    const parsed = JSON.parse(json!.replace(/\\u003c/g, "<")) as Record<string, unknown>
    expect(Object.keys(parsed)).not.toContain("orders")
    expect(Object.keys(parsed)).not.toContain("plans")
    expect(Object.keys(parsed)).not.toContain("reserves")
    expect(parsed["factionId"]).toBe("f1")
  })

  it("locks once the tick instant has passed", () => {
    expect(project({ now: new Date("2026-09-05T01:00:01Z") }).locked).toBe(true)
    expect(project().locked).toBe(false)
  })

  it("reports time remaining, never negative", () => {
    expect(project().msToTick).toBeGreaterThan(0)
    expect(project({ now: new Date("2026-09-06T00:00:00Z") }).msToTick).toBe(0)
  })

  it("ships a shape for every territory on the board", () => {
    const p = project()
    for (const t of p.territories) expect(p.shapes[t.id], t.id).toBeDefined()
  })

  it("escapes a closing script tag in the serialised projection", () => {
    // The projection goes into a <script> block. An unescaped "</script>" in
    // any string field would end the block early and turn the rest into markup.
    const html = renderBoard(project())
    expect(html).not.toMatch(/window\.__RR__ = .*<\/script>.*<\/script>\s*<script src/s)
  })
})

describe("the stylesheet must not size Leaflet's own SVG", () => {
  // A regression that no DOM assertion catches. `.stage svg` as a DESCENDANT
  // selector also matched Leaflet's overlay SVG, whose parent pane is an
  // absolutely positioned 0x0 element -- so the board rendered as a 0x0 SVG
  // and was blank on screen, while every path inside still reported a correct
  // bounding box. Scripted checks passed; a human saw nothing.
  it("scopes the .stage svg rule to a direct child", () => {
    // Strip comments first: the explanation above this rule mentions the very
    // pattern being asserted against.
    const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(css).toContain(".stage > svg")
    expect(css).not.toMatch(/\.stage\s+svg\s*\{/)
  })

  it("sets no width or height on a leaflet class", () => {
    // Leaflet computes both from the container and rewrites them on every zoom.
    const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, "")
    for (const [, block] of css.matchAll(/\.leaflet-[\w-]*[^{]*\{([^}]*)\}/g)) {
      expect(block).not.toMatch(/(^|;)\s*(width|height)\s*:/)
    }
  })

  // The narrow layout gives .stage its height, and .stage's own rule sets
  // min-height: 0 for grid shrinking. At equal specificity the later rule wins,
  // so ORDER is load-bearing: the media query used to come first and lost, and
  // the stage computed to 0px on every viewport under 860px. Leaflet still
  // initialised and still drew all 44 paths into the zero-height box -- the same
  // silent failure as the rule above, reached through the cascade rather than a
  // selector, and equally invisible to a scripted check that only reads geometry.
  it("declares the narrow-layout stage height AFTER .stage's min-height", () => {
    const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, "")
    const base = css.search(/\.stage\s*\{[^}]*min-height/)
    const media = css.search(/@media[^{]*max-width:\s*860px/)
    expect(base, ".stage min-height rule must exist").toBeGreaterThan(-1)
    expect(media, "the 860px media query must exist").toBeGreaterThan(-1)
    expect(media).toBeGreaterThan(base)
  })

  it("gives the narrow stage a definite height, not just a min-height", () => {
    // #map is height: 100%, and a percentage resolves against the parent's
    // HEIGHT. Against auto it collapses to zero however tall min-height is.
    const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, "")
    const block = css.match(/@media[^{]*max-width:\s*860px[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? ""
    expect(block).toMatch(/\.stage\s*\{[^}]*(^|[^-])height:\s*\d/m)
  })
})

describe("the off-board backdrop", () => {
  const p = projectionFor({
    state,
    day: 1,
    factionId: "f1",
    plan: { deploys: [], attacks: [], protect: null },
    wagers: [],
    slate: [],
    modules: ["markets", "irl", "veto"],
    tickAt: new Date("2026-09-02T01:00:00Z"),
    now: new Date("2026-09-01T12:00:00Z"),
  })

  it("never repeats a territory that is on the board", () => {
    const onBoard = new Set(p.territories.map((t) => t.id))
    const overlap = Object.keys(p.offBoard).filter((id) => onBoard.has(id))
    expect(overlap).toEqual([])
  })

  it("carries geometry and nothing else", () => {
    // The backdrop is context, not state. It must never acquire an owner, a
    // garrison or anything else derived from the game -- that is the whole
    // reason it is a separate field rather than extra entries in `shapes`.
    for (const rings of Object.values(p.offBoard)) {
      expect(Array.isArray(rings)).toBe(true)
      for (const ring of rings) {
        expect(ring.length).toBeGreaterThanOrEqual(3)
        for (const point of ring) expect(point).toHaveLength(2)
      }
    }
  })

  it("shows the rest of the world, not a handful of leftovers", () => {
    expect(Object.keys(p.offBoard).length).toBeGreaterThan(p.territories.length)
  })
})

describe("sea links on the board", () => {
  const p = projectionFor({
    state,
    day: 1,
    factionId: "f1",
    plan: { deploys: [], attacks: [], protect: null },
    wagers: [],
    slate: [],
    modules: ["markets", "irl", "veto"],
    tickAt: new Date("2026-09-02T01:00:00Z"),
    now: new Date("2026-09-01T12:00:00Z"),
  })

  it("only reports links whose BOTH ends are on this board", () => {
    // A bridge to a territory nobody was dealt would draw a line into the grey
    // backdrop, promising a crossing that cannot be made.
    const onBoard = new Set(p.territories.map((t) => t.id))
    for (const [a, b] of p.seaLinks) {
      expect(onBoard.has(a), `${a} in ${a}|${b}`).toBe(true)
      expect(onBoard.has(b), `${b} in ${a}|${b}`).toBe(true)
    }
  })

  it("reports only pairs that really are neighbours", () => {
    // Drawn, a sea link claims an attack is legal. If it disagreed with the
    // adjacency the engine validates against, the map would be lying.
    const nbr = new Map(p.territories.map((t) => [t.id, t.neighbors]))
    for (const [a, b] of p.seaLinks) {
      expect(nbr.get(a), `${a}|${b}`).toContain(b)
      expect(nbr.get(b), `${b}|${a}`).toContain(a)
    }
  })

  it("has a centre for both ends, since the line is drawn between them", () => {
    for (const [a, b] of p.seaLinks) {
      expect(p.centres[a], a).toBeDefined()
      expect(p.centres[b], b).toBeDefined()
    }
  })
})

describe("level of detail", () => {
  const p = projectionFor({
    state,
    day: 1,
    factionId: "f1",
    plan: { deploys: [], attacks: [], protect: null },
    wagers: [],
    slate: [],
    modules: ["markets", "irl", "veto"],
    tickAt: new Date("2026-09-02T01:00:00Z"),
    now: new Date("2026-09-01T12:00:00Z"),
  })

  it("carries a fine shape for every board territory", () => {
    // The client swaps whole layers at a zoom threshold. A territory missing
    // from the fine set would vanish the moment anyone zoomed in.
    for (const t of p.territories) {
      expect(p.shapesFine[t.id], t.id).toBeDefined()
    }
  })

  it("gives the fine set more detail than the coarse one", () => {
    const count = (r: Record<string, [number, number][][]>): number =>
      Object.values(r).reduce((n, rings) => n + rings.reduce((m, x) => m + x.length, 0), 0)
    expect(count(p.shapesFine)).toBeGreaterThan(count(p.shapes))
  })

  it("ships fine shapes for the board only, never the backdrop", () => {
    // The backdrop is drawn at 45% opacity behind everything; nobody inspects
    // its coastline, and it is by far the larger set.
    const onBoard = new Set(p.territories.map((t) => t.id))
    for (const id of Object.keys(p.shapesFine)) expect(onBoard.has(id), id).toBe(true)
  })
})

/**
 * The veto is the one order that only becomes available by LOSING, so an
 * eliminated player has had no earlier moment to learn it exists — and for a
 * long time they could not use it at all: the selection was only ever set inside
 * the mine(id) branch, so holding nothing meant selecting nothing, and the
 * button's guard never cleared.
 */
describe("an eliminated viewer", () => {
  /** f1 wiped out, f2 holding everything f1 held. */
  const wipedOut = () => {
    const ownership = { ...state.ownership }
    for (const [t, f] of Object.entries(ownership)) if (f === "f1") ownership[t] = "f2"
    return { ...state, ownership }
  }

  /**
   * Markup only, cut before the first script.
   *
   * The client is INLINED into every page, and it carries the same phrases in
   * its flash() strings — so a whole-document match reports the notice as
   * present on every board, eliminated or not. Which it did, the first time
   * these were written.
   */
  const railOf = (html: string) => html.slice(0, html.indexOf("<script"))

  it("is told the veto exists, and that any territory is fair game", () => {
    const rail = railOf(renderBoard(project({ state: wipedOut() })))
    expect(rail).toMatch(/you are out/i)
    expect(rail).toMatch(/any<\/em>\s*territory/i)
    // The posting condition is NAMED, never evaluated: whether they posted today
    // lives in Slack and is deliberately not in the projection.
    expect(rail).toMatch(/posted a workout today/i)
  })

  it("gets no such notice while still holding ground", () => {
    expect(railOf(renderBoard(project()))).not.toMatch(/you are out/i)
  })

  it("is the only viewer shown a Protect button at all", () => {
    // It can never become pressable for a living faction -- the engine refuses
    // the pick -- so it is hidden rather than shown greyed out for a whole
    // season. Hidden, not omitted: the client sets .disabled on it by id.
    const alive = railOf(renderBoard(project()))
    expect(alive).toMatch(/id="btn-protect"[^>]*\shidden/)
    const dead = railOf(renderBoard(project({ state: wipedOut() })))
    expect(dead).toMatch(/id="btn-protect"(?![^>]*\shidden)/)
  })

  it("does not get the button in a veto-off season either", () => {
    const rail = railOf(renderBoard(project({ state: wipedOut(), modules: ["markets", "irl"] })))
    expect(rail).toMatch(/id="btn-protect"[^>]*\shidden/)
  })

  it("and the stylesheet actually honours hidden on a chip", () => {
    // Marking it hidden did nothing on its own: .chip sets display, and an
    // author rule beats the UA sheet's [hidden] { display: none }. The attribute
    // was present and the button stayed on screen.
    const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(css).toMatch(/\.chip\[hidden\]\s*\{[^}]*display:\s*none/)
    // And it must come after the rule it is correcting.
    expect(css.search(/\.chip\[hidden\]/)).toBeGreaterThan(css.search(/\.chip\s*\{/))
  })

  it("is told plainly when the veto module is off, rather than offered nothing", () => {
    const rail = railOf(renderBoard(project({ state: wipedOut(), modules: ["markets", "irl"] })))
    expect(rail).toMatch(/veto is off/i)
    expect(rail).not.toMatch(/one Protect a day/i)
  })

  it("still has no other faction's plan in the page", () => {
    // The notice is new markup on the eliminated path; the secrecy model has to
    // survive it.
    const html = renderBoard(project({ state: wipedOut() }))
    const data = html.slice(html.indexOf("window.__RR__"))
    for (const key of ['"orders"', '"plans"', '"reserves"']) {
      expect(data, key).not.toContain(key)
    }
  })
})
