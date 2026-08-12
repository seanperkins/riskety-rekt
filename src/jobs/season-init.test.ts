import { describe, expect, it } from "vitest"
import { MAX_FACTIONS, SEASON_LENGTH } from "../config.js"
import { RISK_MAP } from "../engine/index.js"
import { checkDeal } from "../season.js"
import type { GameMap } from "../engine/index.js"
import { openStore } from "../store/sqlite.js"
import { PALETTE, runSeasonInit } from "./season-init.js"
import { shuffle } from "../rng.js"
import { makeRng } from "../rng.js"

const BASE = { seasonId: "s1", startDate: "2026-09-01", lengthDays: SEASON_LENGTH, seed: 4711 }

function withRoster(count: number) {
  const store = openStore(":memory:")
  for (let i = 0; i < count; i++) {
    const id = `f${String(i).padStart(2, "0")}`
    store.addRosterMember({ slackUserId: `U${id}`, factionId: id, displayName: `Player ${id}` })
  }
  return store
}

const init = (store: ReturnType<typeof openStore>, over: Partial<typeof BASE> = {}) =>
  runSeasonInit({ store, ...BASE, ...over })

describe("runSeasonInit", () => {
  it("deals day 0 and records the seed", () => {
    const store = withRoster(6)
    const out = init(store)
    expect(out).toMatchObject({ status: "dealt", seed: 4711, factions: 6 })

    // Deliberately NOT an exact territory count. The board is selected, so the
    // number moves whenever the selector is tuned -- and a test that has to be
    // edited for every tuning stops being evidence of anything. What must hold
    // is that the board is legal and every territory was dealt.
    const state = store.loadState("s1", 0)!
    expect(state.day).toBe(0)
    expect(checkDeal(6, state.map.territories.length)).toBeNull()
    expect(Object.keys(state.ownership)).toHaveLength(state.map.territories.length)
    expect(out.status === "dealt" && out.territories).toBe(state.map.territories.length)
    expect(store.season("s1")).toEqual({
      seasonId: "s1",
      startDate: "2026-09-01",
      modules: ["markets", "irl", "veto"],
      lengthDays: SEASON_LENGTH,
      seed: 4711, // recorded by insertSeason; the rule-offer draw folds it in
    })
    store.close()
  })

  it("produces the same board for the same seed and a different one otherwise", () => {
    const a = withRoster(6)
    const b = withRoster(6)
    const c = withRoster(6)
    init(a)
    init(b)
    init(c, { seed: 4712 })
    expect(a.loadState("s1", 0)?.ownership).toEqual(b.loadState("s1", 0)?.ownership)
    expect(a.loadState("s1", 0)?.ownership).not.toEqual(c.loadState("s1", 0)?.ownership)
    for (const s of [a, b, c]) s.close()
  })

  it("takes factions from the roster and colors from the palette by sorted id", () => {
    const store = withRoster(4)
    init(store)
    const factions = store.loadState("s1", 0)?.factions ?? []
    expect(factions.map((f) => f.id)).toEqual(["f00", "f01", "f02", "f03"])
    expect(factions.map((f) => f.color)).toEqual(PALETTE.slice(0, 4))
    expect(factions[0]?.playerName).toBe("Player f00")
    store.close()
  })

  it("deals a full 15-faction roster, which the 42-territory board could not", () => {
    // The whole reason the world map exists. checkDeal(15, 42) is 2.8 each, so
    // this was a hard refusal until the board became something selected from
    // the world rather than a fixed 42 territories.
    const store = withRoster(MAX_FACTIONS)
    const out = init(store)
    expect(out.status).toBe("dealt")
    const state = store.loadState("s1", 0)!
    expect(state.factions).toHaveLength(15)
    expect(checkDeal(15, state.map.territories.length)).toBeNull()
    expect(state.map.territories.length).not.toBe(42)
    store.close()
  })

  it("sizes the board to the roster", () => {
    for (const count of [4, 7, 11, 15]) {
      const store = withRoster(count)
      expect(init(store).status, `${count} factions`).toBe("dealt")
      const map = store.loadState("s1", 0)!.map
      expect(checkDeal(count, map.territories.length), `${count} factions`).toBeNull()
      store.close()
    }
  })

  it("refuses a board whose ratio is wrong, when one is supplied", () => {
    // Selection cannot produce an illegal board, so this path is only reachable
    // with an explicit map -- but the guard stays, because it is the last thing
    // between a bad board and a dealt season.
    const store = withRoster(6)
    const out = runSeasonInit({ store, ...BASE, map: bigMap(200) })
    expect(out).toMatchObject({ status: "refused" })
    expect(out.status === "refused" && out.reason).toMatch(/above the income floor/)
    store.close()
  })

  it("refuses a roster outside the faction bounds, with a reason naming it", () => {
    for (const [count, pattern] of [
      [3, /roster has 3 factions/],
      [MAX_FACTIONS + 1, /roster has 16 factions/],
    ] as const) {
      const store = withRoster(count)
      const out = init(store)
      expect(out).toMatchObject({ status: "refused" })
      expect(out.status === "refused" && out.reason).toMatch(pattern)
      store.close()
    }
  })

  it("refuses an empty territory list", () => {
    // Passes every ratio test on its own. Nobody would ever earn income, and
    // every faction is simultaneously eliminated so every faction may protect.
    const store = withRoster(6)
    const out = runSeasonInit({
      store,
      ...BASE,
      map: { territories: [], regions: [] },
    })
    expect(out).toMatchObject({ status: "refused" })
    store.close()
  })

  it("refuses a malformed start date, length or seed", () => {
    for (const over of [
      { startDate: "9/1/2026" },
      { startDate: "2026-9-1" },
      { lengthDays: 0 },
      { lengthDays: Number.NaN },
      { seed: 1.5 },
    ]) {
      const store = withRoster(6)
      expect(init(store, over)).toMatchObject({ status: "refused" })
      store.close()
    }
  })

  it("refuses a second init, and writes nothing when it does", () => {
    // The one that matters. upsertSeason silently rewrites start_date, and every
    // day in the system is derived from it -- a re-init would shift the calendar
    // under a live season and change which day every saved state belongs to.
    const store = withRoster(6)
    init(store)
    const before = store.loadState("s1", 0)
    expect(init(store, { startDate: "2026-10-01" })).toMatchObject({ status: "refused" })
    expect(store.season("s1")?.startDate).toBe("2026-09-01")
    expect(store.loadState("s1", 0)).toEqual(before)
    store.close()
  })

  it("leaves no season row when a refusal precedes the write", () => {
    const store = withRoster(3)
    expect(init(store)).toMatchObject({ status: "refused" })
    expect(store.season("s1")).toBeUndefined()
    expect(store.latestSavedDay("s1")).toBeUndefined()
    store.close()
  })

  it("rolls the season row back if dealing day 0 fails", () => {
    // The whole deal is one transaction. A season configured with no board
    // passes the tick's season lookup and then fails inside its transaction.
    const store = withRoster(6)
    const broken = {
      ...store,
      saveState: () => {
        throw new Error("disk full")
      },
    }
    expect(() => runSeasonInit({ ...BASE, store: broken })).toThrow("disk full")
    expect(store.season("s1")).toBeUndefined()
    store.close()
  })
})

/** A synthetic map with `n` territories in one fully-connected region. */
function bigMap(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => `t${String(i).padStart(3, "0")}`)
  return {
    territories: ids.map((id) => ({
      id,
      name: id,
      region: "c",
      neighbors: ids.filter((o) => o !== id),
    })),
    regions: [{ id: "c", name: "C", bonus: 1 }],
  }
}
