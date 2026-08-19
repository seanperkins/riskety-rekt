import { describe, expect, it } from "vitest"
import { CLIENT } from "./client.js"
import { projectionFor } from "./projection-data.js"
import { ENGINE_VERSION, RISK_MAP, createSeason } from "../engine/index.js"
import { WORLD } from "../map/world.js"
import type { Faction, GameMap } from "../engine/index.js"

/**
 * The client is a STRING, so nothing else in this suite ever runs it.
 *
 * Three bugs have shipped through that gap: a backtick in a comment that
 * terminated the template early, an `el.className =` that wiped Leaflet's own
 * classes, and a helper deleted along with the block around it — which threw a
 * ReferenceError inside paint() and left the entire board blank. Every one was
 * invisible to a green suite and obvious in a browser.
 *
 * This runs the client against the narrowest Leaflet and DOM stubs that let it
 * reach the end. It is not a rendering test and cannot check what anything
 * looks like; it catches the class of fault where the script does not survive
 * its own execution.
 */

const factions: Faction[] = ["f1", "f2", "f3"].map((id) => ({
  id,
  playerName: `Player ${id}`,
  color: "#123456",
}))

/**
 * `RISK_MAP` by default, because that is what most of this file has always run
 * against. It is NOT what a player sees: `COORDS` and `SHAPES` are built from
 * `WORLD`, so on the classic board most territories project without a centre or
 * a coastline. Anything that asserts about drawn geometry has to pass `WORLD`,
 * or it measures the fixture's gaps rather than the client.
 */
function projection(map: GameMap = RISK_MAP): unknown {
  const state = createSeason(
    "s1",
    factions,
    map.territories.map((t) => t.id),
    map,
  )
  expect(state.engineVersion).toBe(ENGINE_VERSION)
  return projectionFor({
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
}

/**
 * One layer the client asked Leaflet for: what kind, the options it was built
 * with, and the handlers bound to it. Recorded because the arrows are the one
 * thing on this map whose MEANING is carried by the options -- the colour says
 * whose ground the soldiers walk onto -- and a stub that swallows them can only
 * report that drawing survived, never that it drew the right thing.
 */
type LayerCall = {
  kind: string
  latlngs: unknown
  opts: Record<string, unknown>
  events: string[]
  /**
   * Every setStyle paint() has applied, newest last.
   *
   * The selection has no other observable: it is a module-local `selected` the
   * harness cannot reach, and the ONLY thing it changes is the stroke this
   * records (`weight: 3.5`, `color: "#fff"`). A stub that swallowed setStyle
   * could report that painting happened but never that anything was selected.
   */
  styles: Record<string, unknown>[]
  fire(type: string): void
}

/** The smallest Leaflet that lets the client run to completion. */
function fakeLeaflet(
  log: LayerCall[] = [],
  mapOpts: Record<string, unknown>[] = [],
): Record<string, unknown> {
  const layer = (kind: string) => (latlngs: unknown, opts: Record<string, unknown> = {}) => {
    const handlers = new Map<string, () => void>()
    const call: LayerCall = {
      kind,
      latlngs,
      opts: opts ?? {},
      events: [],
      styles: [],
      fire: (type) => handlers.get(type)?.(),
    }
    log.push(call)
    return {
      ...baseLayer(),
      on(type: string, fn: () => void) {
        call.events.push(type)
        handlers.set(type, fn)
        return this
      },
      setStyle(s: Record<string, unknown>) {
        call.styles.push(s)
        return this
      },
    }
  }
  const baseLayer = (): Record<string, unknown> => ({
    addTo() {
      return this
    },
    on() {
      return this
    },
    bindTooltip() {
      return this
    },
    setStyle() {
      return this
    },
    setLatLngs() {
      return this
    },
    bringToFront() {
      return this
    },
    getElement: () => element(),
    getBounds: () => ({ pad: () => ({}) }),
    _path: { getBoundingClientRect: () => ({ width: 40, height: 40 }) },
  })
  const pane = (): Record<string, unknown> => ({ style: {} })
  return {
    // The options are RECORDED rather than swallowed. Two of them carry meaning
    // the client cannot express anywhere else: doubleClickZoom off is what stops
    // a fast second tap zooming instead of deploying, and zoomSnap is mutated on
    // this very object once the opening fit is done.
    map: (_id: string, opts: Record<string, unknown> = {}) => {
      mapOpts.push(opts)
      return {
        options: opts,
        createPane: () => pane(),
        getPane: () => pane(),
        on() {
          return this
        },
        fitBounds() {
          return this
        },
        flyToBounds() {
          return this
        },
        setView() {
          return this
        },
        removeLayer() {
          return this
        },
        addLayer() {
          return this
        },
        getZoom: () => 4,
        // A crude equirectangular stand-in rather than a constant point. The
        // arrowheads take their bearing through this call, and a projection that
        // maps every coordinate to the origin makes every bearing zero -- which
        // is indistinguishable from a head that never got one.
        latLngToLayerPoint: (ll: [number, number]) => ({ x: ll[1] * 8, y: -ll[0] * 8 }),
      }
    },
    polygon: layer("polygon"),
    polyline: layer("polyline"),
    marker: layer("marker"),
    divIcon: (o: unknown) => o,
    canvas: (o: unknown) => o,
    featureGroup: () => ({ getBounds: () => ({ pad: () => ({}) }) }),
  }
}

/** Records the events bound to it, so wiring can be asserted, not just survival. */
function element(tag = ""): Record<string, unknown> {
  const events: string[] = []
  const el: Record<string, unknown> = {
    __tag: tag,
    __events: events,
    style: {},
    className: "",
    textContent: "",
    innerHTML: "",
    dataset: {},
    disabled: false,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(type: string) {
      events.push(type)
    },
    // The attack/move panel focuses its slider as it opens, so any test that
    // drives a tap far enough to open it reaches this.
    focus() {},
    setAttribute() {},
    getAttribute: () => "f1",
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 40 }),
  }
  return el
}

