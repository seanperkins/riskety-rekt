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
import { SEA_LINKS, WORLD } from "../src/map/world.js"
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
const { presimplify, simplify: simplifyTopology } = require_("topojson-simplify") as {
  presimplify: (t: unknown) => unknown
  simplify: (t: unknown, minWeight: number) => unknown
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

/**
 * Territory id -> the country name admin-1 uses, where it differs from the
 * 110m country name in ALIASES.
 *
 * Only seven, and they exist so EVERY territory can be sourced from admin-1.
 * Mixing datasets is what left gaps between neighbours: a province boundary at
 * 10m and a country boundary at 110m are different lines, and no amount of
 * topology-preserving simplification can reconcile geometry that never matched.
 */
const ADMIN1_NAMES: Record<string, string> = {
  dr_congo: "Democratic Republic of the Congo",
  congo: "Republic of the Congo",
  tanzania: "United Republic of Tanzania",
  eswatini: "Swaziland",
  bosnia: "Bosnia and Herzegovina",
  serbia: "Republic of Serbia",
  hispaniola: "Dominican Republic",
}

/**
 * Admin-1 admins folded into another country's unit pool.
 *
 * Natural Earth lists de-facto states as their own `admin`, so their land is
 * absent from the country the board models — and the hole is not cosmetic. With
 * Somaliland missing, drawn Somalia started 5.5 degrees south of Djibouti, the
 * Horn had a bite out of it, and the derived border between the two did not
 * exist. Folding at INGEST rather than through `MERGES` matters: MERGES pulls
 * 110m country outlines, which share no arcs with 10m provinces, so the seam
 * would stay.
 */
const ADMIN1_FOLD: Record<string, string> = {
  Somaliland: "Somalia",
}

const admin1 = new Map<string, Admin1Feature[]>()
if (existsSync(ADMIN1_PATH)) {
  const raw = JSON.parse(readFileSync(ADMIN1_PATH, "utf8")) as { features: Admin1Feature[] }
  for (const f of raw.features) {
    const listed = f.properties.admin
    if (listed === undefined || f.geometry === null) continue
    const country = ADMIN1_FOLD[listed] ?? listed
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
/**
 * The close-up resolution, shipped only for territories on the board.
 *
 * 0.15° is about 15 km, which disappears when the whole board fills the frame
 * and turns every coastline into visible straight chords once you zoom in.
 */
const FINE_TOLERANCE = Number(process.env.RR_SHAPE_FINE_TOLERANCE ?? 0.04)
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

  // An admin-1 unit further than this from every claimant is OVERSEAS and
  // belongs to no territory on the board. Nearest-centre alone handed French
  // Guiana to Aquitaine, which drew a France-coloured wedge of South America
  // and then derived a LAND border from Aquitaine to Para and Suriname across
  // the Atlantic. Reunion, Mayotte and Hawaii are the same case. 20 degrees is
  // wide enough for the Canaries, which are genuinely drawn with Andalusia.
  const OVERSEAS_DEG = 20

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
    if (Math.sqrt(bestD) > OVERSEAS_DEG) return
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
const admin1Norm = new Map<string, string>()
for (const country of admin1.keys()) admin1Norm.set(norm(country), country)

for (const t of WORLD.territories) {
  if (PARENTS[t.id] !== undefined) continue
  const c = COORDS[t.id]
  if (c === undefined) continue
  // Every territory that admin-1 knows is sourced from admin-1, carved or not.
  // A plain country is simply a country with ONE claimant, so carveByProvince
  // merges all its provinces back into the country -- at the same resolution,
  // from the same arcs, as every neighbour.
  const want = ADMIN1_NAMES[t.id] ?? ALIASES[t.id] ?? t.name
  const country =
    admin1Norm.get(norm(want)) ?? admin1Norm.get(norm(t.name)) ?? byNorm.get(norm(t.name))
  if (country === undefined) continue
  claimantsOf.set(country, [...(claimantsOf.get(country) ?? []), { id: t.id, lon: c.lon, lat: c.lat }])
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
 * The largest label-shaped rectangle that fits INSIDE a territory.
 *
 * Returns the rectangle, not just a point, because both questions have the same
 * answer: where the number goes is its centre, and whether the number fits is
 * its size.
 *
 * The previous version placed labels at the pole of inaccessibility -- the
 * point furthest from the coast -- and then decided whether to show the number
 * by measuring the territory's BOUNDING BOX. That second part is wrong for any
 * shape that is not roughly rectangular: Norway's bounding box is enormous and
 * its interior is a few kilometres wide, so the number passed the fit test and
 * then sat in the sea. An inscribed rectangle cannot lie about either.
 *
 * Method: scanline-rasterise the ring into a grid, then the classic largest
 * rectangle in a binary matrix, by row histograms and a monotonic stack. Scored
 * by how large a LABEL-SHAPED box fits rather than by area, since a tall narrow
 * rectangle is worthless for a number that is wider than it is tall.
 */
const LABEL_ASPECT = 1.6
const GRID = 96

function labelBox(rings: Ring[]): { c: [number, number]; box: [number, number, number, number] } | undefined {
  const all = rings.filter((r) => r.length >= 3)
  if (all.length === 0) return undefined
  // Largest ring only: a label belongs on the mainland, not averaged across an
  // island chain.
  const ring = all.reduce((a, b) => (area(a) >= area(b) ? a : b))

  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  if (!(x1 > x0 && y1 > y0)) return undefined

  const cw = (x1 - x0) / GRID
  const ch = (y1 - y0) / GRID

  // Scanline fill: one pass per row over the edges, rather than a
  // point-in-polygon test per cell.
  const inside: Uint8Array[] = []
  for (let r = 0; r < GRID; r++) {
    const y = y0 + (r + 0.5) * ch
    const cuts: number[] = []
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if (yi > y !== yj > y) cuts.push(((xj - xi) * (y - yi)) / (yj - yi) + xi)
    }
    cuts.sort((a, b) => a - b)
    const row = new Uint8Array(GRID)
    for (let k = 0; k + 1 < cuts.length; k += 2) {
      const from = Math.max(0, Math.ceil((cuts[k]! - x0) / cw - 0.5))
      const to = Math.min(GRID - 1, Math.floor((cuts[k + 1]! - x0) / cw - 0.5))
      for (let c = from; c <= to; c++) row[c] = 1
    }
    inside.push(row)
  }

  // Largest rectangle in a binary matrix, scored for label shape.
  const heights = new Int32Array(GRID)
  let best = -1
  let bestRect: [number, number, number, number] | undefined
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) heights[c] = inside[r]![c] ? heights[c]! + 1 : 0
    const stack: number[] = []
    for (let c = 0; c <= GRID; c++) {
      const h = c === GRID ? 0 : heights[c]!
      let start = c
      while (stack.length > 0 && heights[stack[stack.length - 1]!]! >= h) {
        const idx = stack.pop()!
        const hh = heights[idx]!
        const wCells = c - idx
        const wDeg = Math.max(0, wCells - 1) * cw
        const hDeg = Math.max(0, hh - 1) * ch
        // How big a label-shaped box fits in this rectangle.
        const score = Math.min(wDeg / LABEL_ASPECT, hDeg)
        if (score > best && wCells > 0 && hh > 0) {
          best = score
          // Corners at the CENTRES of the corner cells, not at cell edges.
          // Edges overshoot by half a cell on every side, which put a corner of
          // 221 of 264 boxes outside the coastline -- the exact overstatement
          // this function exists to avoid.
          bestRect = [
            x0 + (idx + 0.5) * cw,
            y0 + (r - hh + 1.5) * ch,
            x0 + (c - 0.5) * cw,
            y0 + (r + 0.5) * ch,
          ]
        }
        start = idx
      }
      stack.push(start)
      heights[start] = h
    }
  }
  if (bestRect === undefined) return undefined
  const round = (n: number): number => Math.round(n * 1000) / 1000
  const [bx0, by0, bx1, by1] = bestRect
  return {
    c: [round((bx0 + bx1) / 2), round((by0 + by1) / 2)],
    box: [round(bx0), round(by0), round(bx1), round(by1)],
  }
}

const raw: Record<string, Ring[]> = {}
const shapes: Record<string, Ring[]> = {}
const fine: Record<string, Ring[]> = {}
const labels: Record<string, [number, number]> = {}
const boxes: Record<string, [number, number, number, number]> = {}
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

  // Collected raw. Simplification happens ONCE for the whole world below, in
  // topology space, so a border shared by two territories is simplified as a
  // single arc and both sides get identical geometry.
  raw[t.id] = rings.flatMap((r) => splitAtAntimeridian(r))
}

