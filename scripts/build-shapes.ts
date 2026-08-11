/**
 * Turns Natural Earth into `src/map/shapes.ts`.
 *
 *   npm run build:shapes
 *
 * Run once and commit the output. `world-atlas` and `topojson-client` are
 * devDependencies used only here, so the runtime keeps its two dependencies and
 * the app never parses TopoJSON.
 *
 * Three transformations:
 *
 * 1. **Merges.** A territory that swallowed its neighbours under the microstate
 *    rule gets their polygons too — Senegal carries The Gambia and
 *    Guinea-Bissau.
 * 2. **Carves.** A territory that is part of a country we split is cut out of
 *    the parent by its Voronoi cell over the sibling centroids. The coastline
 *    is real; only the internal borders are approximate, which is the right
 *    trade for a game board — classic Risk's "Western United States" is not a
 *    real boundary either.
 * 3. **Simplify.** Ramer–Douglas–Peucker, because the page renders at roughly
 *    1200px and full-resolution rings are bytes nobody can see.
 */
import { createRequire } from "node:module"
import { writeFileSync } from "node:fs"
import { COORDS } from "../src/map/coords.js"
import { WORLD } from "../src/map/world.js"
import { ALIASES, MERGES, PARENTS } from "./shape-map.js"

const require_ = createRequire(import.meta.url)
const topology = require_("world-atlas/countries-110m.json")
const { feature } = require_("topojson-client") as {
  feature: (t: unknown, o: unknown) => { features: NeFeature[] }
}

interface NeFeature {
  properties: { name: string }
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] } | null
}

type Ring = [number, number][]

/** Simplification tolerance in degrees. ~0.05° is about 5 km at the equator. */
const TOLERANCE = 0.05
/** Rings smaller than this are dropped: unrenderable specks, mostly islets. */
const MIN_AREA = 0.02
/**
 * How far a ring's centre may sit from its territory's own coordinate.
 *
 * Natural Earth files overseas territories under the metropole — "France"
 * includes French Guiana in South America, "United States of America" includes
 * Hawaii — and a Voronoi cell extends to infinity away from its neighbours, so
 * Aquitaine collected French Guiana and California collected Hawaii. 35° is
 * generous enough for Alaska, whose real rings span some 40° of longitude, and
 * for the Siberian territories.
 */
const MAX_RING_OFFSET_DEG = 35

/**
 * Slivers left behind by Voronoi clipping, which MIN_AREA cannot catch.
 *
 * Clipping a coastline by a half-plane occasionally leaves a ribbon a few
 * hundredths of a degree tall and tens of degrees wide. Karelia had one 29°
 * wide and 0.5° tall, which drew as a maroon bar straight across the map, and
 * its *area* is ~14 square degrees — hundreds of times MIN_AREA. Area is the
 * wrong test; shape is the test.
 *
 * The signature is elongation together with an absence of detail. Every real
 * coastline ring simplified at TOLERANCE keeps many points, so a ring this
 * stretched with a handful of vertices is an artifact of the cut rather than a
 * piece of land. Measured across all 264 territories, exactly nine rings
 * exceed this aspect ratio and all nine have six points or fewer.
 */
const MAX_SLIVER_ASPECT = 8
const SLIVER_MAX_POINTS = 6

function isSliver(ring: Ring): boolean {
  if (ring.length > SLIVER_MAX_POINTS) return false
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  const short = Math.min(w, h)
  if (short === 0) return true
  return Math.max(w, h) / short > MAX_SLIVER_ASPECT
}

// ---------------------------------------------------------------- geometry --

/** Ramer–Douglas–Peucker on an OPEN polyline. */
function rdp(pts: Ring, tol: number): Ring {
  if (pts.length <= 2) return pts
  const keep = new Array<boolean>(pts.length).fill(false)
  keep[0] = true
  keep[pts.length - 1] = true

  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    let best = 0
    let bestI = -1
    const [ax, ay] = pts[a]!
    const [bx, by] = pts[b]!
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len
      if (d > best) {
        best = d
        bestI = i
      }
    }
    if (best > tol && bestI !== -1) {
      keep[bestI] = true
      stack.push([a, bestI], [bestI, b])
    }
  }
  return pts.filter((_, i) => keep[i]!)
}

/**
 * Simplify a closed ring.
 *
 * RDP cannot be applied to a closed ring directly, and doing so is a silent
 * disaster rather than a visible one: the seed segment runs from the first
 * point to the last, which on a closed ring are the SAME point, so the
 * perpendicular-distance formula is constant for every vertex and the whole
 * ring collapses to two points. Morocco went from 63 points to 2, and 157 of
 * 264 territories rendered as nothing.
 *
 * The fix is to cut the ring at two genuinely distant anchors — the first
 * vertex and the vertex farthest from it — and simplify each half as an open
 * polyline.
 */
