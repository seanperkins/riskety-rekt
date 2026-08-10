import {
  RISK_MAP,
  cmp,
  continentBonusesFor,
  createSeason,
  resolve,
  territoriesOf,
} from "../engine/index.js"
import { SEASON_LENGTH } from "../config.js"
import { POLICIES } from "./policies.js"
import { makeRng, type Rng } from "../rng.js"
import type {
  ApprovedAction,
  DailyContext,
  FactionId,
  Faction,
  Market,
  Settlement,
} from "../engine/index.js"



export interface SeasonResult {
  days: number
  winner: string
  finalTerritories: Record<string, number>
  finalReserves: Record<string, number>
  day3Leader: string
}

export interface Report {
  seasons: number
  wins: Record<string, number>
  day3LeaderWinRate: number
  meanFinalTerritories: Record<string, number>
}

function shuffled(rng: Rng): string[] {
  const a = RISK_MAP.territories.map((t) => t.id)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]!
    a[i] = a[j]!
    a[j] = tmp
  }
  return a
}

function makeSlate(day: number, rng: Rng): Market[] {
  const p = Math.round((0.15 + rng() * 0.7) * 100) / 100
  return [
    {
      id: `d${day}-m1`,
      question: `market ${day}`,
      priceYes: p,
      priceNo: Math.round((1 - p) * 100) / 100,
      closeTime: "T18:00",
    },
  ]
}

export function runSeason(policyNames: string[], seed: number): SeasonResult {
  const rng = makeRng(seed)
  const policies = policyNames.map((n) => {
    const p = POLICIES.find((x) => x.name === n)
    if (!p) throw new Error(`unknown policy: ${n}`)
    return p
  })
  const factions: Faction[] = policyNames.map((n) => ({ id: n, playerName: n, color: "#000" }))

  let state = createSeason(`sim-${seed}`, factions, shuffled(rng))
  let day3Leader = policyNames[0]!

  for (let day = 1; day <= SEASON_LENGTH; day++) {
    // No slate on the final day: a day-21 stake would pay out at a tick that
    // never runs.
    const slate = day < SEASON_LENGTH ? makeSlate(day, rng) : []

    const approvals: ApprovedAction[] = []
    // Every approved action implies a post, and the sim has no unapproved
    // posts, so this is exactly the policies that acted. Slacker, at zero
    // actions, therefore loses its veto once eliminated.
    const postedToday: FactionId[] = []
    policies.forEach((p, i) => {
      if (p.irlActionsPerDay > 0) postedToday.push(p.name)
      for (let k = 0; k < p.irlActionsPerDay; k++) {
        approvals.push({
          eventId: `${day}-${p.name}-${k}`,
          playerId: p.name,
          postedAt: `T${String(6 + i).padStart(2, "0")}:${String(k * 10).padStart(2, "0")}`,
          approvedAt: `T${String(8 + i).padStart(2, "0")}:${String(k * 10).padStart(2, "0")}`,
        })
      }
    })

    // Resolve each pending market once, by a coin weighted to its snapshotted
    // YES price. Per market, not per wager, so two factions on one market agree.
    const settlements: Record<string, Settlement> = {}
    for (const w of [...state.pending].sort((a, b) => cmp(a.marketId, b.marketId))) {
      if (settlements[w.marketId]) continue
      const pYes = w.side === "yes" ? w.price : 1 - w.price
      settlements[w.marketId] = rng() < pYes ? "yes" : "no"
    }

    const context: DailyContext = { slate, approvals, postedToday: postedToday.sort(), settlements }
    const orders = policies.map((p) => p.decide(state, p.name, slate, rng))
    state = resolve(state, orders, context)

    if (day === 3) {
      day3Leader = [...policyNames].sort(
        (a, b) => territoriesOf(state, b).length - territoriesOf(state, a).length || cmp(a, b),
      )[0]!
    }
  }

  const finalTerritories = Object.fromEntries(
    policyNames.map((n) => [n, territoriesOf(state, n).length]),
  )

  // Spec tiebreak: total troops = garrisons + reserves. Escrowed `pending` is
  // excluded, so a day-20 wager unsettled at tick 21 cannot decide a season.
  const totalTroops = Object.fromEntries(
    policyNames.map((n) => [
      n,
      territoriesOf(state, n).reduce((s, t) => s + (state.garrisons[t] ?? 0), 0) +
        (state.reserves[n] ?? 0),
    ]),
  )
  const continents = Object.fromEntries(policyNames.map((n) => [n, continentBonusesFor(state, n)]))

  const winner = [...policyNames].sort(
    (a, b) =>
      finalTerritories[b]! - finalTerritories[a]! ||
      totalTroops[b]! - totalTroops[a]! ||
      continents[b]! - continents[a]! ||
      cmp(a, b),
  )[0]!

  return {
    days: SEASON_LENGTH,
    winner,
    finalTerritories,
    finalReserves: Object.fromEntries(policyNames.map((n) => [n, state.reserves[n] ?? 0])),
    day3Leader,
  }
}

export function runMany(policyNames: string[], seasons: number): Report {
  const wins: Record<string, number> = Object.fromEntries(policyNames.map((n) => [n, 0]))
  const totals: Record<string, number> = Object.fromEntries(policyNames.map((n) => [n, 0]))
  let day3Converted = 0

  for (let i = 0; i < seasons; i++) {
    const r = runSeason(policyNames, i + 1)
    wins[r.winner] = (wins[r.winner] ?? 0) + 1
    for (const n of policyNames) totals[n] = totals[n]! + r.finalTerritories[n]!
    if (r.day3Leader === r.winner) day3Converted++
  }

  return {
    seasons,
    wins,
    day3LeaderWinRate: day3Converted / seasons,
    meanFinalTerritories: Object.fromEntries(
      policyNames.map((n) => [n, totals[n]! / seasons]),
    ),
  }
}
