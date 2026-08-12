import {
  RISK_MAP,
  cmp,
  regionBonusesFor,
  createSeason,
  resolve,
  territoriesOf,
} from "../engine/index.js"
import { pendingWagersOf } from "../engine/modules/index.js"
import { SEASON_LENGTH } from "../config.js"
import { POLICIES } from "./policies.js"
import { makeRng, type Rng } from "../rng.js"
import { clusteredOrder } from "../map/deal.js"
import { selectSubMap } from "../map/select.js"
import { WORLD } from "../map/world.js"
import type {
  ApprovedAction,
  DailyContext,
  FactionId,
  Faction,
  Market,
  Settlement,
} from "../engine/index.js"



/**
 * One seat at the table. Distinct from a policy, because a roster larger than
 * the policy set has to repeat policies — a 15-faction season from 8 policies
 * seats some of them twice.
 */
export interface Seat {
  /** Unique faction id. `Blitz` when alone, `Blitz#1` / `Blitz#2` when repeated. */
  id: string
  /** Which policy plays this seat. */
  policy: string
}

export interface SeasonResult {
  days: number
  /** Size of the board this season was dealt. Varies: the board is selected. */
  territories: number
  seats: Seat[]
  /** A seat id, not a policy name. */
  winner: string
  finalTerritories: Record<string, number>
  finalReserves: Record<string, number>
  day3Leader: string
}

export interface Report {
  seasons: number
  /** Mean board size across the run. The board is selected, so it varies. */
  meanTerritories: number
  /** Seats held per policy. A policy's win baseline is seats / roster size. */
  seats: Record<string, number>
  wins: Record<string, number>
  day3LeaderWinRate: number
  meanFinalTerritories: Record<string, number>
}

/**
 * The sim's synthetic calendar. A market closes at 18:00 of its day and the
 * tick fires at 21:00 — close STRICTLY before tick, mirroring the publisher's
 * window. This ordering is load-bearing: wager claims lock at close, deploy
 * claims at the tick, and inverting them would silently measure the pre-fix
 * (deploys-senior) game while reporting it as the balance run.
 */
export function simInstant(day: number, hour: number): string {
  return new Date(Date.UTC(2026, 0, 1 + day, hour)).toISOString()
}

function makeSlate(day: number, rng: Rng): Market[] {
  const p = Math.round((0.15 + rng() * 0.7) * 100) / 100
  return [
    {
      id: `d${day}-m1`,
      question: `market ${day}`,
      priceYes: p,
      priceNo: Math.round((1 - p) * 100) / 100,
      closeTime: simInstant(day, 18),
    },
  ]
}

/**
 * Seat ids for a roster, distinct even when a policy repeats.
 *
 * Faction ids used to be the policy names directly, which silently broke a
 * roster with repeats: two `Blitz` seats shared one faction id and one reserve,
 * both spent from it, and the engine's closing invariant fired with "reserve
 * for Blitz is -2". The engine caught it, but only after the season was
 * meaningless.
 *
 * A policy that appears once keeps its bare name, so existing rosters and every
 * committed balance figure stay comparable.
 */
export function seatsFor(policyNames: string[]): Seat[] {
  const total = new Map<string, number>()
  for (const n of policyNames) total.set(n, (total.get(n) ?? 0) + 1)
  const used = new Map<string, number>()
  return policyNames.map((policy) => {
    if ((total.get(policy) ?? 0) === 1) return { id: policy, policy }
    const n = (used.get(policy) ?? 0) + 1
    used.set(policy, n)
    return { id: `${policy}#${n}`, policy }
  })
}

