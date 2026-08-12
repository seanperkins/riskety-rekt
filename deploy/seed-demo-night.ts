/**
 * Play the demo board forward a few nights, so it has something to replay.
 *
 *   tsx deploy/seed-demo-night.ts [nights]
 *
 * Demo database ONLY. It refuses anything else, for the same reason
 * seed-demo.sh does: the roster has no season column, so the demo is separated
 * by database FILE, not by season id.
 *
 * Why not the tick job: `runTick` resolves the day the CALENDAR says it is, one
 * per real day. A demo needs several nights to exist right now, and the first
 * night of any season is income-only anyway — everyone starts at zero reserve
 * on an evenly dealt board, so nothing can move and there is nothing to watch.
 *
 * So this drives the ENGINE directly, exactly as the simulator does, and saves
 * each resulting state. The log the replay animates is therefore produced by
 * the same `resolve` a real season runs — not fabricated, and not a second
 * implementation. Orders come from the simulator's own policies, which is what
 * makes the nights look like a game rather than a script.
 *
 * What it deliberately does NOT do: wagers. A settled market needs a published
 * slate and the settlement poller, and no timer points at this database. The
 * bank shows income and workouts; market payouts only appear in a real season.
 */
import { resolve, ENGINE_VERSION } from "../src/engine/index.js"
import type { ApprovedAction, DailyContext, GameState, Order } from "../src/engine/index.js"
import { POLICIES } from "../src/sim/policies.js"
import { makeRng } from "../src/rng.js"
import { openStore } from "../src/store/sqlite.js"

const dbPath = process.env.RR_DB_PATH ?? ""
if (!dbPath.endsWith("demo.db")) {
  console.error("refusing: RR_DB_PATH is not the demo database")
  process.exit(1)
}
const seasonId = process.env.RR_SEASON_ID ?? "demo"
const nights = Number(process.argv[2] ?? 3)
if (!Number.isSafeInteger(nights) || nights < 1 || nights > 12) {
  console.error(`nights must be 1-12, got ${String(process.argv[2])}`)
  process.exit(1)
}

/**
 * A mix, so a night has more than one shape in it. Swarm presses every front it
 * can afford and is what puts several attacks on screen at once; Hunter goes
 * for whoever is ahead, which is what produces the mutual attacks that resolve
 * as field battles.
 */
const CAST = ["Swarm", "Blitz", "Consolidator", "Hunter", "Turtle", "GymRat"]

const store = openStore(dbPath)
try {
  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`unknown season ${seasonId} — run seed-demo.sh first`)

  const start = store.latestSavedDay(seasonId) ?? 0
  let state = store.loadState(seasonId, start)
  if (state === undefined) throw new Error(`no state saved for day ${start}`)

  for (let n = 1; n <= nights; n++) {
    const day = state.day + 1
    const rng = makeRng(9000 + day)

    // Two players post a workout and are approved, so the bank shows the IRL
    // channel alongside income rather than income alone.
    const posters = state.factions.slice(0, 2).map((f) => f.id)
    const approvals: ApprovedAction[] = posters.map((playerId, i) => ({
      eventId: `demo-${day}-${playerId}`,
      playerId,
      postedAt: `2026-01-0${1 + (i % 8)}T07:0${i}:00Z`,
      approvedAt: `2026-01-0${1 + (i % 8)}T09:0${i}:00Z`,
    }))

    const orders: Order[] = state.factions.map((f, i) => {
      const policy = POLICIES.find((p) => p.name === CAST[i % CAST.length])!
      const o = policy.decide(state!, f.id, [], rng)
      // Wagers need a slate; there is none here. Everything else stands.
      return { ...o, wagers: [] }
    })

    const ctx: DailyContext = {
      slate: [],
      approvals,
      postedToday: [...posters].sort(),
      settlements: {},
      tickInstant: new Date(Date.UTC(2026, 0, 1 + day, 2)).toISOString(),
      modules: season.modules ?? ["markets", "irl", "veto"],
      rules: [],
    }

    const next: GameState = resolve(state, orders, ctx)
    store.saveState(next, ENGINE_VERSION)
    const kinds = next.log.reduce<Record<string, number>>((acc, e) => {
      acc[e.t] = (acc[e.t] ?? 0) + 1
      return acc
    }, {})
    console.log(
      `day ${next.day}: ${next.log.length} events — ` +
        Object.entries(kinds)
          .sort()
          .map(([k, v]) => `${k} ${v}`)
          .join(", "),
    )
    state = next
  }
  console.log(`\ndemo is at day ${state.day}; the replay is /day/${state.day}`)
} finally {
  store.close()
}