/** Everything a run of the client exposes for assertion. */
type Harness = {
  mapEl: Record<string, unknown>
  factionRow: Record<string, unknown>
  byId: Map<string, Record<string, unknown>>
  docEvents: string[]
  winEvents: string[]
  P: Projection
  log: LayerCall[]
  /** The options each `L.map(...)` was constructed with, in call order. */
  mapOpts: Record<string, unknown>[]
  ran: () => void
}

/** The projection fields these tests reach into. */
type Projection = {
  factionId: string
  ownership: Record<string, string>
  reserve: number
  income: number
  plan: { deploys: { territory: string; count: number }[] }
  territories: { id: string; neighbors: string[] }[]
  shapes: Record<string, unknown[] | undefined>
  labels: Record<string, { lat: number; lon: number } | undefined>
  centres: Record<string, { lat: number; lon: number } | undefined>
}

function harness(map: GameMap = RISK_MAP): Harness {
  const mapEl = element("map")
  const factionRow = element("row")
  const docEvents: string[] = []
  // Stable per id, so the wiring on a specific control can be asserted.
  const byId = new Map<string, Record<string, unknown>>([["map", mapEl]])
  const doc = {
    getElementById: (id: string) => {
      if (!byId.has(id)) byId.set(id, element(id))
      return byId.get(id)!
    },
    querySelector: () => element(),
    querySelectorAll: (sel: string) => (sel.includes("data-faction") ? [factionRow] : [element()]),
    createElement: () => element(),
    body: element(),
    __events: docEvents,
    addEventListener(type: string) {
      docEvents.push(type)
    },
  }
  const winEvents: string[] = []
  const P = projection(map) as Projection
  const win: Record<string, unknown> = {
    __RR__: P,
    location: { search: "" },
    // The wagers sheet syncs to the URL hash: opening it sets #wager, and a
    // same-document navigation to that hash fires only this event, never a
    // reload. Recorded so the wiring is asserted rather than merely survived.
    __events: winEvents,
    addEventListener(type: string) {
      winEvents.push(type)
    },
    history: { replaceState() {} },
    URLSearchParams: URLSearchParams,
    prompt: () => null,
    setInterval: () => 0,
    setTimeout: () => 0,
    requestAnimationFrame: () => 0,
    fetch: () => ({ then: () => ({ then: () => ({ catch: () => {} }) }) }),
    document: doc,
  }
  // Injected as parameters rather than set on a global: the client reaches
  // for several of these bare (`location.search`), so they have to be in
  // scope, not merely on `window`.
  const names = [
    "window",
    "document",
    "L",
    "location",
    "URLSearchParams",
    "setInterval",
    "setTimeout",
    "requestAnimationFrame",
    "fetch",
  ]
  const log: LayerCall[] = []
  const mapOpts: Record<string, unknown>[] = []
  const values = [
    win,
    doc,
    fakeLeaflet(log, mapOpts),
    { search: "" },
    URLSearchParams,
    () => 0,
    () => 0,
    () => 0,
    win["fetch"],
  ]
  const run = new Function(...names, CLIENT)
  return {
    mapEl,
    factionRow,
    byId,
    docEvents,
    winEvents,
    P,
    log,
    mapOpts,
    ran: () => run(...values),
  }
}

