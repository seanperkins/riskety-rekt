import { describe, expect, it } from "vitest"
import { RULE_CATALOGUE } from "../engine/rules/index.js"
import { OFFER_IDS, demoSeason, renderLanding } from "./landing.js"

/**
 * The landing page is what a stranger sees, so its tests own two things the
 * copy could quietly lose in a redesign: the two dead ends a signed-out visitor
 * can be in, and the guarantee that nothing on the page comes from a live
 * season.
 */
describe("renderLanding", () => {
  const html = renderLanding()
  const body = html.slice(html.indexOf("<body>"))

  it("is a complete document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("<title>Riskety Rekt</title>")
  })

  it("still tells a signed-out player how to get back in", () => {
    // The page grew a pitch, but a returning player who lost their cookie lands
    // here too and needs the command, not the sales copy.
    expect(body).toContain("/login")
  })

  it("still names the roster dead end", () => {
    // Somebody not on the roster can run /login all day and never get a link.
    // Only one of the two dead ends is fixed by running the command again, so
    // the page has to name the other.
    expect(body).toMatch(/roster/i)
  })

  it("carries no live projection", () => {
    // The board on this page is dealt from a constant seed at render time and
    // reads no store. `__RR__` is how a real projection reaches a browser, and
    // its absence is the check that no season's state leaked onto a page served
    // without a session.
    expect(body).not.toContain("__RR__")
  })

  it("links the rules and the world map", () => {
    expect(body).toContain('href="/rules"')
    expect(body).toContain('href="/map"')
  })

  it("is byte-identical on every call", () => {
    // A fixed seed, no clock and no randomness. A page that differed between
    // two calls would mean something impure crept into the demo deal.
    expect(renderLanding()).toBe(html)
  })

  it("labels the board as a demonstration", () => {
    // The faction names are invented. Somebody must not read the hero as a
    // season in progress and go looking for those players in Slack.
    expect(body).toMatch(/example|demonstration|made up|not a real/i)
  })

  it("shows the rules the offer actually names", () => {
    // The mock offer tops itself up in catalogue order if an id goes missing,
    // so that a retired rule cannot blank the page. That fallback is silent by
    // design and it already swallowed one typo during development — this is
    // what makes the substitution visible instead.
    for (const id of OFFER_IDS) {
      const rule = RULE_CATALOGUE.find((r) => r.id === id)
      expect(rule, `${id} is no longer in the catalogue`).toBeDefined()
      expect(body).toContain(rule!.name)
      expect(body).toContain(rule!.description)
    }
  })

  it("stays small enough to be a landing page", () => {
    // Territory outlines are the whole page weight and they are easy to double
    // by accident -- switching to SHAPES_FINE, or drawing the off-board
    // backdrop, would each blow through this without any visible symptom.
    // ~118KB today: the board's 44 outlines, the three dozen backdrop shapes
    // inside its frame, and the ~28KB stylesheet every page inlines. The budget
    // has room for copy but not for the two mistakes worth catching —
    // SHAPES_FINE multiplies every outline several times over, and dropping the
    // backdrop's bounding-box filter pulls in 200-odd more territories.
    expect(html.length).toBeLessThan(160_000)
  })
})

describe("demoSeason", () => {
  const state = demoSeason()

  it("deals every territory on its board", () => {
    const ids = state.map.territories.map((t) => t.id)
    expect(Object.keys(state.ownership).sort()).toEqual([...ids].sort())
    for (const id of ids) expect(state.garrisons[id]).toBeGreaterThanOrEqual(1)
  })

  it("gives every faction ground to hold", () => {
    // A demo board with an already-eliminated faction shows a colour in the
    // standings that appears nowhere on the map, which reads as a rendering
    // bug rather than a game state.
    const held = new Set(Object.values(state.ownership))
    for (const f of state.factions) expect(held.has(f.id)).toBe(true)
  })

  it("does not look like day zero", () => {
    // createSeason puts 2 on every territory. A hero image where every number
    // is the same sells nothing -- the varied garrisons ARE the picture of a
    // game being played.
    const counts = new Set(Object.values(state.garrisons))
    expect(counts.size).toBeGreaterThan(3)
  })

  it("is deterministic", () => {
    expect(demoSeason()).toEqual(state)
  })
})