export function runSeason(policyNames: string[], seed: number): SeasonResult {
  const rng = makeRng(seed)
  const policies = policyNames.map((n) => {
    const p = POLICIES.find((x) => x.name === n)
    if (!p) throw new Error(`unknown policy: ${n}`)
    return p
  })
  const seats = seatsFor(policyNames)
  const factions: Faction[] = seats.map((s) => ({ id: s.id, playerName: s.policy, color: "#000" }))

  // The board is SELECTED, exactly as season-init selects it, and from one rng
  // in the same order. Measuring balance on RISK_MAP while every real season
  // plays a selected sub-map is the same defect as SEASON_DAYS versus
  // SEASON_LENGTH: two things that drift apart until the measurement describes
  // a game nobody plays.
  const map = selectSubMap(WORLD, policyNames.length, rng)
  let state = createSeason(
    `sim-${seed}`,
    factions,
    // The same deal season-init uses. Two things that drift apart until the
    // measurement describes a game nobody plays.
    clusteredOrder(map, factions.length, rng),
    map,
  )
  const seatIds = seats.map((s) => s.id)
  let day3Leader = seatIds[0]!

  for (let day = 1; day <= SEASON_LENGTH; day++) {
    // No slate on the final day: a day-21 stake would pay out at a tick that
    // never runs.
    const slate = day < SEASON_LENGTH ? makeSlate(day, rng) : []

    const approvals: ApprovedAction[] = []
    // Every approved action implies a post, and the sim has no unapproved
    // posts, so this is exactly the policies that acted. Slacker, at zero
    // actions, therefore loses its veto once eliminated.
    const postedToday: FactionId[] = []
    // Grants key on SEAT ids. Keying on the policy name silently lost every
    // IRL grant on a repeated-policy roster — the old engine dropped a grant
    // for an unknown faction on the floor; the module engine refuses it.
    policies.forEach((p, i) => {
      if (p.irlActionsPerDay > 0) postedToday.push(seatIds[i]!)
      for (let k = 0; k < p.irlActionsPerDay; k++) {
        approvals.push({
          eventId: `${day}-${p.name}-${k}`,
          playerId: seatIds[i]!,
          postedAt: `T${String(6 + i).padStart(2, "0")}:${String(k * 10).padStart(2, "0")}`,
          approvedAt: `T${String(8 + i).padStart(2, "0")}:${String(k * 10).padStart(2, "0")}`,
        })
      }
    })

    // Resolve each pending market once, by a coin weighted to its snapshotted
    // YES price. Per market, not per wager, so two factions on one market agree.
    const settlements: Record<string, Settlement> = {}
    for (const w of [...pendingWagersOf(state)].sort((a, b) => cmp(a.marketId, b.marketId))) {
      if (settlements[w.marketId]) continue
      const pYes = w.side === "yes" ? w.price : 1 - w.price
      settlements[w.marketId] = rng() < pYes ? "yes" : "no"
    }

    const context: DailyContext = {
      slate,
      approvals,
      postedToday: postedToday.sort(),
      settlements,
      tickInstant: simInstant(day, 21),
      modules: ["markets", "irl", "veto"],
      rules: [],
    }
    const orders = policies.map((p, i) => p.decide(state, seatIds[i]!, slate, rng))
    state = resolve(state, orders, context)

    if (day === 3) {
      day3Leader = [...seatIds].sort(
        (a, b) => territoriesOf(state, b).length - territoriesOf(state, a).length || cmp(a, b),
      )[0]!
    }
  }

  const finalTerritories = Object.fromEntries(
    seatIds.map((n) => [n, territoriesOf(state, n).length]),
  )

  // Spec tiebreak: total troops = garrisons + reserves. Escrowed `pending` is
  // excluded, so a day-20 wager unsettled at tick 21 cannot decide a season.
  const totalTroops = Object.fromEntries(
    seatIds.map((n) => [
      n,
      territoriesOf(state, n).reduce((s, t) => s + (state.garrisons[t] ?? 0), 0) +
        (state.reserves[n] ?? 0),
    ]),
  )
  const regions = Object.fromEntries(seatIds.map((n) => [n, regionBonusesFor(state, n)]))

  const winner = [...seatIds].sort(
    (a, b) =>
      finalTerritories[b]! - finalTerritories[a]! ||
      totalTroops[b]! - totalTroops[a]! ||
      regions[b]! - regions[a]! ||
      cmp(a, b),
  )[0]!

  return {
    days: SEASON_LENGTH,
    territories: map.territories.length,
    seats,
    winner,
    finalTerritories,
    finalReserves: Object.fromEntries(seatIds.map((n) => [n, state.reserves[n] ?? 0])),
    day3Leader,
  }
}

/**
 * Aggregated by POLICY, not by seat.
 *
 * A roster larger than the policy set repeats policies, so a policy can hold
 * several seats. Its wins are summed across them — which means its baseline is
 * `seats / roster size`, NOT `1 / roster size`. `seats` is reported so that
 * baseline is computable rather than assumed; comparing a two-seat policy's
 * win rate against a one-seat policy's without it would be wrong by a factor of
 * two.
 */
export function runMany(policyNames: string[], seasons: number): Report {
  const seats = seatsFor(policyNames)
  const policyOf = new Map(seats.map((s) => [s.id, s.policy]))
  const seatCount: Record<string, number> = {}
  for (const s of seats) seatCount[s.policy] = (seatCount[s.policy] ?? 0) + 1

  const names = [...new Set(policyNames)]
  const wins: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]))
  const totals: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]))
  let day3Converted = 0
  let territories = 0

  for (let i = 0; i < seasons; i++) {
    const r = runSeason(policyNames, i + 1)
    const winnerPolicy = policyOf.get(r.winner)
    if (winnerPolicy !== undefined) wins[winnerPolicy] = (wins[winnerPolicy] ?? 0) + 1
    for (const s of seats) totals[s.policy] = totals[s.policy]! + r.finalTerritories[s.id]!
    if (r.day3Leader === r.winner) day3Converted++
    territories += r.territories
  }

  return {
    seasons,
    meanTerritories: territories / seasons,
    seats: seatCount,
    wins,
    day3LeaderWinRate: day3Converted / seasons,
    // Per SEAT, so a two-seat policy is not reported as holding twice as much
    // ground as an equally successful one-seat policy.
    meanFinalTerritories: Object.fromEntries(
      names.map((n) => [n, totals[n]! / seasons / (seatCount[n] ?? 1)]),
    ),
  }
}
