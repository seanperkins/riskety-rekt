import type { GameMap } from "../engine/index.js"

/**
 * The world, at Risk's granularity rather than the UN's: real countries where a
 * country is roughly the right size, large countries split into regions.
 *
 * Rules this data holds to, all enforced by `src/map/world.test.ts`:
 *
 * - **Regions are 4-9 territories.** Eastern Africa as one twenty-country
 *   region is a bonus nobody ever collects.
 * - **Regions are internally contiguous.** Selection takes whole regions
 *   and relies on it; a split region would also make its bonus two separate
 *   conquests paying once.
 * - **Microstates merge into the territory they sit inside.** The Gambia and
 *   Guinea-Bissau are part of `senegal`; Monaco, San Marino, Liechtenstein,
 *   Andorra and the Vatican are not territories.
 * - **Every border is a real land border**, except the sea links, which are
 *   listed together at the bottom of this file with a reason each.
 *
 * `bonus` is ALWAYS 0 here. It is computed per sub-map by `selectSubMap`,
 * because a region's defensibility depends on which of its neighbours were
 * selected — Northern Africa with Southern Europe and Western Asia on the board
 * has three ways in; on a board with neither it is a fortress. A non-zero value
 * here would be silently overwritten and would mislead anyone reading this file.
 *
 * Adjacency is authored by hand and cannot be fully tested — "Chad borders
 * Egypt" is symmetric, connected, in-band and wrong. Run `npm run viewer`.
 */

interface Spec {
  id: string
  name: string
  region: string
  /** Land borders only. Sea links are applied afterwards from SEA_LINKS. */
  borders: string[]
  lat: number
  lon: number
}

