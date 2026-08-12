import { allocateCasualties } from "./casualties.js"
import { MAX_DEPARTURE_COST } from "./mechanics.js"
import { cmp } from "./sort.js"
import type { CombatDials } from "./mechanics.js"
import type { FactionId, GameState, Order, TerritoryId, TickEvent } from "./types.js"

interface Movement {
  factionId: FactionId
  from: TerritoryId
  to: TerritoryId
  /** Troops that left the origin (fee excluded). Deducted at departure. */
  committed: number
  /** Troops still alive after any field battle. Only these reach the target. */
  size: number
  /** The dial's departure cost for this movement. Deducted with committed. */
  fee: number
}

/**
 * Steps 5–6 of the pipeline: movement validation, then combat.
 *
 * `state.garrisons` must already carry this tick's ALLOCATED deploys — caps
 * computed from anything earlier would let a dropped deploy leave an attack
 * legal for troops that never arrived (phantom troops).
 *
 * Ordering inside:
 *   voided attacks (locked targets) drop first — no cap, no fee
 *   moves validate per line, fee-free, moves-first (a rejected defence loses
 *     ground already held; a rejected attack merely fails to gain)
 *   attacks merge by (from, to), THEN validate — per-line fee charging would
 *     make the price depend on how a player formats duplicate lines. An
 *     over-cap merged movement rejects whole: partial acceptance of an
 *     implicitly merged pair was an accident of line order, not a design.
 *   each merged movement consumes count + fee from the shared origin ledger,
 *     so remaining = g − Σ(count + fee) ≥ 1 — the garrison floor survives the
 *     dial by construction.
 */
