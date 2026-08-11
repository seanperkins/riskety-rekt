import { describe, expect, it } from "vitest"
import type { GameMap } from "../engine/index.js"
import { COORDS } from "../map/coords.js"
import { WORLD } from "../map/world.js"
import { esc, page, renderMap } from "./render.js"

describe("esc", () => {
  it("escapes every HTML-significant character", () => {
    expect(esc(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
    )
  })

  it("escapes non-strings rather than throwing", () => {
    expect(esc(42)).toBe("42")
    expect(esc(null)).toBe("null")
    expect(esc(undefined)).toBe("undefined")
  })
})

describe("page", () => {
  it("escapes the title", () => {
    expect(page("<b>hi</b>", "")).toContain("<title>&lt;b&gt;hi&lt;/b&gt;</title>")
  })

  it("declares utf-8 and a viewport", () => {
    const html = page("t", "")
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain("initial-scale=1")
  })
})

describe("renderMap", () => {
  const html = renderMap({ base: WORLD }, COORDS)

  it("draws one line per border and one circle per territory", () => {
    const degree = WORLD.territories.reduce((s, t) => s + t.neighbors.length, 0)
    expect(html.match(/<line /g) ?? []).toHaveLength(degree / 2)
    expect(html.match(/<circle /g) ?? []).toHaveLength(WORLD.territories.length)
  })

  it("reports the real totals", () => {
    expect(html).toContain(`<td class="n">${WORLD.territories.length}</td>`)
    expect(html).toContain(`<td class="n">${WORLD.regions.length}</td>`)
  })

  it("names every region in the legend", () => {
    for (const c of WORLD.regions) expect(html, c.id).toContain(c.name)
  })

  it("has no NaN in any coordinate", () => {
    // A zero-span projection would divide by zero and emit NaN, which renders as
    // an invisible, silent blank rather than an obvious error.
    expect(html).not.toMatch(/NaN/)
  })

  it("escapes a hostile territory name", () => {
    // Territory names are ours today; market questions are third-party text from
    // Kalshi and display names come from Slack. Escaping only "the untrusted
    // ones" is how the one that gets reclassified slips through.
    const hostile: GameMap = {
      regions: [{ id: "x", name: "<b>C</b>", bonus: 0 }],
      territories: [
        { id: "a", name: '"><script>alert(1)</script>', region: "x", neighbors: ["b"] },
        { id: "b", name: "B", region: "x", neighbors: ["a"] },
      ],
    }
    const out = renderMap({ base: hostile }, { a: { lat: 0, lon: 0 }, b: { lat: 1, lon: 1 } })
    expect(out).not.toContain("<script>alert(1)</script>")
    expect(out).toContain("&lt;script&gt;")
    expect(out).toContain("&lt;b&gt;C&lt;/b&gt;")
  })

  it("renders a map whose territories have no coordinates without crashing", () => {
    const orphan: GameMap = {
      regions: [{ id: "x", name: "X", bonus: 0 }],
      territories: [{ id: "a", name: "A", region: "x", neighbors: [] }],
    }
    expect(() => renderMap({ base: orphan }, {})).not.toThrow()
  })
})