// ---------------------------------------------------- topology simplification --

/**
 * Simplify every territory at once, in topology space.
 *
 * Simplifying each territory's rings on their own is what left gaps: two
 * neighbours simplify the SAME border independently and keep different
 * vertices, so the shared edge stops matching and daylight shows between them.
 * Measured on the previous build, 39% of adjacent pairs shared no vertex at
 * all.
 *
 * TopoJSON cuts the world into arcs, so a shared border exists once and is
 * simplified once. Both sides then read the identical arc back and the seam
 * closes by construction rather than by tolerance.
 *
 * The threshold is an AREA weight rather than a distance, which is what
 * presimplify computes, so the numbers are found by measurement below rather
 * than reasoned from degrees.
 */
const ids = Object.keys(raw).filter((id) => (raw[id] ?? []).length > 0)
const topo = presimplify(
  buildTopology({
    world: {
      type: "GeometryCollection",
      geometries: ids.map((id) => ({
        type: "MultiPolygon",
        id,
        coordinates: (raw[id] ?? []).map((r) => [r]),
      })),
    },
  }),
)

// ------------------------------------------------------- land adjacency --

/**
 * Who borders whom, read off the topology's SHARED ARCS.
 *
 * This is the same fact `topojson.merge` uses to dissolve an internal border:
 * an arc belongs to exactly one boundary, so two territories share an arc if
 * and only if they share a stretch of drawn edge. Sign is dropped -- one side
 * of a border traverses the arc backwards, as `~index`.
 *
 * It replaces a hand-authored `borders` list on every territory, and that list
 * was wrong: the province dissolve assigns each admin-1 unit to the nearest
 * claimant, so a board territory silently absorbs the provinces no territory
 * claims -- the drawn `gauteng` swallowed North West, Free State and
 * Mpumalanga and reached Botswana, while the hand list still described the real
 * province and did not. 77 pairs were drawn touching but unreachable and 39
 * were reachable with no shared edge. Deriving both from one source is the only
 * way the picture and the rules cannot disagree.
 *
 * A point-touch is NOT adjacency: a junction ends an arc rather than sharing
 * one, so two territories meeting at a corner have no arc in common.
 *
 * Sea crossings are not here and cannot be -- there is no shared edge to find.
 * They stay hand-authored in `SEA_LINKS`, which is where a reason per crossing
 * belongs anyway.
 */
