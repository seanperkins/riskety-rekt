import { COORDS } from "../map/coords.js"
import { LABELS, LABEL_BOXES, REGION_OUTLINES, SHAPES, SHAPES_FINE } from "../map/shapes.js"
import { SEA_LINKS } from "../map/world.js"
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
  /**
   * Where to draw a territory's garrison count: the point furthest inside its
   * own coastline, computed at build time. `centres` is the hand-entered
   * country centroid and drifts visibly off the drawn shape when zoomed in.
   */
  labels: Record<string, { lat: number; lon: number }>
  /**
   * The largest label-shaped rectangle that fits INSIDE each territory, as
   * [west, south, east, north]. Its centre is the matching `labels` entry.
   *
   * This is the room a garrison count actually has. Measuring the territory's
   * BOUNDING box instead overstates it badly for anything not roughly
   * rectangular — Norway's bounding box is enormous and its interior is a few
   * kilometres wide, so the number passed the fit test and sat in the sea.
   */
  labelBoxes: Record<string, [number, number, number, number]>
  /**
   * Each region's OUTER boundary, internal borders dissolved.
   *
   * Hovering a region outlines the region. Stroking each of its territories
   * instead draws every border inside it too, so the region reads as a bundle
   * of shapes rather than one area.
   */
  regionOutlines: Record<string, [number, number][][]>
  /**
   * Every territory NOT on this board, drawn as inert grey background.
   *
   * Context, not state: a board of 70 territories floating in an empty sea
   * gives no sense of where it sits, and a player cannot tell an ocean from a
   * country nobody was dealt. These carry no ownership, no garrison and no
   * interaction — they exist so the world is legible.
   *
   * Safe by construction: SHAPES is static, public, generated from Natural
   * Earth, and identical for every viewer. Nothing here is derived from state.
   */
  offBoard: Record<string, [number, number][][]>
  /**
   * Borders that cross water, as ordered pairs of board territories.
   *
   * `neighbors` merges land borders and sea links into one list, so by the time
   * the map reaches a player there is no way to tell that Tunisia and Sicily are
   * adjacent across the Sicilian narrows rather than by land. Drawn, a sea link
   * explains an attack that otherwise looks impossible.
   */
  seaLinks: [string, string][]
  /**
   * The board's territories at close-up resolution, swapped in once the map is
   * zoomed past the point where the coarse rings show their chords.
   *
   * Board only. The backdrop stays coarse at every zoom -- it is drawn at 45%
   * opacity behind everything and nobody inspects its coastline.
   */
  shapesFine: Record<string, [number, number][][]>
  /** The viewer's alone. */
  reserve: number
  plan: OrderBody
  /**
   * ABSENT — not empty — for a markets-off season, and the wagers panel,
   * nav link and page are absent with them. Optional so a partial sweep is a
   * type error at the read sites rather than a ghost UI.
   */
  wagers?: WagerRow[]
  slate?: Market[]
  /** The season's enabled modules; the client renders only what is on. */
  modules: string[]
  /** Milliseconds until the tick, or 0 once it has passed. */
  msToTick: number
  locked: boolean
  /**
   * The day whose board this is — the latest that actually RESOLVED, which is
   * not always `day - 1`: a missed tick leaves a gap.
   *
   * Public, and the anchor for two things the client owns. It is the replay the
   * viewer may not have watched, and it is what a poll compares against to know
   * the tick has landed and the page is now stale.
   */
  resolvedDay: number
}

/**
 * The board's STATIC half: geometry, names and the backdrop. Identical for
 * every viewer and derived from nothing but the map.
 *
 * Shared by the player board and the replay so the two cannot drift — a replay
 * drawn from a different set of shapes than the board is a picture of a game
 * nobody played, and the drift would be silent.
 */
