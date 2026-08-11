import { COORDS } from "../map/coords.js"
import { SHAPES } from "../map/shapes.js"
import type { GameState } from "../engine/index.js"
import type { FactionId } from "../engine/index.js"
import type { OrderBody, WagerRow } from "../store/types.js"
import type { Market } from "../engine/index.js"

/**
 * Everything the browser is given, and nothing else.
 *
 * This type IS the secrecy model. `factionId` is the viewer's own; `ownership`
 * and `garrisons` are public by design; `reserve`, `plan` and `wagers` are the
 * viewer's alone. **No other faction's deploys, attacks or protect pick appears
 * here** — not hidden, not present. `protect` matters most: it is legal only
 * for an eliminated faction, so leaking it would tell the table who is about to
 * go out.
 *
 * A test asserts no foreign plan reaches the rendered page. Nothing in the type
 * system enforces it, so the type is written to make the omission obvious.
 */
export interface Projection {
  seasonId: string
  day: number
  /** The viewer. */
  factionId: FactionId
  factions: { id: FactionId; name: string; color: string }[]
  /** Public. */
  ownership: Record<string, FactionId>
  garrisons: Record<string, number>
  /** Static board data, shipped once. */
  territories: { id: string; name: string; region: string; neighbors: string[] }[]
  regions: { id: string; name: string; bonus: number }[]
  shapes: Record<string, [number, number][][]>
  centres: Record<string, { lat: number; lon: number }>
  /** The viewer's alone. */
  reserve: number
  plan: OrderBody
  wagers: WagerRow[]
  slate: Market[]
  /** Milliseconds until the tick, or 0 once it has passed. */
  msToTick: number
  locked: boolean
}

export function projectionFor(args: {
  /** The board as it stands — the state saved for `day - 1`. */
  state: GameState
  /** The day being ORDERED for, which is one past the state's own day. */
  day: number
  factionId: FactionId
  plan: OrderBody
  wagers: WagerRow[]
  slate: Market[]
  tickAt: Date
  now: Date
}): Projection {
  const { state, factionId } = args
  const msToTick = Math.max(0, args.tickAt.getTime() - args.now.getTime())
  return {
    seasonId: state.seasonId,
    // The order day, NOT state.day. The state is last night's board; the player
    // is writing orders for tonight, and showing them "Day 0" while they plan
    // day 1 is a small lie that makes the countdown nonsense.
    day: args.day,
    factionId,
    factions: state.factions.map((f) => ({ id: f.id, name: f.playerName, color: f.color })),
    ownership: state.ownership,
    garrisons: state.garrisons,
    territories: state.map.territories.map((t) => ({
      id: t.id,
      name: t.name,
      region: t.region,
      neighbors: t.neighbors,
    })),
    regions: state.map.regions.map((r) => ({ id: r.id, name: r.name, bonus: r.bonus })),
    // Only the shapes and centres for territories on THIS board.
    shapes: Object.fromEntries(
      state.map.territories.map((t) => [t.id, SHAPES[t.id] ?? []]),
    ),
    centres: Object.fromEntries(state.map.territories.map((t) => [t.id, COORDS[t.id]!])),
    reserve: state.reserves[factionId] ?? 0,
    plan: args.plan,
    wagers: args.wagers,
    slate: args.slate,
    msToTick,
    locked: msToTick === 0,
  }
}