// `presimplify` is declared as returning `unknown` by the local type stub above,
// so the arc structure TopoJSON guarantees has to be asserted once, here, by
// name -- rather than inline at each read.
const arcTopology = topo as {
  objects: { world: { geometries: { arcs: number[][][] }[] } }
}

const arcOwners = new Map<number, string[]>()
{
  const geometries = arcTopology.objects.world.geometries
  ids.forEach((id, i) => {
    for (const poly of geometries[i]?.arcs ?? []) {
      for (const ring of poly) {
        for (const a of ring) {
          const index = a < 0 ? ~a : a
          const owners = arcOwners.get(index)
          if (owners === undefined) arcOwners.set(index, [id])
          else if (!owners.includes(id)) owners.push(id)
        }
      }
    }
  })
}

const landBorders: Record<string, string[]> = {}
for (const id of ids) landBorders[id] = []

function link(a: string, b: string): void {
  if (a === b) return
  if (!landBorders[a]!.includes(b)) landBorders[a]!.push(b)
  if (!landBorders[b]!.includes(a)) landBorders[b]!.push(a)
}

for (const owners of arcOwners.values()) {
  // Three owners of one arc is geometrically impossible; if it ever happens,
  // pairing them all is still the honest reading of "shares this edge".
  for (const a of owners) for (const b of owners) link(a, b)
}

