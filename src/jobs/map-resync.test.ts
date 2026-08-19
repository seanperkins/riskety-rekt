import { describe, expect, it, vi } from "vitest"
import { UsageError } from "./flags.js"
import { runMapResync } from "./map-resync.js"
import { openStore } from "../store/sqlite.js"
import type { GameMap, GameState } from "../engine/index.js"

/**
 * The frozen season map. Mirrors the live bug: `a`/`b` should border each
 * other and don't (missing pair), `c`/`d` border each other and shouldn't
 * (stale pair), and `e`/`f` are a pair the corrected map doesn't know about
 * at all (both must be left exactly as they are).
 */
const FROZEN: GameMap = {
  regions: [{ id: "r1", name: "Region One", bonus: 5 }],
  territories: [
    { id: "a", name: "A", region: "r1", neighbors: [] },
    { id: "b", name: "B", region: "r1", neighbors: [] },
    { id: "c", name: "C", region: "r1", neighbors: ["d"] },
    { id: "d", name: "D", region: "r1", neighbors: ["c"] },
    { id: "e", name: "E", region: "r1", neighbors: ["f"] },
    { id: "f", name: "F", region: "r1", neighbors: ["e"] },
  ],
}

/** The generated, correct adjacency. `e`/`f` do not appear at all. */
const CORRECTED: GameMap = {
  regions: [],
  territories: [
    { id: "a", name: "A", region: "r1", neighbors: ["b", "not-dealt"] },
    { id: "b", name: "B", region: "r1", neighbors: ["a"] },
    { id: "c", name: "C", region: "r1", neighbors: [] },
    { id: "d", name: "D", region: "r1", neighbors: [] },
  ],
}

function baseState(seasonId: string, day: number, map: GameMap): GameState {
  const ownership: Record<string, string> = {}
  const garrisons: Record<string, number> = {}
  for (const t of map.territories) {
    ownership[t.id] = "f1"
    garrisons[t.id] = 2
  }
  return {
    seasonId,
    day,
    map,
    factions: [{ id: "f1", playerName: "Ana", color: "#e11" }],
    ownership,
    garrisons,
    reserves: { f1: 0 },
    moduleState: {},
    log: [],
    engineVersion: "test",
  }
}

/** Three saved days (0, 1, 2), all sharing the same frozen map. */
function seedSeason(map: GameMap = FROZEN) {
  const store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-08-01", lengthDays: 14 })
  for (let day = 0; day <= 2; day++) {
    store.saveState(baseState("s1", day, map), "test")
  }
  return store
}