function simplify(ring: Ring, tol: number): Ring {
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first === undefined || last === undefined) return ring
  const closed = ring.length > 1 && first[0] === last[0] && first[1] === last[1]
  const pts = closed ? ring.slice(0, -1) : ring
  if (pts.length <= 4) return ring

  let far = 0
  let farthest = -1
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]![0] - pts[0]![0], pts[i]![1] - pts[0]![1])
    if (d > farthest) {
      farthest = d
      far = i
    }
  }

  const head = rdp(pts.slice(0, far + 1), tol)
  const tail = rdp(pts.slice(far), tol)
  const out = head.slice(0, -1).concat(tail)
  return closed && out.length > 0 ? out.concat([out[0]!]) : out
}

/** Mean position of a ring, with longitude wrap handled via unit vectors. */
function ringCentre(ring: Ring): { lon: number; lat: number } {
  let lat = 0
  let x = 0
  let y = 0
  for (const [lon, la] of ring) {
    lat += la
    x += Math.cos((lon * Math.PI) / 180)
    y += Math.sin((lon * Math.PI) / 180)
  }
  return { lat: lat / ring.length, lon: (Math.atan2(y, x) * 180) / Math.PI }
}

/** Degrees between two points, taking the short way round the date line. */
function offsetDeg(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const dLon = Math.min(Math.abs(a.lon - b.lon), 360 - Math.abs(a.lon - b.lon))
  return Math.hypot(dLon, a.lat - b.lat)
}

/** Shoelace area, unsigned. */
function area(ring: Ring): number {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
  }
  return Math.abs(sum) / 2
}

/**
 * Sutherland–Hodgman: clip a subject ring by a half-plane.
 *
 * `inside(p)` is true on the kept side. Works because every clip region here is
 * convex — a Voronoi cell is an intersection of half-planes by construction, so
 * clipping by each in turn is exact rather than an approximation.
 */
function clipHalfPlane(
  ring: Ring,
  inside: (p: [number, number]) => boolean,
  intersect: (a: [number, number], b: [number, number]) => [number, number],
): Ring {
  const out: Ring = []
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i]!
    const prev = ring[(i + ring.length - 1) % ring.length]!
    const curIn = inside(cur)
    const prevIn = inside(prev)
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur))
      out.push(cur)
    } else if (prevIn) {
      out.push(intersect(prev, cur))
    }
  }
  return out
}

/**
 * Clip a ring to the Voronoi cell of `site` among `sites`.
 *
 * The cell is the intersection of the half-planes nearer to `site` than to each
 * other site, so it is applied one bisector at a time.
 */
function clipToCell(ring: Ring, site: [number, number], sites: [number, number][]): Ring {
  let out = ring
  for (const other of sites) {
    if (other[0] === site[0] && other[1] === site[1]) continue
    // Perpendicular bisector: keep points where dot(p - mid, other - site) < 0.
    const nx = other[0] - site[0]
    const ny = other[1] - site[1]
    const mx = (other[0] + site[0]) / 2
    const my = (other[1] + site[1]) / 2
    const f = (p: [number, number]): number => (p[0] - mx) * nx + (p[1] - my) * ny
    out = clipHalfPlane(
      out,
      (p) => f(p) <= 0,
      (a, b) => {
        const fa = f(a)
        const t = fa / (fa - f(b))
        return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
      },
    )
    if (out.length === 0) return out
  }
  return out
}

// -------------------------------------------------------------- extraction --

const features = feature(topology, topology.objects.countries).features
const byName = new Map<string, NeFeature>()
for (const f of features) byName.set(f.properties.name, f)

/** Every outer ring of a country. Holes are dropped — see the note in shapes.ts. */
function ringsOf(name: string): Ring[] {
  const f = byName.get(name)
  if (f?.geometry == null) return []
  const g = f.geometry
  const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as number[][][][]
  return polys.map((poly) => poly[0] as Ring).filter((r) => r !== undefined)
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "")
const byNorm = new Map<string, string>()
for (const f of features) byNorm.set(norm(f.properties.name), f.properties.name)

/** Siblings carved from the same parent, with their centroids as Voronoi sites. */
const siblings = new Map<string, [number, number][]>()
for (const [id, parent] of Object.entries(PARENTS)) {
  const c = COORDS[id]
  if (c === undefined) continue
  siblings.set(parent, [...(siblings.get(parent) ?? []), [c.lon, c.lat]])
}

/**
 * Split a ring that crosses the antimeridian into one ring per side.
 *
 * Natural Earth stores Fiji as a single ring running from -180 to +180, which
 * is correct as data and catastrophic as geometry: drawn literally it is a
 * polygon wrapping the entire globe, and Leaflet paints it as a bar straight
 * across the map at Fiji's latitude.
 *
 * Unwrap first so consecutive points never jump more than 180 degrees -- that
 * turns -179 into +181 and makes the ring continuous -- then cut at the
 * meridian with the same half-plane clipper the Voronoi cells use, and shift
 * the eastern piece back into range.
 */
