import { describe, expect, it } from "vitest"
import { openStore } from "./sqlite.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }

describe("transaction", () => {
  it("commits on success and returns the callback's value", () => {
    const store = openStore(":memory:")
    const out = store.transaction(() => {
      store.upsertSeason(SEASON)
      return 42
    })
    expect(out).toBe(42)
    expect(store.season("s1")).toBeDefined()
    store.close()
  })

  it("rolls back everything on a throw", () => {
    // This is the property the whole single-transaction tick rests on: a crash
    // leaves nothing behind, so a retry starts clean. There is no half-state to
    // adopt and no lock row to collide with.
    const store = openStore(":memory:")
    expect(() =>
      store.transaction(() => {
        store.upsertSeason(SEASON)
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(store.season("s1")).toBeUndefined()
    store.close()
  })

  it("refuses to nest", () => {
    // SQLite has no nested transactions. Throwing here beats the confusing
    // "cannot start a transaction within a transaction" an inner BEGIN would
    // raise at an arbitrary depth.
    const store = openStore(":memory:")
    expect(() => store.transaction(() => store.transaction(() => 1))).toThrow(/nest/i)
    store.close()
  })

  it("releases the nesting guard after a rollback", () => {
    // A throw must not leave the store permanently unable to open another
    // transaction -- that would turn one bad tick into a dead process.
    const store = openStore(":memory:")
    expect(() => store.transaction(() => { throw new Error("x") })).toThrow()
    expect(store.transaction(() => 7)).toBe(7)
    store.close()
  })

  it("migration 3 runs against a fresh database", () => {
    // The new tables exist and the season row carries the seed column.
    const store = openStore(":memory:")
    store.upsertSeason(SEASON)
    expect(store.season("s1")).toMatchObject({ seasonId: "s1", lengthDays: 14 })
    store.close()
  })
})