const AFRICA: Spec[] = [
  // ---- The Maghreb ----
  { id: "morocco", name: "Morocco", region: "maghreb", borders: ["western_sahara", "algeria"], lat: 31.8, lon: -7.1 },
  { id: "western_sahara", name: "Western Sahara", region: "maghreb", borders: ["morocco", "algeria", "mauritania"], lat: 24.2, lon: -13.0 },
  { id: "algeria", name: "Algeria", region: "maghreb", borders: ["morocco", "western_sahara", "tunisia", "libya", "mauritania", "mali", "niger"], lat: 28.0, lon: 2.6 },
  { id: "tunisia", name: "Tunisia", region: "maghreb", borders: ["algeria", "libya"], lat: 34.0, lon: 9.6 },
  { id: "libya", name: "Libya", region: "maghreb", borders: ["tunisia", "algeria", "niger", "chad", "sudan", "egypt"], lat: 26.3, lon: 17.2 },

  // ---- The Nile ----
  { id: "egypt", name: "Egypt", region: "nile", borders: ["libya", "sudan"], lat: 26.8, lon: 30.8 },
  { id: "sudan", name: "Sudan", region: "nile", borders: ["egypt", "libya", "chad", "central_african_republic", "south_sudan", "eritrea", "ethiopia"], lat: 15.6, lon: 30.2 },
  { id: "south_sudan", name: "South Sudan", region: "nile", borders: ["sudan", "central_african_republic", "dr_congo", "uganda", "kenya", "ethiopia"], lat: 7.3, lon: 30.3 },
  { id: "ethiopia", name: "Ethiopia", region: "nile", borders: ["eritrea", "sudan", "south_sudan", "kenya", "somalia", "djibouti"], lat: 9.1, lon: 40.5 },
  { id: "eritrea", name: "Eritrea", region: "nile", borders: ["sudan", "ethiopia", "djibouti"], lat: 15.2, lon: 39.0 },

  // ---- The Sahel ----
  { id: "mauritania", name: "Mauritania", region: "sahel", borders: ["western_sahara", "algeria", "mali", "senegal"], lat: 20.3, lon: -10.9 },
  { id: "mali", name: "Mali", region: "sahel", borders: ["algeria", "mauritania", "senegal", "guinea", "ivory_coast", "burkina_faso", "niger"], lat: 17.6, lon: -4.0 },
  { id: "niger", name: "Niger", region: "sahel", borders: ["algeria", "libya", "chad", "nigeria", "benin", "burkina_faso", "mali"], lat: 17.6, lon: 8.1 },
  { id: "chad", name: "Chad", region: "sahel", borders: ["libya", "niger", "nigeria", "cameroon", "central_african_republic", "sudan"], lat: 15.5, lon: 18.7 },
  { id: "burkina_faso", name: "Burkina Faso", region: "sahel", borders: ["mali", "niger", "benin", "togo", "ghana", "ivory_coast"], lat: 12.2, lon: -1.6 },

  // ---- The Guinea Coast ----
  { id: "senegal", name: "Senegal", region: "guinea_coast", borders: ["mauritania", "mali", "guinea"], lat: 14.5, lon: -14.5 },
  { id: "guinea", name: "Guinea", region: "guinea_coast", borders: ["senegal", "mali", "ivory_coast", "liberia", "sierra_leone"], lat: 9.9, lon: -11.3 },
  { id: "sierra_leone", name: "Sierra Leone", region: "guinea_coast", borders: ["guinea", "liberia"], lat: 8.5, lon: -11.8 },
  { id: "liberia", name: "Liberia", region: "guinea_coast", borders: ["sierra_leone", "guinea", "ivory_coast"], lat: 6.4, lon: -9.4 },
  { id: "ivory_coast", name: "Ivory Coast", region: "guinea_coast", borders: ["liberia", "guinea", "mali", "burkina_faso", "ghana"], lat: 7.5, lon: -5.5 },
  { id: "ghana", name: "Ghana", region: "guinea_coast", borders: ["ivory_coast", "burkina_faso", "togo"], lat: 7.9, lon: -1.0 },

  // ---- The Niger Delta ----
  { id: "togo", name: "Togo", region: "niger_delta", borders: ["ghana", "burkina_faso", "benin"], lat: 8.6, lon: 0.8 },
  { id: "benin", name: "Benin", region: "niger_delta", borders: ["togo", "burkina_faso", "niger", "nigeria"], lat: 9.3, lon: 2.3 },
  { id: "nigeria", name: "Nigeria", region: "niger_delta", borders: ["benin", "niger", "chad", "cameroon"], lat: 9.1, lon: 8.7 },
  { id: "cameroon", name: "Cameroon", region: "niger_delta", borders: ["nigeria", "chad", "central_african_republic", "congo", "gabon", "equatorial_guinea"], lat: 7.4, lon: 12.4 },

  // ---- The Horn ----
  { id: "djibouti", name: "Djibouti", region: "horn", borders: ["eritrea", "ethiopia", "somalia"], lat: 11.8, lon: 42.6 },
  { id: "somalia", name: "Somalia", region: "horn", borders: ["djibouti", "ethiopia", "kenya"], lat: 5.2, lon: 46.2 },
  { id: "kenya", name: "Kenya", region: "horn", borders: ["somalia", "ethiopia", "south_sudan", "uganda", "tanzania"], lat: 0.0, lon: 37.9 },
  { id: "uganda", name: "Uganda", region: "horn", borders: ["south_sudan", "kenya", "tanzania", "rwanda", "dr_congo"], lat: 1.4, lon: 32.3 },

  // ---- The Congo Basin ----
  { id: "central_african_republic", name: "Central African Republic", region: "congo_basin", borders: ["chad", "sudan", "south_sudan", "dr_congo", "congo", "cameroon"], lat: 6.6, lon: 20.9 },
  { id: "dr_congo", name: "DR Congo", region: "congo_basin", borders: ["central_african_republic", "south_sudan", "uganda", "rwanda", "burundi", "tanzania", "zambia", "angola", "congo"], lat: -4.0, lon: 21.8 },
  { id: "congo", name: "Congo", region: "congo_basin", borders: ["cameroon", "central_african_republic", "dr_congo", "gabon"], lat: -0.2, lon: 15.8 },
  { id: "gabon", name: "Gabon", region: "congo_basin", borders: ["cameroon", "equatorial_guinea", "congo"], lat: -0.8, lon: 11.6 },
  { id: "equatorial_guinea", name: "Equatorial Guinea", region: "congo_basin", borders: ["cameroon", "gabon"], lat: 1.6, lon: 10.3 },
  { id: "angola", name: "Angola", region: "congo_basin", borders: ["dr_congo", "zambia", "namibia"], lat: -11.2, lon: 17.9 },

  // ---- The Great Lakes ----
  { id: "rwanda", name: "Rwanda", region: "great_lakes", borders: ["uganda", "dr_congo", "burundi", "tanzania"], lat: -1.9, lon: 29.9 },
  { id: "burundi", name: "Burundi", region: "great_lakes", borders: ["rwanda", "dr_congo", "tanzania"], lat: -3.4, lon: 29.9 },
  { id: "tanzania", name: "Tanzania", region: "great_lakes", borders: ["kenya", "uganda", "rwanda", "burundi", "dr_congo", "zambia", "malawi", "mozambique"], lat: -6.4, lon: 34.9 },
  { id: "zambia", name: "Zambia", region: "great_lakes", borders: ["dr_congo", "tanzania", "malawi", "mozambique", "zimbabwe", "botswana", "namibia", "angola"], lat: -13.1, lon: 27.8 },
  { id: "malawi", name: "Malawi", region: "great_lakes", borders: ["tanzania", "zambia", "mozambique"], lat: -13.3, lon: 34.3 },

  // ---- The Zambezi ----
  { id: "namibia", name: "Namibia", region: "zambezi", borders: ["angola", "zambia", "botswana", "northern_cape"], lat: -22.6, lon: 17.1 },
  { id: "botswana", name: "Botswana", region: "zambezi", borders: ["namibia", "zambia", "zimbabwe", "northern_cape", "limpopo"], lat: -22.3, lon: 24.7 },
  { id: "zimbabwe", name: "Zimbabwe", region: "zambezi", borders: ["zambia", "botswana", "mozambique", "limpopo"], lat: -19.0, lon: 29.2 },
  { id: "mozambique", name: "Mozambique", region: "zambezi", borders: ["tanzania", "malawi", "zambia", "zimbabwe", "limpopo", "kwazulu_natal", "eswatini"], lat: -18.7, lon: 35.5 },
  { id: "madagascar", name: "Madagascar", region: "zambezi", borders: [], lat: -18.8, lon: 46.9 },

  // ---- The Cape ----
  // South Africa is split into provinces the way classic Risk splits the United
  // States. As one territory it left this region at three, below the floor.
  { id: "limpopo", name: "Limpopo", region: "cape", borders: ["botswana", "zimbabwe", "mozambique", "gauteng", "kwazulu_natal", "eswatini"], lat: -23.4, lon: 29.5 },
  { id: "gauteng", name: "Gauteng", region: "cape", borders: ["limpopo", "northern_cape", "kwazulu_natal"], lat: -26.3, lon: 28.1 },
  { id: "northern_cape", name: "Northern Cape", region: "cape", borders: ["namibia", "botswana", "gauteng", "western_cape", "eastern_cape"], lat: -29.0, lon: 21.9 },
  { id: "western_cape", name: "Western Cape", region: "cape", borders: ["northern_cape", "eastern_cape"], lat: -33.2, lon: 21.9 },
  { id: "eastern_cape", name: "Eastern Cape", region: "cape", borders: ["western_cape", "northern_cape", "lesotho", "kwazulu_natal"], lat: -32.3, lon: 26.4 },
  { id: "kwazulu_natal", name: "KwaZulu-Natal", region: "cape", borders: ["limpopo", "gauteng", "eastern_cape", "lesotho", "eswatini", "mozambique"], lat: -28.5, lon: 30.9 },
  { id: "lesotho", name: "Lesotho", region: "cape", borders: ["eastern_cape", "kwazulu_natal"], lat: -29.6, lon: 28.2 },
  { id: "eswatini", name: "Eswatini", region: "cape", borders: ["kwazulu_natal", "mozambique", "limpopo"], lat: -26.5, lon: 31.5 },
]