function ringsAt(weight: number): Record<string, Ring[]> {
  const simplified = simplifyTopology(topo, weight) as never
  const fc = feature(simplified, (simplified as { objects: { world: unknown } }).objects.world) as unknown as {
    features: { geometry: { type: string; coordinates: number[][][][] } | null }[]
  }
  const out: Record<string, Ring[]> = {}
  // Paired BY INDEX. topojson-server drops the `id` on an input geometry, so
  // every feature comes back id-less; the geometries array keeps input order
  // and `feature` maps it one to one.
  fc.features.forEach((f, i) => {
    const id = ids[i]!
    if (f.geometry === null) return
    const polys = (
      f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates
    ) as unknown as number[][][][]
    const home = COORDS[id]
    out[id] = polys
      .map((poly) => poly[0] as Ring)
      .filter((r) => r !== undefined && r.length >= 3 && area(r) >= MIN_AREA)
      .filter((r) => !isSliver(r))
      .filter((r) => home === undefined || offsetDeg(ringCentre(r), home) <= MAX_RING_OFFSET_DEG)
      .map((r) =>
        r.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000] as [number, number]),
      )
  })
  return out
}

/**
 * Simplification thresholds, as AREA weights rather than distances -- that is
 * what presimplify computes, so these were found by measuring the resulting
 * point counts rather than reasoned from degrees:
 *
 *   0.004 -> 45,907 points     0.05 -> 14,875     0.2 -> 7,669
 *
 * 0.05 lands on the same budget the old per-territory RDP produced at 0.15°,
 * and 0.004 gives the close-up set roughly three times the detail.
 */
const COARSE_WEIGHT = Number(process.env.RR_SHAPE_WEIGHT ?? 0.05)
const FINE_WEIGHT = Number(process.env.RR_SHAPE_FINE_WEIGHT ?? 0.004)

const coarseAll = ringsAt(COARSE_WEIGHT)
const fineAll = ringsAt(FINE_WEIGHT)
for (const id of ids) {
  shapes[id] = coarseAll[id] ?? []
  fine[id] = fineAll[id] ?? []
  if ((shapes[id] ?? []).length === 0) report.push(id)
  else {
    const lb = labelBox(shapes[id]!)
    if (lb !== undefined) {
      labels[id] = lb.c
      boxes[id] = lb.box
    }
  }
}

// --------------------------------------------------------- seam adjacency --

/**
 * The second half of adjacency: neighbours whose shapes come from DIFFERENT
 * arc pools and so share no arc to find.
 *
 * A shared arc only exists between two shapes cut from the same topology. Most
 * of the board is admin-1 and shares arcs exactly, but a Voronoi-carved child
 * is clipped out of the 1:110m country outline, and where such a shape meets an
 * admin-1 one the same border is drawn twice from two datasets: a hairline seam
 * instead of one edge. Bohemia, Baluchistan and Chukotka are cut off entirely by
 * arcs alone.
 *
 * Thresholds are MEASURED, not guessed. Against the drawn coarse rings:
 *
 * - Every real border missing from the arc pass has >= 2 vertices within 0.1
 *   degrees of the other side, spanning 1.4 to 11.4 degrees of boundary.
 * - Every FALSE pair at that distance -- mauritania/morocco, namibia/zimbabwe,
 *   jordan/sinai -- has exactly ONE such vertex and zero span. They are
 *   quadripoints and corner touches, which are not borders.
 *
 * So the rule is a RUN, not a proximity: two shapes must run alongside each
 * other, not merely meet. Anything still missing after this is a shape whose
 * geometry genuinely shows no border, and the rules now agree with the picture
 * rather than contradicting it.
 */
const SEAM_DEG = 0.1
const SEAM_MIN_VERTICES = 2

function seamContact(a: string, b: string): { hits: number; span: number } {
  const other = (shapes[b] ?? []).flat()
  let hits = 0
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const ring of shapes[a] ?? []) {
    for (const p of ring) {
      const near = other.some((q) => {
        // Longitude compressed by latitude, as everywhere else in this file:
        // 0.1 degrees of longitude at 70 north is 4 km, not 11.
        const dx = (p[0] - q[0]) * Math.cos((((p[1] + q[1]) / 2) * Math.PI) / 180)
        const dy = p[1] - q[1]
        return dx * dx + dy * dy <= SEAM_DEG * SEAM_DEG
      })
      if (!near) continue
      hits++
      minLon = Math.min(minLon, p[0])
      maxLon = Math.max(maxLon, p[0])
      minLat = Math.min(minLat, p[1])
      maxLat = Math.max(maxLat, p[1])
    }
  }
  if (hits === 0) return { hits: 0, span: 0 }
  const span = Math.hypot(
    (maxLon - minLon) * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180),
    maxLat - minLat,
  )
  return { hits, span }
}

