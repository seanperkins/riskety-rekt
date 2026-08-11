/**
 * How each game territory finds its real geometry.
 *
 * Three cases, in priority order:
 *
 * 1. `ALIASES` — the territory IS a country, but Natural Earth spells it
 *    differently ("Côte d'Ivoire", "Dem. Rep. Congo").
 * 2. `PARENTS` — the territory is part of a country we split. Its shape is cut
 *    out of the parent by a Voronoi cell over the sibling centroids, so the
 *    coastline is real and only the internal borders are approximate. That is
 *    the right trade for a game board: classic Risk's "Western United States"
 *    is not a real boundary either.
 * 3. Otherwise the territory's `name` matches a Natural Earth country name
 *    exactly, case- and punctuation-insensitively.
 *
 * `MERGES` folds extra countries into a territory that swallowed them — Senegal
 * carries The Gambia and Guinea-Bissau under the microstate rule.
 */

/** territory id -> Natural Earth country name. */
export const ALIASES: Record<string, string> = {
  western_sahara: "W. Sahara",
  south_sudan: "S. Sudan",
  ivory_coast: "Côte d'Ivoire",
  central_african_republic: "Central African Rep.",
  dr_congo: "Dem. Rep. Congo",
  equatorial_guinea: "Eq. Guinea",
  bosnia: "Bosnia and Herz.",
  philippines: "Philippines",
  gulf_states: "United Arab Emirates",
  new_guinea: "Papua New Guinea",
  hispaniola: "Dominican Rep.",
  // At 110m most Antillean islands are absent; Trinidad stands for the chain.
  lesser_antilles: "Trinidad and Tobago",
}

/** territory id -> the Natural Earth country it is carved out of. */
export const PARENTS: Record<string, string> = {}

const carve = (parent: string, ids: string[]): void => {
  for (const id of ids) PARENTS[id] = parent
}

carve("South Africa", [
  "limpopo",
  "gauteng",
  "northern_cape",
  "western_cape",
  "eastern_cape",
  "kwazulu_natal",
])
carve("Spain", ["galicia", "castile", "catalonia", "andalusia"])
carve("United Kingdom", ["scotland", "wales", "england"])
carve("France", ["brittany", "normandy", "aquitaine", "burgundy", "provence", "alsace"])
carve("Belgium", ["flanders"])
carve("Netherlands", ["holland"])
carve("Germany", ["rhineland", "westphalia", "saxony", "bavaria"])
carve("Denmark", ["jutland"])
carve("Czechia", ["bohemia"])
carve("Italy", ["piedmont", "lombardy", "veneto", "tuscany", "lazio", "campania", "apulia", "sicily"])
carve("Austria", ["tyrol"])
carve("Ukraine", ["ukraine_west", "ukraine_east"])
carve("Russia", [
  "kaliningrad",
  "caucasus",
  "karelia",
  "novgorod",
  "moscow",
  "don",
  "volga",
  "ural_west",
  "ural_east",
  "west_siberia",
  "central_siberia",
  "yakutia",
  "chukotka",
  "kamchatka",
])
carve("Turkey", ["thrace", "anatolia_west", "anatolia_central", "anatolia_east"])
carve("Egypt", ["sinai"])
carve("Saudi Arabia", ["hejaz", "najd"])
carve("Iran", ["iran_north", "iran_south", "iran_east", "khorasan"])
carve("Pakistan", ["baluchistan", "pakistan_north", "pakistan_south"])
carve("China", [
  "manchuria",
  "inner_mongolia",
  "xinjiang",
  "beijing",
  "shandong",
  "shanghai",
  "sichuan",
  "guangdong",
  "yunnan",
  "tibet",
])
carve("Japan", ["honshu", "hokkaido", "kyushu"])
carve("India", [
  "kashmir",
  "punjab",
  "rajasthan",
  "gangetic_plain",
  "bengal",
  "deccan",
  "tamil_nadu",
])
carve("Malaysia", ["malaya"])
carve("Indonesia", ["sumatra", "java", "borneo", "sulawesi"])
carve("Australia", [
  "western_australia",
  "northern_territory",
  "queensland",
  "south_australia",
  "new_south_wales",
  "victoria",
])
carve("Canada", [
  "yukon",
  "northwest_territories",
  "british_columbia",
  "alberta",
  "nunavut",
  "saskatchewan",
  "ontario",
  "quebec",
  "maritimes",
])
carve("United States of America", [
  "alaska",
  "cascadia",
  "california",
  "great_basin",
  "southwest",
  "rockies",
  "dakotas",
  "nebraska",
  "missouri",
  "texas",
  "great_lakes_us",
  "new_england",
  "mid_atlantic",
  "appalachia",
  "carolinas",
  "florida",
])
carve("Mexico", ["baja", "sonora", "central_mexico", "yucatan"])
carve("Brazil", [
  "amazonas",
  "para",
  "nordeste",
  "bahia",
  "minas_gerais",
  "sao_paulo",
  "parana",
  "mato_grosso",
])
carve("Argentina", ["pampas", "patagonia"])

/** territory id -> extra Natural Earth countries folded into it. */
export const MERGES: Record<string, string[]> = {
  senegal: ["Gambia", "Guinea-Bissau"],
  // Bahrain is below the 110m resolution cutoff and simply is not in the data.
  gulf_states: ["Qatar"],
  hispaniola: ["Haiti"],
}