describe("the client script", () => {
  it("parses", () => {
    // A stray backtick in a comment silently ends the template literal.
    expect(() => new Function("window", "document", "L", CLIENT)).not.toThrow()
  })

  it("builds the map with double-click zoom OFF", () => {
    // The board's gesture is tap-to-select then tap-again-to-deploy, so a fast
    // pair of taps is the normal way to place two soldiers -- and to the browser
    // it is also a double click. With Leaflet's default on, every quick pair
    // deployed AND flew the map half a zoom level in under the finger: measured
    // in Chrome, two taps 700ms apart left a province at 64px while the same
    // pair 60ms apart took it to 86px.
    const h = harness()
    h.ran()
    expect(h.mapOpts[0]?.doubleClickZoom).toBe(false)
  })

  it("runs to completion against a real projection", () => {
    const { mapEl, factionRow, byId, docEvents, winEvents, ran } = harness()
    expect(ran).not.toThrow()

    // Survival is not enough. Rewriting a neighbouring block once deleted the
    // hover delegation, the player-row wiring and click-to-zoom outright --
    // nothing threw, the suite stayed green, and four features were simply
    // gone. So the wiring itself is asserted.
    expect(mapEl["__events"], "region hover is delegated from the map container").toContain(
      "mouseover",
    )
    expect(mapEl["__events"]).toContain("mouseout")
    const rowEvents = factionRow["__events"] as string[]
    expect(rowEvents, "player rows highlight on hover").toContain("mouseenter")
    expect(rowEvents, "player rows fly to the faction on click").toContain("click")
    expect(rowEvents, "and are reachable by keyboard").toContain("keydown")

    // The order pane and undo are the only way to take a tap back.
    expect(
      (byId.get("plan")?.["__events"] ?? []) as string[],
      "the plan pane handles its own +/-/x buttons",
    ).toContain("click")
    expect(
      (byId.get("btn-undo")?.["__events"] ?? []) as string[],
      "undo is wired",
    ).toContain("click")
    expect(docEvents, "Cmd+Z / Ctrl+Z reaches undo").toContain("keydown")
    expect(
      winEvents,
      "the wagers sheet follows the URL hash, so a #wager link opens it without a reload",
    ).toContain("hashchange")
    expect(
      (byId.get("btn-wagers")?.["__events"] ?? []) as string[],
      "the Wagers button opens the sheet",
    ).toContain("click")
    expect(
      (byId.get("atk-ok")?.["__events"] ?? []) as string[],
      "the attack panel's Okay commits",
    ).toContain("click")
    expect(
      (byId.get("atk-slider")?.["__events"] ?? []) as string[],
      "the slider updates its readout",
    ).toContain("input")
  })

  /**
   * The budget a day-1 player actually has.
   *
   * `createSeason` starts every faction at reserve 0, and the engine grants
   * income at step 1 of the tick before allocating claims at step 3 -- so
   * tonight's income is spendable by tonight's orders. The client budgeted
   * against `P.reserve` alone, so on day 1 `unspent()` was 0, `deployTo`
   * returned false on the first tap and every wager stepper rendered disabled.
   * Nobody could place a soldier or stake a wager on the opening night of a
   * season, and the rules panel told them they could.
   */
  it("budgets a zero reserve against tonight's income, not against zero", () => {
    const { P, byId, ran } = harness()
    expect(P.reserve, "a fresh season deals everyone in at zero").toBe(0)
    expect(P.income).toBeGreaterThan(0)
    ran()

    // "left of budget" -- the rail's own phrasing. Both halves are the income,
    // because nothing has been spent yet.
    expect(byId.get("reserve")?.["textContent"]).toBe(P.income + " of " + P.income)
    // And the wagers stepper is live rather than disabled.
    expect(byId.get("wagers-left")?.["textContent"]).toBe(String(P.income))
  })

  /**
   * Two adjacent own territories, and the polygon click that reaches each.
   *
   * Returns them in draw order so a test can tap one and then its neighbour,
   * which is the gesture the whole reinforce-vs-deploy precedence turns on.
   */
  function adjacentOwnPair(h: ReturnType<typeof harness>) {
    const { P, log } = h
    const mine = (id: string): boolean => P.ownership[id] === P.factionId
    const drawn = P.territories.filter((t) => (P.shapes[t.id] ?? []).length)
    const a = drawn.find((t) => mine(t.id) && t.neighbors.some((n) => mine(n) && drawn.some((d) => d.id === n)))
    if (!a) throw new Error("no own territory with an own neighbour in the deal")
    const bId = a.neighbors.find((n) => mine(n) && drawn.some((d) => d.id === n))!
    const polys = log.filter((c) => c.kind === "polygon" && c.opts["fillOpacity"] === 0.85)
    return {
      tapA: () => polys[drawn.indexOf(a)]!.fire("click"),
      tapB: () => polys[drawn.findIndex((d) => d.id === bId)]!.fire("click"),
    }
  }

  /**
   * Reported live, the first hour the day-1 deploy path was reachable at all:
   * "I have 3 unspent but when I click the territory next to the one I just
   * deployed to, it brings up the movement modal instead of placing troops."
   *
   * onTap gave the reinforce gesture priority over selection whenever the tap
   * landed on an adjacent own territory -- unconditionally, soldiers in hand or
   * not. It went unnoticed because before tonight's-income budgeting a day-1
   * player never had soldiers in hand, so "spent out" was the only state this
   * branch was ever exercised in.
   *
   * The rest of the interaction already draws the line in the same place: the
   * movement arrows appear only once `unspent()` hits zero, "because that is
   * when the question changes from where do these go to where do I send them".
   * The tap now answers the same question the arrows do.
   */
  it("with soldiers in hand, tapping an adjacent own territory selects it rather than reinforcing", () => {
    const h = harness(WORLD)
    h.ran()
    expect(h.P.income, "day 1 leaves soldiers in hand").toBeGreaterThan(0)
    const { tapA, tapB } = adjacentOwnPair(h)
    tapA()
    tapB()
    expect(
      h.byId.get("atk")?.["hidden"],
      "the move panel must stay shut while there are soldiers to place",
    ).not.toBe(false)
  })

  it("and once they are all placed, the same tap reinforces", () => {
    const h = harness(WORLD)
    const own = Object.keys(h.P.ownership).find((t) => h.P.ownership[t] === h.P.factionId)!
    h.P.plan.deploys = [{ territory: own, count: h.P.reserve + h.P.income }]
    h.ran()
    const { tapA, tapB } = adjacentOwnPair(h)
    tapA()
    tapB()
    expect(h.byId.get("atk")?.["hidden"], "spent out, the gesture means move").toBe(false)
  })

  /**
   * A tap on ground the selection cannot reach means "never mind".
   *
   * It used to flash "X does not border Y" and hold the selection, which left
   * the only way to let go of a territory being to find another of your own to
   * tap. On a phone, where the flash sits in the rail behind the map, that read
   * as the board ignoring the tap entirely.
   *
   * Own ground is deliberately NOT included: tapping another of your
   * territories has always meant "select that one instead", and that is more
   * useful than dropping the selection to nothing.
   */
  it("drops the selection when the tap lands on ground it cannot reach", () => {
    const h = harness(WORLD)
    h.ran()
    const { P, log } = h
    const mine = (id: string): boolean => P.ownership[id] === P.factionId
    const drawn = P.territories.filter((t) => (P.shapes[t.id] ?? []).length)
    const from = drawn.find((t) => mine(t.id))!
    const far = drawn.find((t) => !mine(t.id) && !from.neighbors.includes(t.id))
    if (!far) throw new Error("no unreachable foreign territory in the deal")

    const polys = log.filter((c) => c.kind === "polygon" && c.opts["fillOpacity"] === 0.85)
    const fromPoly = polys[drawn.indexOf(from)]!
    polys[drawn.indexOf(from)]!.fire("click")
    const selectedStroke = fromPoly.styles[fromPoly.styles.length - 1]
    expect(selectedStroke?.["weight"], "tapping your own territory selects it").toBe(3.5)

    polys[drawn.indexOf(far)]!.fire("click")
    const afterStroke = fromPoly.styles[fromPoly.styles.length - 1]
    expect(
      afterStroke?.["weight"],
      "a tap on unreachable ground lets the selection go",
    ).not.toBe(3.5)
  })

  /**
   * The movement arrows, driven far enough to see what they drew.
   *
   * The fan appears once the budget is spent, which is when the question turns
   * from "where do these go" to "where do I send them" -- so the harness spends
   * it first. (It used to rely on a fresh season having nothing to spend, which
   * stopped being true once the client started counting tonight's income.)
   * These cannot check what an arrow LOOKS like -- only a screenshot does that
   * -- but they can check the two things a person would notice were wrong: that
   * the colour still says whose ground the soldiers walk onto, and that the
   * lines are arcs whose heads follow the curve rather than the chord.
   */
  describe("movement arrows", () => {
    // The client's own two, and the only place their meaning is written down.
    const ATTACK = "#ff6a3d"
    const MOVE = "#35f0a0"

    /** Bearing in degrees through the same projection the stub hands the client. */
    const bearing = (a: number[], b: number[]): number =>
      (Math.atan2(-(b[0]! - a[0]!) * 8, (b[1]! - a[1]!) * 8) * 180) / Math.PI

    /** Select an own territory bordering both a neighbour's ground and its own. */
    function selectFrontier(): { P: Projection; log: LayerCall[]; from: string } {
      const h = harness(WORLD)
      // Spend the night's whole budget before the client runs, so the fan is
      // reachable. Any owned territory will do -- the arrows are drawn from the
      // SELECTED one, and that is chosen below.
      const own = Object.keys(h.P.ownership).find((t) => h.P.ownership[t] === h.P.factionId)!
      h.P.plan.deploys = [{ territory: own, count: h.P.reserve + h.P.income }]
      h.ran()
      const { P, log } = h
      const mine = (id: string): boolean => P.ownership[id] === P.factionId
      // An arrow needs somewhere to point: the client skips a neighbour with no
      // label and no centre, so the test has to skip it too or it counts arrows
      // the client was right not to draw.
      const aimed = (id: string): boolean => Boolean(P.labels[id] ?? P.centres[id])
      const drawn = P.territories.filter((t) => (P.shapes[t.id] ?? []).length)
      const frontier = drawn.find(
        (t) =>
          mine(t.id) &&
          aimed(t.id) &&
          t.neighbors.some((n) => mine(n) && aimed(n)) &&
          t.neighbors.some((n) => !mine(n) && aimed(n)),
      )
      if (!frontier) throw new Error("no frontier territory in the deal to select")

      // Territory polygons are the only ones built with this fill, which is what
      // keeps this from counting the backdrop and the hover outline as board.
      const polys = log.filter((c) => c.kind === "polygon" && c.opts["fillOpacity"] === 0.85)
      expect(polys, "one polygon per drawn territory, in order").toHaveLength(drawn.length)
      const poly = polys[drawn.indexOf(frontier)]!
      log.length = 0
      poly.fire("click")
      return { P, log, from: frontier.id }
    }

    it("colours the fan by whose ground it leads onto", () => {
      const { P, log, from } = selectFrontier()
      const mine = (id: string): boolean => P.ownership[id] === P.factionId
      const lines = log.filter((c) => c.kind === "polyline" && c.opts["className"] !== "arrow-cast")
      const colors = lines.map((c) => c.opts["color"])

      expect(colors, "an attack arrow reads red").toContain(ATTACK)
      expect(colors, "a reinforcement arrow reads green").toContain(MOVE)
      expect(new Set(colors), "and nothing else").toEqual(new Set([ATTACK, MOVE]))
      // One arrow per neighbour that has ground to draw on, both kinds counted:
      // the green ones went missing entirely before this, and a fan that simply
      // skipped them looked like a correct fan.
      const reachable = P.territories
        .find((t) => t.id === from)!
        .neighbors.filter((n) => P.labels[n] ?? P.centres[n])
      expect(lines).toHaveLength(reachable.length)
      expect(colors.filter((c) => c === MOVE)).toHaveLength(
        reachable.filter((n) => mine(n)).length,
      )
    })

    it("gives every arrow a casing beneath it, and a tap on both", () => {
      const { log } = selectFrontier()
      const casings = log.filter((c) => c.opts["className"] === "arrow-cast")
      const lines = log.filter((c) => c.kind === "polyline" && c.opts["className"] !== "arrow-cast")

      expect(casings).toHaveLength(lines.length)
      // The casing is wider and underneath: that is what carries the shadow, and
      // it is the fatter tap target for the same gesture.
      for (const c of casings) expect(c.opts["weight"] as number).toBeGreaterThan(2.5)
      for (const c of [...casings, ...lines]) expect(c.events).toContain("click")
    })

    it("draws arcs, and points each head down the curve rather than the chord", () => {
      const { log } = selectFrontier()
      const lines = log.filter((c) => c.kind === "polyline" && c.opts["className"] !== "arrow-cast")
      const heads = log.filter(
        (c) => c.kind === "marker" && (c.opts["icon"] as { className?: string })?.className === "arrow",
      )
      expect(heads).toHaveLength(lines.length)

      let curved = 0
      for (const [i, line] of lines.entries()) {
        const pts = line.latlngs as number[][]
        expect(pts.length, "an arc is sampled, not a two-point run").toBeGreaterThan(2)

        const html = (heads[i]!.opts["icon"] as { html: string }).html
        expect(html, "the head is tinted to match its line").toContain(line.opts["color"] as string)
        const deg = Number(/rotate\((-?[\d.]+)deg\)/.exec(html)![1])

        const tail = bearing(pts[pts.length - 2]!, pts[pts.length - 1]!)
        expect(deg, "the head takes the LAST segment's bearing").toBeCloseTo(tail, 1)
        // On a straight run the first and last segments share a bearing, so a
        // difference is the curve itself -- and it is exactly the difference
        // that made the old straight-line bearing point the head off its line.
        if (Math.abs(tail - bearing(pts[0]!, pts[1]!)) > 5) curved++
      }
      expect(curved, "the lines actually bow").toBe(lines.length)
    })
  })
})
