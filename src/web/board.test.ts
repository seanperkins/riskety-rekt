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
})