export function resolveCombat(
  state: GameState,
  orders: Order[],
  locked: ReadonlySet<TerritoryId>,
  dials: CombatDials,
): {
  ownership: Record<TerritoryId, FactionId>
  garrisons: Record<TerritoryId, number>
  events: TickEvent[]
} {
  const ownership = { ...state.ownership }
  const garrisons = { ...state.garrisons }
  const events: TickEvent[] = []
  const sorted = [...orders].sort((a, b) => cmp(a.factionId, b.factionId))
  const fee = Math.min(MAX_DEPARTURE_COST, Math.max(0, dials.attackDepartureCost))

  // Caps are computed against ENTRY garrisons (post-allocation, pre-move),
  // through one shared per-origin ledger for moves and attacks — as today.
  const entry = { ...garrisons }
  const committed: Record<TerritoryId, number> = {}
  const capOf = (t: TerritoryId) => Math.max(0, (entry[t] ?? 0) - 1)

  // Moves, per line.
  const moves: { factionId: FactionId; from: TerritoryId; to: TerritoryId; count: number }[] = []
  for (const o of sorted) {
    for (const m of o.moves ?? []) {
      const used = committed[m.from] ?? 0
      if (used + m.count > capOf(m.from)) {
        events.push({
          t: "rejected",
          faction: o.factionId,
          field: "moves",
          reason: `exceeds garrison cap at ${m.from}`,
          ref: `move:${m.from}|${m.to}`,
        })
        continue
      }
      committed[m.from] = used + m.count
      moves.push({ factionId: o.factionId, from: m.from, to: m.to, count: m.count })
    }
  }

  // Voided attacks drop before merging: they consume no cap and no fee, and
  // the attacker sees why in the log (the parity events themselves are logged
  // by the engine from the lock hook's results).
  const byDirection = new Map<string, Movement>()
  for (const o of sorted) {
    for (const a of o.attacks) {
      if (locked.has(a.to)) {
        events.push({
          t: "rejected",
          faction: o.factionId,
          field: "attacks",
          reason: "protected",
          ref: `attack:${a.from}|${a.to}`,
        })
        continue
      }
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
          fee,
        })
      }
    }
  }

  // Merge-then-validate: cap each merged movement in (from, to) order.
  const movements: Movement[] = []
  for (const m of [...byDirection.values()].sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to))) {
    const used = committed[m.from] ?? 0
    if (used + m.committed + m.fee > capOf(m.from)) {
      events.push({
        t: "rejected",
        faction: m.factionId,
        field: "attacks",
        reason: `exceeds garrison cap at ${m.from}`,
        ref: `attack:${m.from}|${m.to}`,
      })
      continue
    }
    committed[m.from] = used + m.committed + m.fee
    movements.push(m)
  }

  // Reinforcements. Movers arrive BEFORE combat, defend tonight, and can die
  // doing it. All departures sum before any arrival lands.
  const departures: Record<TerritoryId, number> = {}
  const arrivals: Record<TerritoryId, number> = {}
  for (const m of moves) {
    departures[m.from] = (departures[m.from] ?? 0) + m.count
    arrivals[m.to] = (arrivals[m.to] ?? 0) + m.count
    events.push({ t: "move", faction: m.factionId, from: m.from, to: m.to, count: m.count })
  }
  for (const t of Object.keys(departures).sort()) {
    garrisons[t] = (garrisons[t] ?? 0) - departures[t]!
  }
  for (const t of Object.keys(arrivals).sort()) {
    garrisons[t] = (garrisons[t] ?? 0) + arrivals[t]!
  }

  // Field battles on mutually attacked edges. The smaller force dies; the
  // larger continues at size − 2·smaller. Each side's deaths are logged HERE
  // and nowhere else — an attack event's `lost` is target-combat only.
  const seenEdges = new Set<string>()
  for (const x of movements) {
    const edge = [x.from, x.to].sort().join("|")
    if (seenEdges.has(edge)) continue
    const y = byDirection.get(`${x.to}|${x.from}`)
    if (!y || !movements.includes(y)) continue
    seenEdges.add(edge)
    const a = x.size
    const b = y.size
    x.size = a > b ? Math.max(0, a - 2 * b) : 0
    y.size = b > a ? Math.max(0, b - 2 * a) : 0
    events.push({
      t: "fieldBattle",
      a: x.from,
      b: y.from,
      aContinues: x.size,
      bContinues: y.size,
      aLost: a - x.size,
      bLost: b - y.size,
    })
  }

  // Departure: committed + fee physically leave the origin. Fee troops are
  // casualties by definition; the accounting reads them off the attack event.
  for (const m of movements) {
    garrisons[m.from] = (garrisons[m.from] ?? 0) - m.committed - m.fee
  }

  const pushAttack = (
    m: Movement,
    r: { survivors: number; captured: boolean; lost: number; defenderLost: number },
  ) =>
    events.push({
      t: "attack",
      from: m.from,
      to: m.to,
      attacker: m.factionId,
      committed: m.committed,
      survivors: r.survivors,
      captured: r.captured,
      lost: r.lost,
      defenderLost: r.defenderLost,
      ...(m.fee > 0 ? { fee: m.fee } : {}),
    })

  // Resolve each attacked territory. EVERY departed movement emits its attack
  // event — one annihilated in a field battle keeps zero strength but its fee
  // must stay in the log, or any mutual attack on a dial day breaks the
  // accounting equality.
  const allTargets = [...new Set(movements.map((m) => m.to))].sort()
  for (const to of allTargets) {
    const here = movements.filter((m) => m.to === to)
    const arriving = here.filter((m) => m.size > 0)
    for (const m of here.filter((x) => x.size === 0)) {
      pushAttack(m, { survivors: 0, captured: false, lost: 0, defenderLost: 0 })
    }
    if (arriving.length === 0) continue

    const defense = garrisons[to] ?? 0
    const total = arriving.reduce((s, m) => s + m.size, 0)
    // defenderLost logs once per contested territory, on the surviving
    // arrival with the lexicographically-first origin — one event is pushed
    // per movement, and repeating it would sum to legs × defense.
    const carrier = [...arriving].sort((a, b) => cmp(a.from, b.from))[0]!

    if (total <= defense) {
      garrisons[to] = defense - total
      for (const m of arriving) {
        pushAttack(m, {
          survivors: 0,
          captured: false,
          lost: m.size,
          defenderLost: m === carrier ? total : 0,
        })
      }
      continue
    }

    // Group by faction: allied legs from different origins fight as one force.
    const byFaction = new Map<FactionId, number>()
    for (const m of arriving) byFaction.set(m.factionId, (byFaction.get(m.factionId) ?? 0) + m.size)
    const forces = [...byFaction]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([factionId, size]) => ({ factionId, size }))

    const casualties = allocateCasualties(forces, defense)
    const survivors = forces
      .map((f) => ({ ...f, alive: f.size - (casualties.get(f.factionId) ?? 0) }))
      .sort((a, b) => b.alive - a.alive || b.size - a.size || cmp(a.factionId, b.factionId))
    const winner = survivors[0]!

    ownership[to] = winner.factionId
    garrisons[to] = winner.alive

    // Losing attackers' survivors withdraw to the origins they came from —
    // they are ALIVE, and must not read as casualties.
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

    // Split each faction's target-combat casualties across its legs pro-rata
    // largest-remainder by leg size (reusing the allocator keyed by origin),
    // so per-leg `lost` sums exactly to the faction's allocated losses.
    const lostByLeg = new Map<Movement, number>()
    for (const f of forces) {
      const legs = arriving.filter((m) => m.factionId === f.factionId)
      const split = allocateCasualties(
        legs.map((l) => ({ factionId: l.from, size: l.size })),
        casualties.get(f.factionId) ?? 0,
      )
      for (const l of legs) lostByLeg.set(l, split.get(l.from) ?? 0)
    }

    for (const m of arriving) {
      pushAttack(m, {
        survivors: m.factionId === winner.factionId ? winner.alive : 0,
        captured: m.factionId === winner.factionId,
        lost: lostByLeg.get(m) ?? 0,
        defenderLost: m === carrier ? defense : 0,
      })
    }
  }

  return { ownership, garrisons, events }
}