export interface StaticBoard {
  territories: { id: string; name: string; region: string; neighbors: string[] }[]
  regions: { id: string; name: string; bonus: number }[]
  shapes: Record<string, [number, number][][]>
  shapesFine: Record<string, [number, number][][]>
  centres: Record<string, { lat: number; lon: number }>
  labels: Record<string, { lat: number; lon: number }>
  labelBoxes: Record<string, [number, number, number, number]>
  regionOutlines: Record<string, [number, number][][]>
  offBoard: Record<string, [number, number][][]>
  seaLinks: [string, string][]
}

export function staticBoard(map: GameState["map"]): StaticBoard {
  const onBoard = new Set(map.territories.map((t) => t.id))
  return {
    territories: map.territories.map((t) => ({
      id: t.id,
      name: t.name,
      region: t.region,
      neighbors: t.neighbors,
    })),
    regions: map.regions.map((r) => ({ id: r.id, name: r.name, bonus: r.bonus })),
    shapes: Object.fromEntries(map.territories.map((t) => [t.id, SHAPES[t.id] ?? []])),
    shapesFine: Object.fromEntries(
      map.territories.map((t) => [t.id, SHAPES_FINE[t.id] ?? SHAPES[t.id] ?? []]),
    ),
    centres: Object.fromEntries(map.territories.map((t) => [t.id, COORDS[t.id]!])),
    labels: Object.fromEntries(
      map.territories.map((t) => {
        const p = LABELS[t.id]
        const c = COORDS[t.id]!
        return [t.id, p === undefined ? c : { lat: p[1], lon: p[0] }]
      }),
    ),
    labelBoxes: Object.fromEntries(
      map.territories
        .filter((t) => LABEL_BOXES[t.id] !== undefined)
        .map((t) => [t.id, LABEL_BOXES[t.id]!]),
    ),
    regionOutlines: Object.fromEntries(
      map.regions
        .filter((r) => (REGION_OUTLINES[r.id] ?? []).length > 0)
        .map((r) => [r.id, REGION_OUTLINES[r.id]!]),
    ),
    offBoard: Object.fromEntries(
      Object.entries(SHAPES).filter(([id, rings]) => rings.length > 0 && !onBoard.has(id)),
    ),
    seaLinks: SEA_LINKS.filter(([a, b]) => onBoard.has(a) && onBoard.has(b)).map(
      ([a, b]) => [a, b] as [string, string],
    ),
  }
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
  modules: string[]
  tickAt: Date
  now: Date
  /**
   * Display names by faction id, read from the roster at request time.
   *
   * Not from the state: `createSeason` froze `playerName` at the deal, so a
   * player who renamed themselves would go on showing the old name for the rest
   * of the season. Optional and falling back to the frozen copy, which is what
   * lets the simulator and the fixtures render without a roster.
   *
   * Public, like every other faction name here — it is on the standings.
   */
  names?: Record<FactionId, string>
}): Projection {
  const { state, factionId } = args
  const msToTick = Math.max(0, args.tickAt.getTime() - args.now.getTime())
  return {
    ...staticBoard(state.map),
    seasonId: state.seasonId,
    // The order day, NOT state.day. The state is last night's board; the player
    // is writing orders for tonight, and showing them "Day 0" while they plan
    // day 1 is a small lie that makes the countdown nonsense.
    day: args.day,
    factionId,
    factions: state.factions.map((f) => ({
      id: f.id,
      name: args.names?.[f.id] ?? f.playerName,
      color: f.color,
    })),
    ownership: state.ownership,
    garrisons: state.garrisons,
    reserve: state.reserves[factionId] ?? 0,
    plan: args.plan,
    // Conditional spread, not `undefined` values — exactOptionalPropertyTypes,
    // and board.test.ts asserts the keys are ABSENT for a markets-off season.
    ...(args.modules.includes("markets") ? { wagers: args.wagers, slate: args.slate } : {}),
    modules: args.modules,
    msToTick,
    locked: msToTick === 0,
    // The board being shown IS the resolved state, so this is its own day —
    // never args.day, which is the night being ordered for and has not happened.
    resolvedDay: state.day,
  }
}