const CONTINENTS: { id: string; name: string }[] = [
  { id: "maghreb", name: "The Maghreb" },
  { id: "nile", name: "The Nile" },
  { id: "sahel", name: "The Sahel" },
  { id: "guinea_coast", name: "The Guinea Coast" },
  { id: "niger_delta", name: "The Niger Delta" },
  { id: "horn", name: "The Horn" },
  { id: "congo_basin", name: "The Congo Basin" },
  { id: "great_lakes", name: "The Great Lakes" },
  { id: "zambezi", name: "The Zambezi" },
  { id: "cape", name: "The Cape" },
]

/**
 * Sea links. Every one is a decision, exactly as `kamchatka <-> alaska` is a
 * decision in classic Risk, and each creates a chokepoint. They are listed
 * together because this set IS the strategic skeleton joining the landmasses —
 * scattered through the territory records, nobody could see the shape of it.
 *
 * A pure land-border graph is disconnected: Madagascar, Iceland, the British
 * Isles, Japan, Sri Lanka, Indonesia, Australia and the Caribbean have no land
 * neighbours at all.
 *
 * A link needed for a landmass's OWN contiguity ships with that landmass rather
 * than waiting for the rest, so every commit leaves the world valid.
 */
const SEA_LINKS: [string, string][] = [
  ["madagascar", "mozambique"], // the Mozambique Channel
]

/** Applies the sea links symmetrically and freezes the result into a GameMap. */
function build(specs: Spec[], regions: { id: string; name: string }[]): GameMap {
  const borders = new Map(specs.map((s) => [s.id, [...s.borders]]))
  for (const [a, b] of SEA_LINKS) {
    borders.get(a)?.push(b)
    borders.get(b)?.push(a)
  }
  return {
    regions: regions.map((c) => ({ ...c, bonus: 0 })),
    territories: specs.map((s) => ({
      id: s.id,
      name: s.name,
      region: s.region,
      neighbors: borders.get(s.id) ?? [],
    })),
  }
}

export const WORLD: GameMap = build(AFRICA, CONTINENTS)

/** Every territory's approximate centroid, for `src/map/coords.ts`. */
export const SPECS: readonly Spec[] = AFRICA
