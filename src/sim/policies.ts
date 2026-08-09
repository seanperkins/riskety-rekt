import { RISK_MAP, territoriesOf } from "../engine/index.js"
import type { FactionId, GameState, Market, Order, TerritoryId } from "../engine/index.js"

export type Rng = () => number

/** xorshift32 — deterministic for a seed, so seasons replay exactly. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

export interface Policy {
  name: string
  /** How many approved IRL actions this policy posts per day (0-2). */
  irlActionsPerDay: number
  decide(state: GameState, factionId: FactionId, slate: Market[], rng: Rng): Order
}

const byId = new Map(RISK_MAP.territories.map((t) => [t.id, t]))

const empty = (factionId: FactionId): Order => ({
  factionId,
  deploys: [],
  attacks: [],
  wagers: [],
  protect: null,
})

/** Owned territories that touch an enemy, with their enemy neighbours. */
function borders(state: GameState, f: FactionId): { from: TerritoryId; to: TerritoryId }[] {
  const out: { from: TerritoryId; to: TerritoryId }[] = []
  for (const t of territoriesOf(state, f)) {
    for (const n of byId.get(t)!.neighbors) {
      if (state.ownership[n] !== f) out.push({ from: t, to: n })
    }
  }
  return out.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1))
}

/** Put the whole reserve into the most exposed front-line territory. */
function frontLineDeploys(state: GameState, f: FactionId): Order["deploys"] {
  const reserve = state.reserves[f] ?? 0
  if (reserve === 0) return []
  const front = borders(state, f)
  if (front.length === 0) {
    const mine = territoriesOf(state, f)
    return mine.length > 0 ? [{ territory: mine[0]!, count: reserve }] : []
  }
  const exposure = new Map<TerritoryId, number>()
  for (const b of front) exposure.set(b.from, (exposure.get(b.from) ?? 0) + 1)
  const target = [...exposure]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0]
  return [{ territory: target, count: reserve }]
}

export const POLICIES: Policy[] = [
  {
    name: "Turtle",
    irlActionsPerDay: 1,
    decide: (s, f) => ({ ...empty(f), deploys: frontLineDeploys(s, f) }),
  },

  {
    name: "Blitz",
    irlActionsPerDay: 1,
    decide: (s, f) => {
      const deploys = frontLineDeploys(s, f)
      const garrisons = { ...s.garrisons }
      for (const d of deploys) garrisons[d.territory] = (garrisons[d.territory] ?? 0) + d.count

      // Attack the weakest reachable enemy from the strongest launch point.
      const options = borders(s, f)
        .map((b) => ({ ...b, avail: Math.max(0, (garrisons[b.from] ?? 0) - 1), def: garrisons[b.to] ?? 0 }))
        .filter((b) => b.avail > b.def && b.avail > 0)
        .sort((a, b) => b.avail - b.def - (a.avail - a.def) || (a.from + a.to < b.from + b.to ? -1 : 1))

      const best = options[0]
      return {
        ...empty(f),
        deploys,
        attacks: best ? [{ from: best.from, to: best.to, count: best.avail }] : [],
      }
    },
  },

  {
    name: "Gambler",
    irlActionsPerDay: 1,
    decide: (s, f, slate, rng) => {
      const reserve = s.reserves[f] ?? 0
      const m = slate[0]
      if (!m || reserve === 0) return { ...empty(f), deploys: frontLineDeploys(s, f) }
      return {
        ...empty(f),
        wagers: [{ marketId: m.id, side: rng() < 0.5 ? "yes" : "no", stake: reserve }],
      }
    },
  },

  {
    name: "Slacker",
    irlActionsPerDay: 0,
    decide: (s, f) => ({ ...empty(f), deploys: frontLineDeploys(s, f) }),
  },

  {
    name: "GymRat",
    irlActionsPerDay: 2,
    decide: (s, f) => ({ ...empty(f), deploys: frontLineDeploys(s, f) }),
  },

  {
    // Probes every exploit the review panel found. If this policy ever wins,
    // a fix regressed — a policy set that cannot express cheating cannot
    // detect it, which is exactly why the original five missed the hedge.
    name: "Arbitrageur",
    irlActionsPerDay: 2,
    decide: (s, f, slate) => {
      const reserve = s.reserves[f] ?? 0
      const mine = territoriesOf(s, f)
      const order = empty(f)
      const m = slate[0]

      // 1. Stake both sides of one market proportionally to price.
      if (m && reserve > 0) {
        order.wagers = [
          { marketId: m.id, side: "yes" as const, stake: Math.floor(reserve * m.priceYes) },
          { marketId: m.id, side: "no" as const, stake: Math.floor(reserve * m.priceNo) },
        ].filter((w) => w.stake > 0)
      }

      const from = mine[0]
      if (from) {
        // 2. Over-commit: send a full-strength attack down every border edge.
        const g = s.garrisons[from] ?? 0
        order.attacks = byId
          .get(from)!
          .neighbors.filter((n) => s.ownership[n] !== f)
          .map((to) => ({ from, to, count: Math.max(0, g - 1) }))
          .filter((a) => a.count > 0)

        // 3. Deploy beyond the reserve.
        order.deploys = [{ territory: from, count: reserve + 50 }]
      }

      // 4. Claim a protection while still alive.
      order.protect = mine[0] ?? null
      return order
    },
  },
]