describe("runMapResync", () => {
  it("adds a missing pair on every saved day", () => {
    const store = seedSeason()
    const out = runMapResync({ store, seasonId: "s1", map: CORRECTED, confirm: true })
    expect(out).toMatchObject({ status: "rewritten", days: [0, 1, 2] })
    if (out.status !== "rewritten") throw new Error("expected rewritten")
    expect(out.added).toContainEqual(["a", "b"])
    for (const day of [0, 1, 2]) {
      const state = store.loadState("s1", day)!
      const a = state.map.territories.find((t) => t.id === "a")!
      const b = state.map.territories.find((t) => t.id === "b")!
      expect(a.neighbors).toContain("b")
      expect(b.neighbors).toContain("a")
    }
    store.close()
  })

  it("removes a stale pair", () => {
    const store = seedSeason()
    const out = runMapResync({ store, seasonId: "s1", map: CORRECTED, confirm: true })
    expect(out).toMatchObject({ status: "rewritten" })
    if (out.status !== "rewritten") throw new Error("expected rewritten")
    expect(out.removed).toContainEqual(["c", "d"])
    const state = store.loadState("s1", 0)!
    const c = state.map.territories.find((t) => t.id === "c")!
    const d = state.map.territories.find((t) => t.id === "d")!
    expect(c.neighbors).not.toContain("d")
    expect(d.neighbors).not.toContain("c")
    store.close()
  })

  it("leaves an id absent from the corrected map alone", () => {
    const store = seedSeason()
    runMapResync({ store, seasonId: "s1", map: CORRECTED, confirm: true })
    const state = store.loadState("s1", 0)!
    const e = state.map.territories.find((t) => t.id === "e")!
    const f = state.map.territories.find((t) => t.id === "f")!
    expect(e.neighbors).toEqual(["f"])
    expect(f.neighbors).toEqual(["e"])
    store.close()
  })

  it("produces a symmetric result", () => {
    const store = seedSeason()
    runMapResync({ store, seasonId: "s1", map: CORRECTED, confirm: true })
    const state = store.loadState("s1", 0)!
    const byId = new Map(state.map.territories.map((t) => [t.id, t]))
    for (const t of state.map.territories) {
      for (const n of t.neighbors) {
        expect(byId.get(n)?.neighbors).toContain(t.id)
      }
    }
    store.close()
  })

  it("preserves regions, each bonus, and untouched territory fields", () => {
    const store = seedSeason()
    runMapResync({ store, seasonId: "s1", map: CORRECTED, confirm: true })
    const state = store.loadState("s1", 0)!
    expect(state.map.regions).toEqual(FROZEN.regions)
    const a = state.map.territories.find((t) => t.id === "a")!
    expect(a.name).toBe("A")
    expect(a.region).toBe("r1")
    store.close()
  })

  it("an unconfirmed run writes nothing and reports planned", () => {
    const store = seedSeason()
    const before = store.loadState("s1", 0)
    const out = runMapResync({ store, seasonId: "s1", map: CORRECTED })
    expect(out).toMatchObject({ status: "planned", days: [0, 1, 2] })
    if (out.status !== "planned") throw new Error("expected planned")
    expect(out.added).toContainEqual(["a", "b"])
    expect(out.removed).toContainEqual(["c", "d"])
    expect(store.loadState("s1", 0)).toEqual(before)
    store.close()
  })

  it("raises UsageError for an unknown season", () => {
    const store = openStore(":memory:")
    expect(() => runMapResync({ store, seasonId: "nope", map: CORRECTED, confirm: true })).toThrow(
      UsageError,
    )
    store.close()
  })

  it("reports unchanged and writes nothing when already correct", () => {
    // The frozen map already agrees with the corrected map after intersection:
    // a-b present, c-d absent, e/f absent from CORRECTED entirely.
    const already: GameMap = {
      regions: FROZEN.regions,
      territories: [
        { id: "a", name: "A", region: "r1", neighbors: ["b"] },
        { id: "b", name: "B", region: "r1", neighbors: ["a"] },
        { id: "c", name: "C", region: "r1", neighbors: [] },
        { id: "d", name: "D", region: "r1", neighbors: [] },
        { id: "e", name: "E", region: "r1", neighbors: ["f"] },
        { id: "f", name: "F", region: "r1", neighbors: ["e"] },
      ],
    }
    const store = seedSeason(already)
    const writes = vi.spyOn(store, "updateStateMap")
    const out = runMapResync({ store, seasonId: "s1", map: CORRECTED, confirm: true })
    expect(out).toEqual({ status: "unchanged", days: [0, 1, 2] })
    // A confirmed run opens its transaction before it surveys -- see the read
    // ordering test below -- so the guarantee here is that nothing was WRITTEN,
    // not that no BEGIN was issued.
    expect(writes).not.toHaveBeenCalled()
    store.close()
  })

  it("surveys inside the write transaction, not before it", () => {
    // The tick appends a day. A day arriving between latestSavedDay and the
    // rewrite would be skipped, leaving the season corrected on every day but
    // the newest -- the torn state the day-0-upward walk exists to prevent.
    // store.transaction is BEGIN IMMEDIATE, so the read has the write lock.
    const store = seedSeason()
    const calls: string[] = []
    const real = store.transaction.bind(store)
    vi.spyOn(store, "transaction").mockImplementation((fn) => {
      calls.push("begin")
      return real(fn)
    })
    vi.spyOn(store, "latestSavedDay").mockImplementation((seasonId) => {
      calls.push("latestSavedDay")
      return 2
    })
    vi.spyOn(store, "updateStateMap")
    runMapResync({ store, seasonId: "s1", map: CORRECTED, confirm: true })
    expect(calls).toEqual(["begin", "latestSavedDay"])
    store.close()
  })
})