/**
 * Seam-recovered pairs, kept separately so the heuristic half of adjacency can
 * be reviewed on its own — and so a test can assert what it must never do.
 *
 * A seam is a hairline between two datasets drawing the same border. A STRAIT is
 * water, and 0.1 degrees is 11km at the equator, so the Strait of Messina at 3km
 * would qualify on distance alone. Anything already listed as a sea crossing is
 * therefore excluded here: those pairs are adjacent regardless, through
 * SEA_LINKS, and letting the heuristic claim them as LAND would put invented
 * water crossings into the generated table where nobody reviews them.
 */
const seamPairs: [string, string][] = []
const seaLinked = new Set(SEA_LINKS.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)))
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i]!
    const b = ids[j]!
    if (landBorders[a]!.includes(b)) continue
    if (seaLinked.has(a < b ? `${a}|${b}` : `${b}|${a}`)) continue
    // Cheap reject first: the pairwise vertex walk below is the expensive part,
    // and two territories 25 degrees apart cannot share a hairline seam.
    const ca = COORDS[a]
    const cb = COORDS[b]
    if (ca === undefined || cb === undefined) continue
    const dx = (ca.lon - cb.lon) * Math.cos((((ca.lat + cb.lat) / 2) * Math.PI) / 180)
    if (Math.hypot(dx, ca.lat - cb.lat) > 25) continue
    const contact = seamContact(a, b)
    const back = seamContact(b, a)
    const hits = Math.max(contact.hits, back.hits)
    const span = Math.max(contact.span, back.span)
    if (hits < SEAM_MIN_VERTICES || span <= 0) continue
    link(a, b)
    seamPairs.push([a, b])
  }
}

for (const id of ids) landBorders[id]!.sort()

// ------------------------------------------------------- region outlines --

/**
 * The OUTER boundary of each region, with internal borders dissolved away.
 *
 * Highlighting a region by stroking each of its territories draws every
 * internal border too, so the region reads as a bundle of shapes rather than
 * one area. What is wanted is the outline alone.
 *
 * Built from the SIMPLIFIED coarse rings rather than the raw ones, so the
 * outline traces exactly the edges that get drawn -- an outline derived from
 * different geometry would sit a fraction off the coastline it is meant to
 * follow.
 *
 * Region membership comes from the world and never varies with the board:
 * selectSubMap takes whole regions, so a region on a board has its whole
 * outline.
 */
