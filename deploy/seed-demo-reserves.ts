/**
 * Give every demo faction a reserve to spend.
 *
 *   RR_DB_PATH=/srv/riskety-rekt/data/demo.db npx tsx deploy/seed-demo-reserves.ts [n]
 *
 * The demo board is dealt and never ticks, so income never arrives and every
 * reserve sits at zero — which leaves the whole deploy interaction
 * unreachable. This writes a reserve straight into the stored day-0 state so
 * the board can actually be played with.
 *
 * DEMO DATABASE ONLY. It refuses anything else: this edits a saved state
 * in place, which is exactly the thing that must never happen to a real season.
 */
import { createRequire } from "node:module"
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite"

const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSyncCtor }

const path = process.env.RR_DB_PATH ?? ""
if (!path.endsWith("demo.db")) {
  console.error("refusing: RR_DB_PATH is not the demo database")
  process.exit(1)
}
const amount = Number(process.argv[2] ?? 12)
if (!Number.isSafeInteger(amount) || amount < 0) {
  console.error("usage: seed-demo-reserves.ts [soldiers]")
  process.exit(2)
}

const db = new DatabaseSync(path)
const rows = db.prepare("SELECT season_id, day, state FROM states").all() as {
  season_id: string
  day: number
  state: string
}[]

for (const row of rows) {
  const state = JSON.parse(row.state) as { reserves: Record<string, number> }
  for (const id of Object.keys(state.reserves)) state.reserves[id] = amount
  db.prepare("UPDATE states SET state = ? WHERE season_id = ? AND day = ?").run(
    JSON.stringify(state),
    row.season_id,
    row.day,
  )
  console.log(`${row.season_id} day ${row.day}: ${Object.keys(state.reserves).length} factions -> ${amount}`)
}
db.close()
