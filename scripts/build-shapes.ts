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
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { COORDS } from "../src/map/coords.js"
import { WORLD } from "../src/map/world.js"
import { ALIASES, MERGES, PARENTS } from "./shape-map.js"

const require_ = createRequire(import.meta.url)
const topology = require_("world-atlas/countries-110m.json")
const { feature, merge } = require_("topojson-client") as {
  feature: (t: unknown, o: unknown) => { features: NeFeature[] }
  merge: (t: unknown, objects: unknown[]) => {
    type: string
    coordinates: number[][][] | number[][][][]
  }
}
const { topology: buildTopology } = require_("topojson-server") as {
  topology: (objects: Record<string, unknown>) => {
    objects: Record<string, { geometries: unknown[] }>
  }
}

/**
 * Natural Earth admin-1: states, provinces, oblasts.
 *
 *   curl -L -o .cache/admin1-10m.geojson \
 *     https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
 *
 * 39 MB, cached and gitignored rather than committed. Absent, the build falls
 * back to Voronoi cells everywhere and says so.
 */
const ADMIN1_PATH = new URL("../.cache/admin1-10m.geojson", import.meta.url).pathname

interface Admin1Feature {
  properties: { admin?: string; name?: string }
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] } | null
}

const admin1 = new Map<string, Admin1Feature[]>()
if (existsSync(ADMIN1_PATH)) {
  const raw = JSON.parse(readFileSync(ADMIN1_PATH, "utf8")) as { features: Admin1Feature[] }
  for (const f of raw.features) {
    const country = f.properties.admin
    if (country === undefined || f.geometry === null) continue
    admin1.set(country, [...(admin1.get(country) ?? []), f])
  }
}

interface NeFeature {
  properties: { name: string }
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] } | null
}

type Ring = [number, number][]

/**
 * Simplification tolerance in degrees. ~0.05° is about 5 km at the equator.
 *
 * Raised once admin-1 arrived: province boundaries come from the 10m dataset,
 * which is roughly twenty times denser than the 110m coastlines it replaced.
 * Override with RR_SHAPE_TOLERANCE to re-measure the size/detail curve.
 */
const TOLERANCE = Number(process.env.RR_SHAPE_TOLERANCE ?? 0.15)
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

/**
 * Carve a country along its REAL provincial boundaries.
 *
 * Each province goes to whichever claimant territory its centre is nearest,
 * then the provinces of one claimant are dissolved into a single shape. The
 * borders that survive are the ones on the ground — the Columbia between
 * Washington and Oregon, the Pyrenees, the Urals — instead of the perpendicular
 * bisector between two centroids, which is a straight line by construction and
 * looked exactly as computed as it was.
 *
 * The dissolve is `topojson.merge`, which drops arcs shared by two geometries.
 * Building the topology per country rather than globally keeps it to tens of
 * features, and means an internal border only disappears when both sides of it
 * went to the same territory.
 *
 * Returns undefined when the country has no admin-1 data, and the caller falls
 * back to a Voronoi cell.
 */
