import { describe, expect, it } from "vitest"
import { ENGINE_VERSION, RISK_MAP, createSeason, resolve } from "../engine/index.js"
import type { DailyContext, Faction, GameState, Order } from "../engine/index.js"
import { openStore } from "./sqlite.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }

const factions: Faction[] = ["f1", "f2"].map((id) => ({ id, playerName: id, color: "#000" }))
const dealt = (): GameState =>
  createSeason(
    SEASON.seasonId,
    factions,
    RISK_MAP.territories.map((t) => t.id),
  )

const EMPTY_CONTEXT: DailyContext = {
  slate: [],
  approvals: [],
  postedToday: [],
  settlements: {},
}

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  return store
}

describe("saveState / loadState", () => {
  it("round-trips a GameState deep-equal", () => {
    const store = seeded()
    const state = dealt()
    store.transaction(() => store.saveState(state, ENGINE_VERSION))
    expect(store.loadState("s1", 0)).toEqual(state)
    store.close()
  })

  it("round-trips a resolved state, including pending wagers and the log", () => {
    // The day-0 deal has an empty log and no pending wagers, so it exercises
    // none of the JSON that actually varies between days.
    const store = seeded()
    const next = resolve(dealt(), [], EMPTY_CONTEXT)
    store.transaction(() => store.saveState(next, ENGINE_VERSION))
    expect(store.loadState("s1", 1)).toEqual(next)
    expect(next.log.length).toBeGreaterThan(0)
    store.close()
  })

  it("is an INSERT: a second save for the same day throws", () => {
    // Not an upsert. Inside the tick's one transaction it can only run once, so
    // a second call means two ticks raced onto one day and the loser must fail
    // rather than overwrite a resolved board.
    const store = seeded()
    const state = dealt()
    store.transaction(() => store.saveState(state, ENGINE_VERSION))
    expect(() => store.transaction(() => store.saveState(state, ENGINE_VERSION))).toThrow()
    store.close()
  })

  it("returns undefined for a day that was never saved", () => {
    const store = seeded()
    expect(store.loadState("s1", 4)).toBeUndefined()
    store.close()
  })

  it("rejects a corrupt row at load rather than deep inside resolve", () => {
    // The engine assumes nothing about its arguments and re-validates, but a
    // truncated state should fail here, naming the season and day, instead of
    // surfacing as an undefined lookup six steps into the pipeline.
    const store = seeded()
    const state = dealt()
    for (const mutate of [
      (s: GameState) => delete (s as Partial<GameState>).ownership,
      (s: GameState) => delete (s as Partial<GameState>).garrisons,
      (s: GameState) => (s.map = { territories: [], regions: [] }),
      (s: GameState) => (s.reserves = { f1: -1, f2: 0 }),
      (s: GameState) => (s.reserves = { f1: 1.5, f2: 0 }),
      // A non-integer `day` is checked by parseState but deliberately not
      // exercised here: saveState writes state.day into the day COLUMN, and
      // SQLite's type ordering puts every TEXT value above every INTEGER, so
      // "x" >= 0 passes the CHECK and the row lands under day "x" -- findable
      // only by asking for "x". The check stays for a hand-edited JSON blob.
    ]) {
      const broken: GameState = structuredClone(state)
      mutate(broken)
      const fresh = openStore(":memory:")
      fresh.upsertSeason(SEASON)
      fresh.transaction(() => fresh.saveState({ ...broken, day: 0 }, ENGINE_VERSION))
      expect(() => fresh.loadState("s1", 0)).toThrow(/s1/)
      fresh.close()
    }
    store.close()
  })
})

describe("latestSavedDay", () => {
  it("is undefined for a season with no states, never 0", () => {
    // The tick distinguishes "no board was ever dealt" from "day 0 is dealt and
    // waiting". Defaulting to 0 would let an undealt season pass every guard and
    // then fail loading states[0] inside the transaction -- a stack trace where
    // a named refusal was intended.
    const store = seeded()
    expect(store.latestSavedDay("s1")).toBeUndefined()
    store.close()
  })

  it("is the highest saved day", () => {
    const store = seeded()
    const state = dealt()
    for (const day of [0, 1, 2]) {
      store.transaction(() => store.saveState({ ...state, day }, ENGINE_VERSION))
    }
    expect(store.latestSavedDay("s1")).toBe(2)
    store.close()
  })

  it("does not see another season's states", () => {
    const store = seeded()
    store.upsertSeason({ ...SEASON, seasonId: "s2" })
    store.transaction(() => store.saveState({ ...dealt(), seasonId: "s2" }, ENGINE_VERSION))
    expect(store.latestSavedDay("s1")).toBeUndefined()
    expect(store.latestSavedDay("s2")).toBe(0)
    store.close()
  })
})

describe("tick context", () => {
  it("round-trips the frozen orders and context", () => {
    // Not reconstructable after the fact: posts.deleted is an untimestamped flag
    // and removeApproval hard-deletes, so a player deleting an old photo would
    // retroactively change postedToday on replay.
    const store = seeded()
    const orders: Order[] = [
      { factionId: "f1", deploys: [], attacks: [], wagers: [], protect: "peru" },
    ]
    const context: DailyContext = {
      ...EMPTY_CONTEXT,
      postedToday: ["f1"],
      settlements: { "KX-1": "yes" },
    }
    store.transaction(() => store.saveTickContext("s1", 1, orders, context, ENGINE_VERSION))
    expect(store.loadTickContext("s1", 1)).toEqual({ orders, context, engineVersion: "1.0.0" })
    store.close()
  })

  it("returns undefined for a day with no recorded context", () => {
    const store = seeded()
    expect(store.loadTickContext("s1", 1)).toBeUndefined()
    store.close()
  })
})

describe("deleteStatesFrom", () => {
  it("removes the named day and everything after it", () => {
    const store = seeded()
    const state = dealt()
    for (const day of [0, 1, 2, 3]) {
      store.transaction(() => store.saveState({ ...state, day }, ENGINE_VERSION))
      // Day 0 is dealt, not ticked, so it has no frozen context -- migration 3
      // puts CHECK (day >= 1) on the column to say so.
      if (day >= 1) {
        store.transaction(() => store.saveTickContext("s1", day, [], EMPTY_CONTEXT, ENGINE_VERSION))
      }
    }
    store.transaction(() => store.deleteStatesFrom("s1", 2))
    expect(store.latestSavedDay("s1")).toBe(1)
    // The frozen context goes with the state, or a rerun of day 2 would replay
    // inputs while the state they produced is gone.
    expect(store.loadTickContext("s1", 2)).toBeUndefined()
    expect(store.loadTickContext("s1", 1)).toBeDefined()
    store.close()
  })

  it("leaves another season alone", () => {
    const store = seeded()
    store.upsertSeason({ ...SEASON, seasonId: "s2" })
    store.transaction(() => store.saveState({ ...dealt(), seasonId: "s2" }, ENGINE_VERSION))
    store.transaction(() => store.deleteStatesFrom("s1", 0))
    expect(store.latestSavedDay("s2")).toBe(0)
    store.close()
  })
})
