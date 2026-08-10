import { describe, expect, it } from "vitest"
import { MAX_FACTIONS, SEASON_LENGTH } from "../config.js"
import { RISK_MAP } from "../engine/index.js"
import type { GameMap } from "../engine/index.js"
import { openStore } from "../store/sqlite.js"
import { PALETTE, runSeasonInit, shuffle } from "./season-init.js"
import { makeRng } from "../sim/policies.js"

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

describe("shuffle", () => {
  it("is a permutation, and the same seed gives the same one", () => {
    const items = RISK_MAP.territories.map((t) => t.id)
    const a = shuffle(items, makeRng(99))
    const b = shuffle(items, makeRng(99))
    expect(a).toEqual(b)
    expect([...a].sort()).toEqual([...items].sort())
    expect(a).not.toEqual(items) // 42! makes an identity shuffle vanishingly unlikely
  })

  it("does not mutate its input", () => {
    const items = ["a", "b", "c", "d"]
    shuffle(items, makeRng(1))
    expect(items).toEqual(["a", "b", "c", "d"])
  })

  it("reaches the last element", () => {
    // The classic off-by-one: `for (i = n - 1; i > 0; i--)` with `j` drawn from
    // [0, i] is correct, but drawing from [0, n) or stopping at i >= 0 is not.
    // Over many seeds every position must see more than one value.
    const seen = new Map<number, Set<string>>()
    for (let seed = 1; seed <= 200; seed++) {
      shuffle(["a", "b", "c", "d"], makeRng(seed)).forEach((v, i) => {
        const set = seen.get(i) ?? new Set()
        set.add(v)
        seen.set(i, set)
      })
    }
    for (const [, values] of seen) expect(values.size).toBe(4)
  })
})

describe("runSeasonInit", () => {
  it("deals day 0 and records the seed", () => {
    const store = withRoster(6)
    expect(init(store)).toEqual({
      status: "dealt",
      seed: 4711,
      factions: 6,
      territories: 42,
    })
    const state = store.loadState("s1", 0)
    expect(state?.day).toBe(0)
    expect(Object.keys(state?.ownership ?? {})).toHaveLength(42)
    expect(store.season("s1")).toEqual({
      seasonId: "s1",
      startDate: "2026-09-01",
      lengthDays: SEASON_LENGTH,
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

  it("supports a full 15-faction roster on a board sized for it", () => {
    // 42 territories fails checkDeal at 15 factions; 105 is the sized board.
    const store = withRoster(MAX_FACTIONS)
    const big = bigMap(105)
    expect(init(store, {}).status).toBe("refused")
    const fresh = withRoster(MAX_FACTIONS)
    expect(runSeasonInit({ store: fresh, ...BASE, map: big }).status).toBe("dealt")
    expect(fresh.loadState("s1", 0)?.factions).toHaveLength(15)
    store.close()
    fresh.close()
  })

  it("refuses every checkDeal problem with a reason naming it", () => {
    for (const [count, pattern] of [
      [3, /roster has 3 factions/],
      [MAX_FACTIONS + 1, /roster has 16 factions/],
      [15, /too few to survive/],
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
      map: { territories: [], continents: [] },
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

/** A synthetic map with `n` territories in one fully-connected continent. */
function bigMap(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => `t${String(i).padStart(3, "0")}`)
  return {
    territories: ids.map((id) => ({
      id,
      name: id,
      continent: "c",
      neighbors: ids.filter((o) => o !== id),
    })),
    continents: [{ id: "c", name: "C", bonus: 1 }],
  }
}