function carveByProvince(
  country: string,
  claimants: { id: string; lon: number; lat: number }[],
): Map<string, Ring[]> | undefined {
  const units = admin1.get(country)
  if (units === undefined || units.length === 0 || claimants.length === 0) return undefined

  const centreOf = (f: Admin1Feature): [number, number] => {
    const polys = (
      f.geometry!.type === "Polygon" ? [f.geometry!.coordinates] : f.geometry!.coordinates
    ) as number[][][][]
    // Area-weighted over outer rings, so a province with offshore islets is
    // placed by its mainland rather than by the midpoint of the two.
    let ax = 0
    let ay = 0
    let aw = 0
    for (const poly of polys) {
      const ring = poly[0] as Ring | undefined
      if (ring === undefined || ring.length < 3) continue
      const w = Math.max(area(ring), 1e-9)
      const c = ringCentre(ring)
      ax += c.lon * w
      ay += c.lat * w
      aw += w
    }
    return aw === 0 ? [0, 0] : [ax / aw, ay / aw]
  }

  const assigned = new Map<string, unknown[]>()
  const geometries = buildTopology({ u: { type: "GeometryCollection", geometries: units.map((f) => f.geometry) } })
    .objects.u.geometries

  units.forEach((f, i) => {
    const [lon, lat] = centreOf(f)
    let best = claimants[0]!
    let bestD = Infinity
    for (const c of claimants) {
      // Longitude compressed by latitude, so "nearest" means nearest on the
      // ground. Without it every assignment near the poles is wrong.
      const dx = (c.lon - lon) * Math.cos((lat * Math.PI) / 180)
      const dy = c.lat - lat
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    assigned.set(best.id, [...(assigned.get(best.id) ?? []), geometries[i]])
  })

  const topo = buildTopology({ u: { type: "GeometryCollection", geometries: units.map((f) => f.geometry) } })
  const out = new Map<string, Ring[]>()
  for (const [id, geoms] of assigned) {
    const merged = merge(topo, geoms)
    const polys = (
      merged.type === "Polygon" ? [merged.coordinates] : merged.coordinates
    ) as number[][][][]
    // Outer rings only, matching ringsOf — holes are dropped everywhere.
    out.set(
      id,
      polys.map((p) => p[0] as Ring).filter((r) => r !== undefined && r.length >= 3),
    )
  }
  return out
}

/** Every territory drawing from a country: its carved children, plus itself. */
const claimantsOf = new Map<string, { id: string; lon: number; lat: number }[]>()
for (const [id, parent] of Object.entries(PARENTS)) {
  const c = COORDS[id]
  if (c === undefined) continue
  claimantsOf.set(parent, [...(claimantsOf.get(parent) ?? []), { id, lon: c.lon, lat: c.lat }])
}
// A country carved into ONE child still has a territory named after itself --
// Austria/tyrol, Egypt/sinai. Both were drawing the whole country and sitting
// exactly on top of each other. Naming the parent as a claimant splits them.
for (const t of WORLD.territories) {
  if (PARENTS[t.id] !== undefined) continue
  const name = ALIASES[t.id] ?? byNorm.get(norm(t.name))
  const c = COORDS[t.id]
  if (name === undefined || c === undefined || !claimantsOf.has(name)) continue
  claimantsOf.set(name, [...claimantsOf.get(name)!, { id: t.id, lon: c.lon, lat: c.lat }])
}

const province = new Map<string, Ring[]>()
const carvedByProvince = new Set<string>()
for (const [country, claimants] of claimantsOf) {
  const got = carveByProvince(country, claimants)
  if (got === undefined) continue
  carvedByProvince.add(country)
  for (const [id, rings] of got) province.set(id, rings)
}

/**
 * The point inside a territory furthest from its own coastline.
 *
 * Garrison counts were drawn at the hand-entered COORDS centroid, which is an
 * approximate centre of the COUNTRY rather than of the drawn shape. Zoomed out
 * that passes; zoomed in the number visibly drifts off its territory, and for
 * Tyrol and Cyprus it sat outside the polygon altogether. A mean of the
 * vertices is no better — on a crescent like Norway the mean is in the sea.
 *
 * So: pole of inaccessibility, by grid refinement. Sample the bounding box,
 * keep the sample furthest INSIDE, then resample a shrinking window around it.
 * Six passes is well past the point where the answer stops moving at the
 * resolution anyone renders at, and this runs once at build time.
 */
function labelPoint(rings: Ring[]): [number, number] {
  const all = rings.filter((r) => r.length >= 3)
  if (all.length === 0) return [0, 0]
  // The largest ring only. A territory's label belongs on its mainland, not
  // averaged between the mainland and an island chain.
  const ring = all.reduce((a, b) => (area(a) >= area(b) ? a : b))

  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  let x0 = Math.min(...xs)
  let x1 = Math.max(...xs)
  let y0 = Math.min(...ys)
  let y1 = Math.max(...ys)

  const inside = (px: number, py: number): boolean => {
    let hit = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }

  // Distance to the nearest edge, negative outside — so one comparison ranks
  // "inside and far from the coast" above everything else.
  const clearance = (px: number, py: number): number => {
    let best = Infinity
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      const dx = xj - xi
      const dy = yj - yi
      const len = dx * dx + dy * dy
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / len))
      best = Math.min(best, Math.hypot(px - (xi + t * dx), py - (yi + t * dy)))
    }
    return inside(px, py) ? best : -best
  }

  let best: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2]
  let bestScore = -Infinity
  for (let pass = 0; pass < 6; pass++) {
    const steps = 12
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const px = x0 + ((x1 - x0) * i) / steps
        const py = y0 + ((y1 - y0) * j) / steps
        const score = clearance(px, py)
        if (score > bestScore) {
          bestScore = score
          best = [px, py]
        }
      }
    }
    // Shrink the window around the winner and look again.
    const wx = (x1 - x0) / 4
    const wy = (y1 - y0) / 4
    x0 = best[0] - wx
    x1 = best[0] + wx
    y0 = best[1] - wy
    y1 = best[1] + wy
  }
  return [Math.round(best[0] * 1000) / 1000, Math.round(best[1] * 1000) / 1000]
}

const shapes: Record<string, Ring[]> = {}
const labels: Record<string, [number, number]> = {}
const report: string[] = []

for (const t of WORLD.territories) {
  const parent = PARENTS[t.id]
  let rings: Ring[]

  const fromProvince = province.get(t.id)
  if (fromProvince !== undefined) {
    // Real provincial boundaries. Preferred wherever admin-1 covers the
    // country, for carved children and self-claiming parents alike.
    rings = fromProvince
  } else if (parent !== undefined) {
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
  // Microstate merges still apply on top of a province-derived shape.
  for (const extra of fromProvince !== undefined ? (MERGES[t.id] ?? []) : []) {
    rings = rings.concat(ringsOf(extra))
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
  if (rings.length > 0) labels[t.id] = labelPoint(rings)
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

/**
 * Where to write a territory's garrison count: the point inside its largest
 * ring furthest from that ring's own coastline.
 *
 * NOT the COORDS centroid, which is an approximate centre of the country and
 * drifts visibly off the drawn shape once you zoom in — Tyrol's and Cyprus's
 * sat outside their polygons entirely. NOT the mean of the vertices either: on
 * a crescent like Norway the mean is in the sea.
 *
 * Pole of inaccessibility by grid refinement, computed here so the browser
 * pays nothing for it.
 */
export const LABELS: Record<TerritoryId, [number, number]> = ${JSON.stringify(labels)}
`

writeFileSync(new URL("../src/map/shapes.ts", import.meta.url), body)

console.log(`src/map/shapes.ts — ${Object.keys(shapes).length} territories, ${points.toLocaleString()} points, ${(body.length / 1024).toFixed(0)} KB`)
if (report.length > 0) console.log(`EMPTY (${report.length}): ${report.join(", ")}`)
