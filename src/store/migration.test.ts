import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RISK_MAP, createSeason } from "../engine/index.js"
import { pendingWagersOf } from "../engine/modules/index.js"
import { MIGRATIONS } from "./schema.js"
import { openStore } from "./sqlite.js"
import type { Faction } from "../engine/index.js"

// node:sqlite must load via createRequire — Vite's builtin detection strips
// the node: prefix and the module exists under no other name.
const require_ = createRequire(import.meta.url)
const { DatabaseSync } = require_("node:sqlite") as typeof import("node:sqlite")

const factions: Faction[] = ["f1", "f2"].map((id) => ({ id, playerName: id, color: "#000" }))
const ids = RISK_MAP.territories.map((t) => t.id)

/** The migration under test: the first entry that writes moduleState. */
const MODULE_MIGRATION = MIGRATIONS.findIndex((m) => m.includes("moduleState"))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A database as it existed BEFORE the moduleState migration, with real rows. */
function preMigrationDb(pending: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rr-migration-"))
  dirs.push(dir)
  const path = join(dir, "riskety.db")
  const db = new DatabaseSync(path)
  for (let v = 0; v < MODULE_MIGRATION; v++) db.exec(MIGRATIONS[v]!)
  db.exec(`PRAGMA user_version = ${MODULE_MIGRATION}`)
  db.prepare("INSERT INTO seasons (season_id, start_date, length_days) VALUES (?, ?, ?)").run(
    "s1",
    "2026-09-01",
    14,
  )
  // The OLD state shape: `pending` in core, no moduleState.
  const { moduleState: _drop, ...rest } = createSeason("s1", factions, ids)
  const oldShape = { ...rest, pending }
  db.prepare("INSERT INTO states (season_id, day, state, engine_version) VALUES (?, ?, ?, ?)").run(
    "s1",
    0,
    JSON.stringify(oldShape),
    "1.0.0",
  )
  db.close()
  return path
}

describe("the pending -> moduleState data migration", () => {
  it("exists and the migration under test was found", () => {
    expect(MODULE_MIGRATION).toBeGreaterThan(-1)
  })

  it("rewrites a real pre-migration row so it loads, as a JSON array not a string", () => {
    const wager = {
      wagerId: "w1",
      factionId: "f1",
      marketId: "m1",
      side: "yes",
      stake: 5,
      price: 0.4,
      placedOnDay: 0,
    }
    const store = openStore(preMigrationDb([wager]))
    const state = store.loadState("s1", 0)
    expect(state).toBeDefined()
    const pending = pendingWagersOf(state!)
    expect(Array.isArray(pending)).toBe(true)
    expect(pending).toEqual([wager])
    expect((state as unknown as { pending?: unknown }).pending).toBeUndefined()
    store.close()
  })

  it("rewrites an empty pending book to an empty array", () => {
    const store = openStore(preMigrationDb([]))
    const state = store.loadState("s1", 0)
    expect(pendingWagersOf(state!)).toEqual([])
    store.close()
  })

  it("adds seasons.modules with the all-three default", () => {
    const store = openStore(preMigrationDb([]))
    expect(store.season("s1")?.modules).toEqual(["markets", "irl", "veto"])
    store.close()
  })

  it("parseState rejects a row with neither pending nor moduleState", () => {
    const path = preMigrationDb([])
    const db = new DatabaseSync(path)
    const row = db.prepare("SELECT state FROM states WHERE day = 0").get() as { state: string }
    const mangled = JSON.parse(row.state) as Record<string, unknown>
    delete mangled["pending"]
    db.prepare("UPDATE states SET state = ? WHERE day = 0").run(JSON.stringify(mangled))
    db.close()
    const store = openStore(path) // migration runs; the row has no pending to move
    expect(() => store.loadState("s1", 0)).toThrow(/moduleState/)
    store.close()
  })

  it("saveState refuses moduleState that does not survive a JSON round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-roundtrip-"))
    dirs.push(dir)
    const store = openStore(join(dir, "riskety.db"))
    store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
    const state = createSeason("s1", factions, ids)
    const corrupt = { ...state, moduleState: { markets: { pending: [], oops: undefined } } }
    expect(() =>
      store.transaction(() => store.saveState(corrupt, "1.0.0")),
    ).toThrow(/round-trip/)
    store.close()
  })
})