const regionOutlines: Record<string, Ring[]> = {}
{
  const members = new Map<string, string[]>()
  for (const t of WORLD.territories) {
    members.set(t.region, [...(members.get(t.region) ?? []), t.id])
  }
  for (const [regionId, ids] of members) {
    const present = ids.filter((id) => (shapes[id] ?? []).length > 0)
    if (present.length === 0) continue
    const topo = buildTopology({
      r: {
        type: "GeometryCollection",
        geometries: present.map((id) => ({
          type: "MultiPolygon",
          coordinates: (shapes[id] ?? []).map((ring) => [ring]),
        })),
      },
    })
    const merged = merge(topo, topo.objects.r.geometries)
    const polys = (
      merged.type === "Polygon" ? [merged.coordinates] : merged.coordinates
    ) as unknown as number[][][][]
    regionOutlines[regionId] = polys
      .map((poly) => poly[0] as Ring)
      .filter((r) => r !== undefined && r.length >= 3)
  }
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

/**
 * The same territories at ${FINE_TOLERANCE}° instead of ${TOLERANCE}°.
 *
 * Served ONLY for the territories on a given board, and only once the map is
 * zoomed in far enough for the difference to show. Shipping it for all 264
 * would multiply the page weight for detail nobody can see at the opening fit.
 *
 * ${Object.values(fine).reduce((n, rs) => n + rs.reduce((m, r) => m + r.length, 0), 0).toLocaleString()} points.
 */
export const SHAPES_FINE: Record<TerritoryId, [number, number][][]> = ${JSON.stringify(fine)}

/**
 * The largest label-shaped rectangle that fits INSIDE each territory, as
 * [west, south, east, north].
 *
 * This is the room actually available for a garrison count. Its centre is
 * LABELS. Measuring the territory's BOUNDING box instead — which is what this
 * replaced — is wrong for anything that is not roughly rectangular: Norway's
 * bounding box is enormous while its interior is a few kilometres wide, so the
 * number passed the fit test and then sat in the sea.
 */
export const LABEL_BOXES: Record<TerritoryId, [number, number, number, number]> = ${JSON.stringify(boxes)}

/**
 * Each region's OUTER boundary, internal borders dissolved.
 *
 * Hovering a region should outline the region, not draw every border inside
 * it. Built from the simplified coarse rings, so the outline traces exactly
 * the edges that are drawn.
 */
export const REGION_OUTLINES: Record<string, [number, number][][]> = ${JSON.stringify(regionOutlines)}
`

writeFileSync(new URL("../src/map/shapes.ts", import.meta.url), body)

const pairs = Object.values(landBorders).reduce((n, list) => n + list.length, 0) / 2
const adjacency = `import type { TerritoryId } from "../engine/index.js"

/**
 * Every LAND border on the board, keyed by territory id. GENERATED — do not edit.
 *
 *   npm run build:shapes
 *
 * Read off the shared arcs of the same TopoJSON topology \`SHAPES\` is drawn
 * from, so a border exists here if and only if the two territories share a
 * stretch of drawn edge. That equivalence is the point: adjacency used to be
 * hand-authored beside the generated geometry, and the two drifted into 116
 * disagreements — including a \`gauteng\` polygon that absorbed North West
 * province, visibly touched Botswana, and could not attack it.
 *
 * Two consequences worth knowing before editing anything upstream:
 *
 * - **A corner touch is not a border.** A junction ends an arc instead of
 *   sharing one, so territories meeting at a point are not neighbours.
 * - **A shared arc can cross water.** Natural Earth's admin-1 boundaries meet
 *   mid-strait in places, so Ceuta gives Andalusia a real land border with
 *   Morocco and Northern Ireland gives Ireland one with its UK neighbour. Those
 *   pairs are ALSO listed in \`SEA_LINKS\`; \`world.ts\` joins the two and
 *   de-duplicates. What is never derived is a crossing with no shared edge.
 *
 * ${Object.keys(landBorders).length} territories, ${pairs.toLocaleString()} land borders.
 */
export const LAND_BORDERS: Record<TerritoryId, TerritoryId[]> = ${JSON.stringify(landBorders)}

/**
 * The subset of \`LAND_BORDERS\` recovered by the 0.1° SEAM rule rather than by a
 * shared arc — the heuristic half, exported so it can be reviewed and tested on
 * its own.
 *
 * A seam is one border drawn twice by two datasets, which happens where a
 * Voronoi-carved shape meets an admin-1 one. Pairs already listed in
 * \`SEA_LINKS\` are excluded from the rule: 0.1° is 11 km at the equator, so a
 * narrow strait would otherwise qualify on distance alone and the generated
 * table would claim an unreviewed water crossing as land.
 *
 * ${seamPairs.length} pairs.
 */
export const SEAM_BORDERS: readonly (readonly [TerritoryId, TerritoryId])[] = ${JSON.stringify(seamPairs)}
`

writeFileSync(new URL("../src/map/adjacency.ts", import.meta.url), adjacency)

console.log(`src/map/shapes.ts — ${Object.keys(shapes).length} territories, ${points.toLocaleString()} points, ${(body.length / 1024).toFixed(0)} KB`)
console.log(`src/map/adjacency.ts — ${Object.keys(landBorders).length} territories, ${pairs.toLocaleString()} land borders`)
console.log(
  `  seam-recovered (${seamPairs.length}): ${seamPairs.map(([a, b]) => `${a}|${b}`).join(", ")}`,
)
if (report.length > 0) console.log(`EMPTY (${report.length}): ${report.join(", ")}`)
