import { RISK_MAP, cmp, territoriesOf } from "../engine/index.js"
import type { FactionId, GameState, Market, Order, TerritoryId } from "../engine/index.js"
import type { Rng } from "../rng.js"

// Re-exported so existing importers keep working; the source of truth is
// src/rng.ts, which season-init and map selection also use.
export { makeRng, type Rng } from "../rng.js"

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

/** Owned territories that touch an enemy, paired with each enemy neighbour. */
function borders(state: GameState, f: FactionId): { from: TerritoryId; to: TerritoryId }[] {
  const out: { from: TerritoryId; to: TerritoryId }[] = []
  for (const t of territoriesOf(state, f)) {
    for (const n of byId.get(t)!.neighbors) {
      if (state.ownership[n] !== f) out.push({ from: t, to: n })
    }
  }
  return out.sort((a, b) => cmp(a.from + a.to, b.from + b.to))
}

interface AttackOption {
  from: TerritoryId
  to: TerritoryId
  avail: number
  def: number
  margin: number
}

/** Border attacks that would actually succeed, given post-deploy garrisons. */
function viableAttacks(
  state: GameState,
  f: FactionId,
  garrisons: Record<TerritoryId, number>,
): AttackOption[] {
  return borders(state, f)
    .map((b) => {
      const avail = Math.max(0, (garrisons[b.from] ?? 0) - 1)
      const def = garrisons[b.to] ?? 0
      return { ...b, avail, def, margin: avail - def }
    })
    .filter((o) => o.avail > 0 && o.margin > 0)
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
  const target = [...exposure].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]![0]
  return [{ territory: target, count: reserve }]
}

function withDeploys(
  state: GameState,
  deploys: Order["deploys"],
): Record<TerritoryId, number> {
  const g = { ...state.garrisons }
  for (const d of deploys) g[d.territory] = (g[d.territory] ?? 0) + d.count
  return g
}

/** Territory counts per living faction, highest first, ties by faction id. */
function standings(state: GameState): { factionId: FactionId; count: number }[] {
  return state.factions
    .map((f) => ({ factionId: f.id, count: territoriesOf(state, f.id).length }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count || cmp(a.factionId, b.factionId))
}

/**
 * An eliminated faction shields the weakest surviving faction's most exposed
 * territory — kingmaker play, and the only way the protect mechanic gets
 * exercised at all in simulation.
 */
function kingmakerProtect(state: GameState, self: FactionId): TerritoryId | null {
  if (territoriesOf(state, self).length > 0) return null
  const alive = standings(state)
  const underdog = alive[alive.length - 1]
  if (!underdog) return null
  const exposed = borders(state, underdog.factionId)
  if (exposed.length === 0) return territoriesOf(state, underdog.factionId)[0] ?? null
  const threat = new Map<TerritoryId, number>()
  for (const b of exposed) threat.set(b.from, (threat.get(b.from) ?? 0) + 1)
  return [...threat].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]![0]
}

/** Shared shell: every policy vetoes as a kingmaker once eliminated. */
function play(
  state: GameState,
  f: FactionId,
  build: (garrisons: Record<TerritoryId, number>) => Omit<Order, "factionId" | "protect">,
): Order {
  const protect = kingmakerProtect(state, f)
  if (protect !== null) return { ...empty(f), protect }
  const deploys = frontLineDeploys(state, f)
  const rest = build(withDeploys(state, deploys))
  return { ...empty(f), ...rest, deploys: rest.deploys.length > 0 ? rest.deploys : deploys }
}

const noAction = (deploys: Order["deploys"] = []) => ({ deploys, attacks: [], wagers: [] })

