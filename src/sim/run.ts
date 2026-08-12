import {
  RISK_MAP,
  cmp,
  regionBonusesFor,
  createSeason,
  resolve,
  territoriesOf,
} from "../engine/index.js"
import { pendingWagersOf } from "../engine/modules/index.js"
import { RULE_CATALOGUE } from "../engine/rules/index.js"
import { RULES_PER_OFFER, SEASON_LENGTH } from "../config.js"
import { POLICIES } from "./policies.js"
import { makeRng, shuffle, type Rng } from "../rng.js"
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
  /** Seat ids holding zero territories at the final tick. */
  eliminated: string[]
  /** Veto picks submitted by an eliminated faction, across the season. */
  vetoesOffered: number
  /** Of those, silently dropped because the faction had not posted that day. */
  vetoesGated: number
  /** `protected` events the engine logged — offers that survived the parity. */
  protectionsApplied: number
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
  /** Share of a policy's seat-seasons that ended with zero territories. */
  eliminationRate: Record<string, number>
  /** Season totals for the veto gate, summed across the run. */
  vetoesOffered: number
  vetoesGated: number
  protectionsApplied: number
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

/**
 * `clustered` is what season-init deals and therefore the only figure worth
 * committing. `shuffled` is the pre-`ec692fd` scattered deal, kept as a
 * measurement arm: that commit named the contiguous holding as the reason an
 * early lead persists, and this is how the claim stays checkable rather than
 * remembered. The two arms consume the rng differently, so they are NOT paired
 * on a seed — compare them at large n, never season by season.
 */
export type Deal = "clustered" | "shuffled"

export function runSeason(
  policyNames: string[],
  seed: number,
  opts: { modules?: string[]; rules?: string[]; voteRules?: boolean; deal?: Deal } = {},
): SeasonResult {
  const modules = opts.modules ?? ["markets", "irl", "veto"]
  const rng = makeRng(seed)
  // A second stream, used ONLY by the daily rule vote — see the draw below.
  // Off the main stream, so every arm stays paired with baseline on a seed.
  const voteRng = makeRng((seed ^ 0x5bf03635) >>> 0)
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
    opts.deal === "shuffled"
      ? shuffle(
          map.territories.map((t) => t.id),
          rng,
        )
      : clusteredOrder(map, factions.length, rng),
    map,
  )
  const seatIds = seats.map((s) => s.id)
  let day3Leader = seatIds[0]!
  let vetoesOffered = 0
  let vetoesGated = 0
  let protectionsApplied = 0

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

    // Forced rules are the gate's stress arm; voteRules is the dynamics arm —
    // a seeded daily draw with uniform-random seat votes (abstain ½),
    // plurality, ties to the lowest rule id. The model is deliberately
    // strategy-free; the balance review doc states it.
    //
    // BOTH arms draw from `voteRng`, a SEPARATE stream, never the season's
    // `rng`. That is what makes every arm paired with baseline on a seed
    // (common random numbers): the board, the deal, the slate prices, the
    // settlement coins and every policy decision consume the main stream in
    // the same order whether rules are on or off, so a measured difference is
    // the rules and not a reshuffled world. Sharing one stream made the voted
    // arm diverge for reasons that had nothing to do with rules, which is
    // exactly the confound the gate exists to exclude.
    let rules: string[] = opts.rules ?? []
    if (opts.voteRules === true) {
      // The SAME ballot size the season draws (src/config.ts). Each rule's
      // share of days is the catalogue's main balance lever, so a sim that
      // offered a different number would measure a game nobody plays.
      const offered = shuffle([...RULE_CATALOGUE], voteRng).slice(0, RULES_PER_OFFER)
      const counts = new Map<string, number>()
      for (let i = 0; i < seatIds.length; i++) {
        if (voteRng() < 0.5) continue
        const pick = offered[Math.floor(voteRng() * offered.length)]!
        counts.set(pick.id, (counts.get(pick.id) ?? 0) + 1)
      }
      let winner: string | undefined
      let best = 0
      for (const [id, n] of counts) {
        if (n > best || (n === best && winner !== undefined && id < winner)) {
          winner = id
          best = n
        }
      }
      rules = winner === undefined ? [] : [winner]
    }

    const context: DailyContext = {
      slate,
      approvals,
      postedToday: postedToday.sort(),
      settlements,
      tickInstant: simInstant(day, 21),
      modules,
      rules,
    }
    const orders = policies.map((p, i) => p.decide(state, seatIds[i]!, slate, rng))

    // Veto accounting, read BEFORE resolve: an offer that the post gate drops
    // leaves no trace in the log at all — `lock` filters it silently — so the
    // only place the gate is observable is here, against the input state.
    const posted = new Set(context.postedToday)
    for (const o of orders) {
      if (o.protect === null || territoriesOf(state, o.factionId).length > 0) continue
      vetoesOffered++
      if (!posted.has(o.factionId)) vetoesGated++
    }

    state = resolve(state, orders, context)
    protectionsApplied += state.log.filter((e) => e.t === "protected").length

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
    eliminated: seatIds.filter((n) => finalTerritories[n] === 0),
    vetoesOffered,
    vetoesGated,
    protectionsApplied,
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
export function runMany(policyNames: string[], seasons: number, opts: { deal?: Deal } = {}): Report {
  const seats = seatsFor(policyNames)
  const policyOf = new Map(seats.map((s) => [s.id, s.policy]))
  const seatCount: Record<string, number> = {}
  for (const s of seats) seatCount[s.policy] = (seatCount[s.policy] ?? 0) + 1

  const names = [...new Set(policyNames)]
  const wins: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]))
  const totals: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]))
  const deaths: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]))
  let day3Converted = 0
  let territories = 0
  let vetoesOffered = 0
  let vetoesGated = 0
  let protectionsApplied = 0

  for (let i = 0; i < seasons; i++) {
    const r = runSeason(policyNames, i + 1, opts)
    const winnerPolicy = policyOf.get(r.winner)
    if (winnerPolicy !== undefined) wins[winnerPolicy] = (wins[winnerPolicy] ?? 0) + 1
    for (const s of seats) totals[s.policy] = totals[s.policy]! + r.finalTerritories[s.id]!
    for (const id of r.eliminated) {
      const p = policyOf.get(id)
      if (p !== undefined) deaths[p] = (deaths[p] ?? 0) + 1
    }
    if (r.day3Leader === r.winner) day3Converted++
    territories += r.territories
    vetoesOffered += r.vetoesOffered
    vetoesGated += r.vetoesGated
    protectionsApplied += r.protectionsApplied
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
    // Per SEAT-season, for the same reason mean territories is.
    eliminationRate: Object.fromEntries(
      names.map((n) => [n, deaths[n]! / seasons / (seatCount[n] ?? 1)]),
    ),
    vetoesOffered,
    vetoesGated,
    protectionsApplied,
  }
}
