import { allocateCasualties } from "./casualties.js"
import { territoriesOf } from "./setup.js"
import { cmp } from "./sort.js"
import type { FactionId, GameState, Order, TerritoryId, TickEvent } from "./types.js"

interface Movement {
  factionId: FactionId
  from: TerritoryId
  to: TerritoryId
  /** Troops that left the origin. Always deducted from the origin garrison. */
  committed: number
  /** Troops still alive after any field battle. Only these reach the target. */
  size: number
}

/**
 * Step 6 of the pipeline: protections, field battles, then simultaneous attacks.
 *
 * `state.garrisons` must already carry this tick's deploys.
 */
export function resolveCombat(
  state: GameState,
  orders: Order[],
  postedToday: FactionId[],
): {
  ownership: Record<TerritoryId, FactionId>
  garrisons: Record<TerritoryId, number>
  events: TickEvent[]
} {
  const ownership = { ...state.ownership }
  const garrisons = { ...state.garrisons }
  const events: TickEvent[] = []
  const sorted = [...orders].sort((a, b) => cmp(a.factionId, b.factionId))

  // 6a — parity protections. Both halves of the condition are load-bearing:
  // eliminated, so a living faction cannot claim a free veto while holding a
  // full army; and posted, because the veto is what an eliminated player gets
  // for showing up. Neither half may move outside the engine — the golden file
  // only pins what crosses this boundary.
  const posted = new Set(postedToday)
  const picks: Record<TerritoryId, number> = {}
  for (const o of sorted) {
    if (o.protect && posted.has(o.factionId) && territoriesOf(state, o.factionId).length === 0) {
      picks[o.protect] = (picks[o.protect] ?? 0) + 1
    }
  }
  const isProtected = new Set(Object.keys(picks).sort().filter((t) => picks[t]! % 2 === 1))
  for (const t of [...isProtected].sort()) {
    events.push({ t: "protected", territory: t, byCount: picks[t]! })
  }

  // 6a2 — reinforcements. Movers depart and arrive BEFORE any combat, so they
  // defend the destination tonight and can die doing it -- that is what "send
  // help" means to the person who ordered it. All departures are summed before
  // any arrival lands, so two territories may swap garrisons in one night
  // without the order of application mattering.
  //
  // Validation guaranteed both ends were owned by the mover LAST NIGHT and
  // capped total departures at garrison - 1, so no origin empties and no move
  // lands in enemy hands.
  const departures: Record<TerritoryId, number> = {}
  const arrivals: Record<TerritoryId, number> = {}
  for (const o of sorted) {
    for (const m of o.moves ?? []) {
      departures[m.from] = (departures[m.from] ?? 0) + m.count
      arrivals[m.to] = (arrivals[m.to] ?? 0) + m.count
      events.push({ t: "move", faction: o.factionId, from: m.from, to: m.to, count: m.count })
    }
  }
  for (const t of Object.keys(departures).sort()) {
    garrisons[t] = (garrisons[t] ?? 0) - departures[t]!
  }
  for (const t of Object.keys(arrivals).sort()) {
    garrisons[t] = (garrisons[t] ?? 0) + arrivals[t]!
  }

  // Aggregate per direction so duplicate (from, to) legs merge into one movement.
  // A protected target voids the attack entirely: those troops never leave home.
  const byDirection = new Map<string, Movement>()
  for (const o of sorted) {
    for (const a of o.attacks) {
      if (isProtected.has(a.to)) continue
      const k = `${a.from}|${a.to}`
      const existing = byDirection.get(k)
      if (existing) {
        existing.committed += a.count
        existing.size += a.count
      } else {
        byDirection.set(k, {
          factionId: o.factionId,
          from: a.from,
          to: a.to,
          committed: a.count,
          size: a.count,
        })
      }
    }
  }
  const movements = [...byDirection.values()].sort(
    (x, y) => cmp(x.from, y.from) || cmp(x.to, y.to),
  )

  // 6b — field battles on mutually attacked edges.
  // The smaller force dies; the larger continues at size - 2 * smaller. A feint
  // therefore costs the attacker twice the feint, rather than voiding the assault.
  const seenEdges = new Set<string>()
  for (const x of movements) {
    const edge = [x.from, x.to].sort().join("|")
    if (seenEdges.has(edge)) continue
    const y = byDirection.get(`${x.to}|${x.from}`)
    if (!y) continue
    seenEdges.add(edge)
    const a = x.size
    const b = y.size
    x.size = a > b ? Math.max(0, a - 2 * b) : 0
    y.size = b > a ? Math.max(0, b - 2 * a) : 0
    events.push({ t: "fieldBattle", a: x.from, b: y.from, aContinues: x.size, bContinues: y.size })
  }

  // 6c — post-departure garrisons. Everything committed has physically left,
  // including troops that then died in the field.
  for (const m of movements) {
    garrisons[m.from] = (garrisons[m.from] ?? 0) - m.committed
  }

  // 6d — resolve each contested territory.
  const targets = [...new Set(movements.filter((m) => m.size > 0).map((m) => m.to))].sort()
  for (const to of targets) {
    const arriving = movements.filter((m) => m.to === to && m.size > 0)
    const defense = garrisons[to] ?? 0
    const total = arriving.reduce((s, m) => s + m.size, 0)

    // Group by faction: allied legs from different origins fight as one force.
    const byFaction = new Map<FactionId, number>()
    for (const m of arriving) byFaction.set(m.factionId, (byFaction.get(m.factionId) ?? 0) + m.size)
    const forces = [...byFaction]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([factionId, size]) => ({ factionId, size }))

    if (total <= defense) {
      garrisons[to] = defense - total
      for (const m of arriving) {
        events.push({
          t: "attack",
          from: m.from,
          to,
          attacker: m.factionId,
          committed: m.committed,
          survivors: 0,
          captured: false,
        })
      }
      continue
    }

    const casualties = allocateCasualties(forces, defense)
    const survivors = forces
      .map((f) => ({ ...f, alive: f.size - (casualties.get(f.factionId) ?? 0) }))
      .sort((a, b) => b.alive - a.alive || b.size - a.size || cmp(a.factionId, b.factionId))
    const winner = survivors[0]!

    ownership[to] = winner.factionId
    garrisons[to] = winner.alive

    // Losing attackers' survivors withdraw to the origins they came from.
    for (const loser of survivors.slice(1)) {
      let remaining = loser.alive
      const legs = arriving
        .filter((m) => m.factionId === loser.factionId)
        .sort((a, b) => cmp(a.from, b.from))
      for (const leg of legs) {
        const back = Math.min(remaining, leg.size)
        garrisons[leg.from] = (garrisons[leg.from] ?? 0) + back
        remaining -= back
      }
    }

    for (const m of arriving) {
      events.push({
        t: "attack",
        from: m.from,
        to,
        attacker: m.factionId,
        committed: m.committed,
        survivors: m.factionId === winner.factionId ? winner.alive : 0,
        captured: m.factionId === winner.factionId,
      })
    }
  }

  return { ownership, garrisons, events }
}
