import { RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction, GameMap } from "../engine/index.js"
import { ENGINE_VERSION } from "../engine/index.js"
import { checkDeal } from "../season.js"
import { makeRng } from "../sim/policies.js"
import type { Rng } from "../sim/policies.js"
import type { RosterStore, SeasonStore, StateStore, Transactional } from "../store/types.js"

/**
 * Faction colors, assigned by sorted faction id.
 *
 * MAX_FACTIONS long, and `src/config.test.ts` pins that equality — a roster
 * larger than the palette would deal a board where two factions share a color,
 * which is only visible on the map the web app has not been built yet.
 */
export const PALETTE = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#42d4f4",
  "#f032e6",
  "#bfef45",
  "#fabed4",
  "#469990",
  "#dcbeff",
  "#9a6324",
  "#800000",
  "#808000",
  "#000075",
]

export type InitOutcome =
  | { status: "dealt"; seed: number; factions: number; territories: number }
  | { status: "refused"; reason: string }

export interface SeasonInitDeps {
  store: RosterStore & SeasonStore & StateStore & Transactional
  seasonId: string
  startDate: string
  lengthDays: number
  seed: number
  map?: GameMap
}

/**
 * Fisher-Yates, seeded. The engine holds no randomness by design, so the
 * shuffle happens here and the seed goes in `seasons.seed` — that is what makes
 * a deal reproducible after the fact.
 */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const a = out[i]!
    const b = out[j]!
    out[i] = b
    out[j] = a
  }
  return out
}

/**
 * Deal day 0.
 *
 * Every refusal happens BEFORE the transaction opens. `upsertSeason` silently
 * overwrites `start_date` and `length_days` on conflict, and every day in this
 * system is derived from `start_date` — so a re-init against a live season
 * would shift the calendar under it, retroactively changing which day every
 * saved state belongs to. `insertSeason` is insert-only for the same reason.
 *
 * The season row, the seed and the day-0 state go in one transaction. A partial
 * init leaves a season configured with no board, which passes the tick's season
 * lookup and then fails inside its transaction.
 */
export function runSeasonInit(deps: SeasonInitDeps): InitOutcome {
  const { store, seasonId, startDate, lengthDays, seed } = deps
  const map = deps.map ?? RISK_MAP

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { status: "refused", reason: `start date must be YYYY-MM-DD, got ${startDate}` }
  }
  if (!Number.isSafeInteger(lengthDays) || lengthDays < 1) {
    return { status: "refused", reason: `season length must be a positive integer` }
  }
  if (!Number.isSafeInteger(seed)) {
    return { status: "refused", reason: `seed must be an integer` }
  }
  if (store.season(seasonId) !== undefined) {
    return { status: "refused", reason: `season ${seasonId} already exists` }
  }
  if (store.latestSavedDay(seasonId) !== undefined) {
    return { status: "refused", reason: `season ${seasonId} already has a dealt board` }
  }

  const members = store.roster()
  const problem = checkDeal(members.length, map.territories.length)
  if (problem !== null) {
    return { status: "refused", reason: describe(problem, map.territories.length) }
  }
  if (members.length > PALETTE.length) {
    return { status: "refused", reason: `only ${PALETTE.length} colors in the palette` }
  }

  // Sorted, so the same roster always produces the same colors regardless of
  // the order rows came back in.
  const sorted = [...members].sort((a, b) => (a.factionId < b.factionId ? -1 : 1))
  const factions: Faction[] = sorted.map((m, i) => ({
    id: m.factionId,
    playerName: m.displayName,
    color: PALETTE[i]!,
  }))

  const territoryIds = shuffle(
    map.territories.map((t) => t.id),
    makeRng(seed),
  )
  // Outside the transaction on purpose: createSeason throws if the dealt set is
  // not the map's territory set, and a throw before BEGIN leaves nothing to
  // roll back.
  const state = createSeason(seasonId, factions, territoryIds, map)

  store.transaction(() => {
    store.insertSeason({ seasonId, startDate, lengthDays }, seed)
    store.saveState(state, ENGINE_VERSION)
  })

  return {
    status: "dealt",
    seed,
    factions: factions.length,
    territories: map.territories.length,
  }
}

function describe(problem: NonNullable<ReturnType<typeof checkDeal>>, territories: number): string {
  switch (problem.kind) {
    case "roster-size":
      return `roster has ${problem.factions} factions; add or remove members with "npm run roster:add"`
    case "too-few-territories":
      return `${problem.perFaction} territories per faction on a ${territories}-territory map: too few to survive one focused attack`
    case "too-many-territories":
      return `${problem.perFaction} territories per faction on a ${territories}-territory map: above the income floor`
  }
}