function splitAtAntimeridian(ring: Ring): Ring[] {
  const xs = ring.map((p) => p[0])
  if (Math.max(...xs) - Math.min(...xs) <= 180) return [ring]

  const unwrapped: Ring = [ring[0]!]
  for (let i = 1; i < ring.length; i++) {
    const prev = unwrapped[i - 1]!
    let x = ring[i]![0]
    while (x - prev[0] > 180) x -= 360
    while (x - prev[0] < -180) x += 360
    unwrapped.push([x, ring[i]![1]])
  }

  const cut = (keepBelow: boolean, at: number): Ring =>
    clipHalfPlane(
      unwrapped,
      (p) => (keepBelow ? p[0] <= at : p[0] >= at),
      (a, b) => [at, a[1] + ((at - a[0]) / (b[0] - a[0])) * (b[1] - a[1])],
    )

  const out: Ring[] = []
  for (const [keepBelow, shift] of [
    [true, 0],
    [false, -360],
  ] as const) {
    const piece = cut(keepBelow, 180).map(([x, y]) => [x + shift, y] as [number, number])
    if (piece.length >= 3) out.push(piece)
  }
  // West of -180 as well, for a ring unwrapped the other way.
  if (Math.min(...unwrapped.map((p) => p[0])) < -180) {
    const piece = cut(false, -180)
    const west = cut(true, -180).map(([x, y]) => [x + 360, y] as [number, number])
    return [piece, west].filter((r) => r.length >= 3)
  }
  return out.length > 0 ? out : [ring]
}

const shapes: Record<string, Ring[]> = {}
const report: string[] = []

for (const t of WORLD.territories) {
  const parent = PARENTS[t.id]
  let rings: Ring[]

  if (parent !== undefined) {
    const site = COORDS[t.id]!
    const sites = siblings.get(parent)!
    rings = ringsOf(parent)
      .map((r) => clipToCell(r, [site.lon, site.lat], sites))
      .filter((r) => r.length >= 3)
  } else {
    const name = ALIASES[t.id] ?? byNorm.get(norm(t.name))
    rings = name === undefined ? [] : ringsOf(name)
    for (const extra of MERGES[t.id] ?? []) rings = rings.concat(ringsOf(extra))
  }

  const home = COORDS[t.id]
  rings = rings
    .flatMap((r) => splitAtAntimeridian(r))
    .map((r) => simplify(r, TOLERANCE))
    .filter((r) => r.length >= 3 && area(r) >= MIN_AREA)
    .filter((r) => !isSliver(r))
    // Drop rings that belong to somebody else's hemisphere. See
    // MAX_RING_OFFSET_DEG.
    .filter((r) => home === undefined || offsetDeg(ringCentre(r), home) <= MAX_RING_OFFSET_DEG)
    .map((r) => r.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000] as [number, number]))

  if (rings.length === 0) report.push(t.id)
  shapes[t.id] = rings
}

// ------------------------------------------------------------------ output --

const points = Object.values(shapes).reduce((n, rs) => n + rs.reduce((m, r) => m + r.length, 0), 0)

const body = `import type { TerritoryId } from "../engine/index.js"

/**
 * Real coastlines, keyed by game territory id. GENERATED — do not edit.
 *
 *   npm run build:shapes
 *
 * Source: Natural Earth 1:110m via the \`world-atlas\` package (public domain),
 * transformed by \`scripts/build-shapes.ts\`. The pipeline is committed and the
 * data is committed; the runtime never parses TopoJSON and keeps its two
 * dependencies.
 *
 * Coordinates are [longitude, latitude] in degrees, rounded to three decimals
 * (~100 m), simplified with Ramer–Douglas–Peucker at ${TOLERANCE}°. Rings under
 * ${MIN_AREA} square degrees are dropped as unrenderable specks.
 *
 * **Outer rings only — holes are not represented.** The one case it costs is
 * Lesotho, which sits inside South Africa: its own polygon is correct, but the
 * surrounding Cape territories do not cut a hole for it, so draw order decides
 * what covers what. Everything else on this board is hole-free.
 *
 * Territories carved out of a larger country (US regions, Chinese provinces,
 * Russian districts) have a REAL coastline and APPROXIMATE internal borders —
 * they are the parent's polygon clipped to a Voronoi cell over the sibling
 * centroids. Classic Risk's "Western United States" is not a real boundary
 * either.
 *
 * ${Object.keys(shapes).length} territories, ${points.toLocaleString()} points.
 */
export const SHAPES: Record<TerritoryId, [number, number][][]> = ${JSON.stringify(shapes)}
`

writeFileSync(new URL("../src/map/shapes.ts", import.meta.url), body)

console.log(`src/map/shapes.ts — ${Object.keys(shapes).length} territories, ${points.toLocaleString()} points, ${(body.length / 1024).toFixed(0)} KB`)
if (report.length > 0) console.log(`EMPTY (${report.length}): ${report.join(", ")}`)
