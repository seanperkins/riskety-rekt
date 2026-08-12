import { describe, expect, it } from "vitest"
import { CLIENT } from "./client.js"
import { projectionFor } from "./projection-data.js"
import { ENGINE_VERSION, RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction } from "../engine/index.js"

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

function projection(): unknown {
  const state = createSeason(
    "s1",
    factions,
    RISK_MAP.territories.map((t) => t.id),
    RISK_MAP,
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

/** The smallest Leaflet that lets the client run to completion. */
function fakeLeaflet(): Record<string, unknown> {
  const layer = (): Record<string, unknown> => ({
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
    map: () => ({
      options: {},
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
      latLngToLayerPoint: () => ({ x: 0, y: 0 }),
    }),
    polygon: layer,
    polyline: layer,
    marker: layer,
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
    setAttribute() {},
    getAttribute: () => "f1",
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 40 }),
  }
  return el
}

describe("the client script", () => {
  it("parses", () => {
    // A stray backtick in a comment silently ends the template literal.
    expect(() => new Function("window", "document", "L", CLIENT)).not.toThrow()
  })

  it("runs to completion against a real projection", () => {
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
    const win: Record<string, unknown> = {
      __RR__: projection(),
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
    const values = [
      win,
      doc,
      fakeLeaflet(),
      { search: "" },
      URLSearchParams,
      () => 0,
      () => 0,
      () => 0,
      win["fetch"],
    ]
    const run = new Function(...names, CLIENT)
    expect(() => run(...values)).not.toThrow()

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
})