export const POLICIES: Policy[] = [
  {
    name: "Turtle",
    irlActionsPerDay: 1,
    decide: (s, f) => play(s, f, () => noAction()),
  },

  {
    // Grabs the softest target available. Pure opportunism.
    name: "Blitz",
    irlActionsPerDay: 1,
    decide: (s, f) =>
      play(s, f, (g) => {
        const best = viableAttacks(s, f, g).sort(
          (a, b) => b.margin - a.margin || cmp(a.from + a.to, b.from + b.to),
        )[0]
        return {
          deploys: [],
          attacks: best ? [{ from: best.from, to: best.to, count: best.avail }] : [],
          wagers: [],
        }
      }),
  },

  {
    // Fights for region bonuses: prefers targets in whichever region it is
    // closest to completing. A different strategic axis from Blitz, not a clone.
    name: "Consolidator",
    irlActionsPerDay: 1,
    decide: (s, f) =>
      play(s, f, (g) => {
        const mine = new Set(territoriesOf(s, f))
        const progress = new Map<string, number>()
        for (const c of s.map.regions) {
          const members = s.map.territories.filter((t) => t.region === c.id)
          const held = members.filter((t) => mine.has(t.id)).length
          if (held > 0 && held < members.length) progress.set(c.id, held / members.length)
        }
        const best = viableAttacks(s, f, g).sort((a, b) => {
          const pa = progress.get(byId.get(a.to)!.region) ?? 0
          const pb = progress.get(byId.get(b.to)!.region) ?? 0
          return pb - pa || b.margin - a.margin || cmp(a.from + a.to, b.from + b.to)
        })[0]
        return {
          deploys: [],
          attacks: best ? [{ from: best.from, to: best.to, count: best.avail }] : [],
          wagers: [],
        }
      }),
  },

  {
    // Attacks whoever is winning. Natural rubber-band pressure on the leader.
    name: "Hunter",
    irlActionsPerDay: 1,
    decide: (s, f) =>
      play(s, f, (g) => {
        const leader = standings(s).find((x) => x.factionId !== f)?.factionId
        const best = viableAttacks(s, f, g).sort((a, b) => {
          const la = s.ownership[a.to] === leader ? 1 : 0
          const lb = s.ownership[b.to] === leader ? 1 : 0
          return lb - la || b.margin - a.margin || cmp(a.from + a.to, b.from + b.to)
        })[0]
        return {
          deploys: [],
          attacks: best ? [{ from: best.from, to: best.to, count: best.avail }] : [],
          wagers: [],
        }
      }),
  },

  {
    // Plays the map like Blitz, but diverts half its reserve into a wager first.
    // The earlier version never deployed or attacked, so it measured the policy
    // rather than the wager economy.
    name: "Gambler",
    irlActionsPerDay: 1,
    decide: (s, f, slate, rng) => {
      const protect = kingmakerProtect(s, f)
      if (protect !== null) return { ...empty(f), protect }

      const reserve = s.reserves[f] ?? 0
      const m = slate[0]
      const stake = m ? Math.floor(reserve / 2) : 0
      const side = rng() < 0.5 ? ("yes" as const) : ("no" as const)

      const spendable = reserve - stake
      const front = frontLineDeploys({ ...s, reserves: { ...s.reserves, [f]: spendable } }, f)
      const g = withDeploys(s, front)
      const best = viableAttacks(s, f, g).sort(
        (a, b) => b.margin - a.margin || cmp(a.from + a.to, b.from + b.to),
      )[0]

      return {
        ...empty(f),
        deploys: front,
        attacks: best ? [{ from: best.from, to: best.to, count: best.avail }] : [],
        wagers: stake > 0 && m ? [{ marketId: m.id, side, stake }] : [],
      }
    },
  },

  {
    name: "Slacker",
    irlActionsPerDay: 0,
    decide: (s, f) =>
      play(s, f, (g) => {
        const best = viableAttacks(s, f, g).sort(
          (a, b) => b.margin - a.margin || cmp(a.from + a.to, b.from + b.to),
        )[0]
        return {
          deploys: [],
          attacks: best ? [{ from: best.from, to: best.to, count: best.avail }] : [],
          wagers: [],
        }
      }),
  },

  {
    // Same map play as Slacker, but posts the maximum IRL actions. The pair
    // isolates the IRL channel: any win-rate gap between them is the grant.
    name: "GymRat",
    irlActionsPerDay: 2,
    decide: (s, f) =>
      play(s, f, (g) => {
        const best = viableAttacks(s, f, g).sort(
          (a, b) => b.margin - a.margin || cmp(a.from + a.to, b.from + b.to),
        )[0]
        return {
          deploys: [],
          attacks: best ? [{ from: best.from, to: best.to, count: best.avail }] : [],
          wagers: [],
        }
      }),
  },

  {
    // Probes every exploit the review panel found. If this policy ever wins, a
    // fix regressed — a policy set that cannot express cheating cannot detect it.
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
        // 2. Over-commit: full-strength attack down every border edge at once.
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
