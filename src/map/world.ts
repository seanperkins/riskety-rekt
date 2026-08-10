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
  { id: "egypt", name: "Egypt", region: "nile", borders: ["libya", "sudan", "sinai"], lat: 26.8, lon: 30.8 },
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

const EUROPE: Spec[] = [
  // ---- Iberia ----
  { id: "portugal", name: "Portugal", region: "iberia", borders: ["galicia", "castile", "andalusia"], lat: 39.6, lon: -8.0 },
  { id: "galicia", name: "Galicia", region: "iberia", borders: ["portugal", "castile"], lat: 42.8, lon: -8.0 },
  { id: "castile", name: "Castile", region: "iberia", borders: ["galicia", "portugal", "andalusia", "catalonia"], lat: 41.0, lon: -4.0 },
  { id: "catalonia", name: "Catalonia", region: "iberia", borders: ["castile", "andalusia", "aquitaine"], lat: 41.8, lon: 1.5 },
  { id: "andalusia", name: "Andalusia", region: "iberia", borders: ["portugal", "castile", "catalonia"], lat: 37.4, lon: -4.8 },

  // ---- The British Isles ----
  { id: "ireland", name: "Ireland", region: "british_isles", borders: [], lat: 53.3, lon: -8.0 },
  { id: "scotland", name: "Scotland", region: "british_isles", borders: ["england"], lat: 56.8, lon: -4.2 },
  { id: "wales", name: "Wales", region: "british_isles", borders: ["england"], lat: 52.3, lon: -3.8 },
  { id: "england", name: "England", region: "british_isles", borders: ["scotland", "wales"], lat: 52.5, lon: -1.2 },

  // ---- Gaul ----
  { id: "brittany", name: "Brittany", region: "gaul", borders: ["normandy", "aquitaine", "burgundy"], lat: 48.1, lon: -2.9 },
  { id: "normandy", name: "Normandy", region: "gaul", borders: ["brittany", "burgundy", "alsace", "flanders"], lat: 49.2, lon: 0.2 },
  { id: "aquitaine", name: "Aquitaine", region: "gaul", borders: ["brittany", "burgundy", "provence", "catalonia"], lat: 44.8, lon: -0.6 },
  { id: "burgundy", name: "Burgundy", region: "gaul", borders: ["brittany", "normandy", "aquitaine", "provence", "alsace", "switzerland"], lat: 47.1, lon: 4.6 },
  { id: "provence", name: "Provence", region: "gaul", borders: ["aquitaine", "burgundy", "switzerland", "piedmont"], lat: 43.9, lon: 5.9 },
  { id: "alsace", name: "Alsace", region: "gaul", borders: ["normandy", "burgundy", "flanders", "rhineland", "switzerland"], lat: 48.3, lon: 7.4 },

  // ---- The Low Countries ----
  { id: "flanders", name: "Flanders", region: "low_countries", borders: ["normandy", "alsace", "holland", "rhineland"], lat: 50.8, lon: 4.1 },
  { id: "holland", name: "Holland", region: "low_countries", borders: ["flanders", "rhineland", "westphalia"], lat: 52.2, lon: 5.3 },
  { id: "rhineland", name: "Rhineland", region: "low_countries", borders: ["flanders", "holland", "alsace", "westphalia", "bavaria", "switzerland"], lat: 50.3, lon: 7.3 },
  { id: "westphalia", name: "Westphalia", region: "low_countries", borders: ["holland", "rhineland", "saxony", "bavaria", "jutland"], lat: 52.0, lon: 8.6 },

  // ---- The Nordics ----
  { id: "iceland", name: "Iceland", region: "nordics", borders: [], lat: 64.9, lon: -19.0 },
  { id: "norway", name: "Norway", region: "nordics", borders: ["sweden", "finland"], lat: 61.0, lon: 8.5 },
  { id: "sweden", name: "Sweden", region: "nordics", borders: ["norway", "finland"], lat: 60.1, lon: 15.0 },
  { id: "finland", name: "Finland", region: "nordics", borders: ["norway", "sweden", "karelia"], lat: 63.5, lon: 26.0 },
  { id: "jutland", name: "Jutland", region: "nordics", borders: ["westphalia", "saxony"], lat: 56.2, lon: 9.5 },

  // ---- Central Europe ----
  { id: "saxony", name: "Saxony", region: "central_europe", borders: ["westphalia", "jutland", "bavaria", "bohemia", "poland"], lat: 51.9, lon: 12.5 },
  { id: "bavaria", name: "Bavaria", region: "central_europe", borders: ["rhineland", "westphalia", "saxony", "bohemia", "austria", "switzerland"], lat: 48.8, lon: 11.4 },
  { id: "bohemia", name: "Bohemia", region: "central_europe", borders: ["saxony", "bavaria", "austria", "slovakia", "poland"], lat: 49.8, lon: 15.0 },
  { id: "slovakia", name: "Slovakia", region: "central_europe", borders: ["bohemia", "poland", "austria", "hungary", "ukraine_west"], lat: 48.7, lon: 19.5 },
  { id: "austria", name: "Austria", region: "central_europe", borders: ["bavaria", "bohemia", "slovakia", "hungary", "slovenia", "switzerland", "tyrol"], lat: 47.6, lon: 14.6 },
  { id: "switzerland", name: "Switzerland", region: "central_europe", borders: ["burgundy", "provence", "alsace", "rhineland", "bavaria", "austria", "tyrol", "piedmont"], lat: 46.8, lon: 8.2 },

  // ---- Italy ----
  { id: "piedmont", name: "Piedmont", region: "italy", borders: ["provence", "switzerland", "tyrol", "lombardy", "tuscany"], lat: 45.1, lon: 7.9 },
  { id: "tyrol", name: "Tyrol", region: "italy", borders: ["switzerland", "austria", "piedmont", "lombardy", "veneto"], lat: 46.6, lon: 11.4 },
  { id: "lombardy", name: "Lombardy", region: "italy", borders: ["piedmont", "tyrol", "veneto", "tuscany"], lat: 45.5, lon: 9.7 },
  { id: "veneto", name: "Veneto", region: "italy", borders: ["tyrol", "lombardy", "tuscany", "slovenia"], lat: 45.6, lon: 12.0 },
  { id: "tuscany", name: "Tuscany", region: "italy", borders: ["piedmont", "lombardy", "veneto", "lazio"], lat: 43.5, lon: 11.2 },
  { id: "lazio", name: "Lazio", region: "italy", borders: ["tuscany", "campania"], lat: 41.9, lon: 12.7 },
  { id: "campania", name: "Campania", region: "italy", borders: ["lazio", "apulia"], lat: 40.8, lon: 14.8 },
  { id: "apulia", name: "Apulia", region: "italy", borders: ["campania"], lat: 41.0, lon: 16.6 },
  { id: "sicily", name: "Sicily", region: "italy", borders: [], lat: 37.6, lon: 14.0 },

  // ---- The Balkans ----
  { id: "slovenia", name: "Slovenia", region: "balkans", borders: ["austria", "veneto", "croatia", "hungary"], lat: 46.1, lon: 14.8 },
  { id: "croatia", name: "Croatia", region: "balkans", borders: ["slovenia", "hungary", "bosnia", "serbia"], lat: 45.3, lon: 16.3 },
  { id: "bosnia", name: "Bosnia", region: "balkans", borders: ["croatia", "serbia", "montenegro"], lat: 44.0, lon: 17.9 },
  { id: "serbia", name: "Serbia", region: "balkans", borders: ["croatia", "bosnia", "montenegro", "albania", "macedonia", "bulgaria", "romania", "hungary"], lat: 44.0, lon: 20.9 },
  { id: "montenegro", name: "Montenegro", region: "balkans", borders: ["bosnia", "serbia", "albania"], lat: 42.7, lon: 19.4 },
  { id: "albania", name: "Albania", region: "balkans", borders: ["montenegro", "serbia", "macedonia", "greece"], lat: 41.2, lon: 20.1 },
  { id: "macedonia", name: "Macedonia", region: "balkans", borders: ["serbia", "albania", "greece", "bulgaria"], lat: 41.6, lon: 21.7 },
  { id: "greece", name: "Greece", region: "balkans", borders: ["albania", "macedonia", "bulgaria", "thrace"], lat: 39.3, lon: 22.3 },

  // ---- Carpathia ----
  { id: "hungary", name: "Hungary", region: "carpathia", borders: ["austria", "slovakia", "slovenia", "croatia", "serbia", "romania", "ukraine_west"], lat: 47.1, lon: 19.4 },
  { id: "poland", name: "Poland", region: "carpathia", borders: ["saxony", "bohemia", "slovakia", "ukraine_west", "belarus", "lithuania", "kaliningrad"], lat: 52.1, lon: 19.4 },
  { id: "romania", name: "Romania", region: "carpathia", borders: ["hungary", "serbia", "bulgaria", "moldova", "ukraine_west"], lat: 45.9, lon: 25.0 },
  { id: "moldova", name: "Moldova", region: "carpathia", borders: ["romania", "ukraine_west"], lat: 47.2, lon: 28.5 },
  { id: "bulgaria", name: "Bulgaria", region: "carpathia", borders: ["romania", "serbia", "macedonia", "greece", "thrace"], lat: 42.7, lon: 25.5 },
  { id: "ukraine_west", name: "Western Ukraine", region: "carpathia", borders: ["poland", "slovakia", "hungary", "romania", "moldova", "belarus", "ukraine_east"], lat: 49.5, lon: 27.0 },

  // ---- The Baltic ----
  { id: "kaliningrad", name: "Kaliningrad", region: "baltic", borders: ["poland", "lithuania"], lat: 54.7, lon: 21.0 },
  { id: "lithuania", name: "Lithuania", region: "baltic", borders: ["kaliningrad", "poland", "latvia", "belarus"], lat: 55.2, lon: 23.9 },
  { id: "latvia", name: "Latvia", region: "baltic", borders: ["lithuania", "estonia", "belarus", "novgorod"], lat: 56.9, lon: 24.9 },
  { id: "estonia", name: "Estonia", region: "baltic", borders: ["latvia", "novgorod"], lat: 58.6, lon: 25.0 },
  { id: "belarus", name: "Belarus", region: "baltic", borders: ["lithuania", "latvia", "poland", "ukraine_west", "ukraine_east", "novgorod", "moscow"], lat: 53.7, lon: 27.9 },

  // ---- Western Russia ----
  { id: "karelia", name: "Karelia", region: "russia_west", borders: ["finland", "novgorod"], lat: 63.0, lon: 33.0 },
  { id: "novgorod", name: "Novgorod", region: "russia_west", borders: ["karelia", "estonia", "latvia", "belarus", "moscow"], lat: 58.5, lon: 31.3 },
  { id: "moscow", name: "Moscow", region: "russia_west", borders: ["novgorod", "belarus", "ukraine_east", "volga"], lat: 55.8, lon: 37.6 },
  { id: "ukraine_east", name: "Eastern Ukraine", region: "russia_west", borders: ["ukraine_west", "belarus", "moscow", "volga", "don"], lat: 48.5, lon: 37.0 },
  { id: "don", name: "The Don", region: "russia_west", borders: ["ukraine_east", "volga", "caucasus"], lat: 47.5, lon: 42.0 },
  { id: "volga", name: "The Volga", region: "russia_west", borders: ["moscow", "ukraine_east", "don", "caucasus", "ural_west"], lat: 52.0, lon: 46.0 },
  { id: "ural_west", name: "Western Urals", region: "russia_west", borders: ["volga", "kazakhstan", "ural_east"], lat: 57.0, lon: 57.0 },

  // ---- Anatolia ----
  { id: "thrace", name: "Thrace", region: "anatolia", borders: ["greece", "bulgaria", "anatolia_west"], lat: 41.2, lon: 27.0 },
  { id: "anatolia_west", name: "Western Anatolia", region: "anatolia", borders: ["thrace", "anatolia_central"], lat: 38.9, lon: 28.5 },
  { id: "anatolia_central", name: "Central Anatolia", region: "anatolia", borders: ["anatolia_west", "anatolia_east", "syria"], lat: 39.0, lon: 33.5 },
  { id: "anatolia_east", name: "Eastern Anatolia", region: "anatolia", borders: ["anatolia_central", "syria", "iraq", "armenia", "georgia"], lat: 39.4, lon: 41.0 },
  { id: "cyprus", name: "Cyprus", region: "anatolia", borders: [], lat: 35.1, lon: 33.4 },

  // ---- The Caucasus ----
  { id: "georgia", name: "Georgia", region: "caucasus", borders: ["anatolia_east", "armenia", "azerbaijan", "caucasus"], lat: 42.3, lon: 43.4 },
  { id: "armenia", name: "Armenia", region: "caucasus", borders: ["anatolia_east", "georgia", "azerbaijan", "iran_north"], lat: 40.1, lon: 45.0 },
  { id: "azerbaijan", name: "Azerbaijan", region: "caucasus", borders: ["georgia", "armenia", "iran_north", "caucasus"], lat: 40.3, lon: 47.9 },
  { id: "caucasus", name: "The Caucasus", region: "caucasus", borders: ["don", "volga", "georgia", "azerbaijan"], lat: 43.5, lon: 44.5 },

  // ---- The Levant ----
  { id: "syria", name: "Syria", region: "levant", borders: ["anatolia_central", "anatolia_east", "iraq", "jordan", "lebanon", "israel"], lat: 35.0, lon: 38.5 },
  { id: "lebanon", name: "Lebanon", region: "levant", borders: ["syria", "israel"], lat: 33.9, lon: 35.9 },
  { id: "israel", name: "Israel", region: "levant", borders: ["lebanon", "syria", "jordan", "sinai"], lat: 31.5, lon: 35.0 },
  { id: "jordan", name: "Jordan", region: "levant", borders: ["syria", "israel", "iraq", "najd"], lat: 31.3, lon: 36.6 },
  { id: "iraq", name: "Iraq", region: "levant", borders: ["anatolia_east", "syria", "jordan", "najd", "kuwait", "iran_south", "iran_north"], lat: 33.2, lon: 43.7 },
  { id: "sinai", name: "Sinai", region: "levant", borders: ["israel", "egypt"], lat: 29.5, lon: 33.8 },

  // ---- Arabia ----
  { id: "hejaz", name: "Hejaz", region: "arabia", borders: ["najd", "yemen"], lat: 22.0, lon: 40.0 },
  { id: "najd", name: "Najd", region: "arabia", borders: ["hejaz", "jordan", "iraq", "kuwait", "gulf_states", "oman", "yemen"], lat: 24.5, lon: 45.5 },
  { id: "kuwait", name: "Kuwait", region: "arabia", borders: ["iraq", "najd", "gulf_states"], lat: 29.3, lon: 47.6 },
  { id: "gulf_states", name: "The Gulf States", region: "arabia", borders: ["najd", "kuwait", "oman"], lat: 24.3, lon: 52.5 },
  { id: "oman", name: "Oman", region: "arabia", borders: ["gulf_states", "najd", "yemen"], lat: 21.0, lon: 56.5 },
  { id: "yemen", name: "Yemen", region: "arabia", borders: ["hejaz", "najd", "oman"], lat: 15.5, lon: 47.6 },
]

const ASIA: Spec[] = [
  // ---- Persia ----
  { id: "iran_north", name: "Northern Iran", region: "persia", borders: ["armenia", "azerbaijan", "iraq", "iran_south", "iran_east", "khorasan"], lat: 36.2, lon: 49.5 },
  { id: "iran_south", name: "Southern Iran", region: "persia", borders: ["iraq", "iran_north", "iran_east", "baluchistan"], lat: 29.5, lon: 52.5 },
  { id: "iran_east", name: "Eastern Iran", region: "persia", borders: ["iran_north", "iran_south", "khorasan", "baluchistan"], lat: 32.5, lon: 57.5 },
  { id: "khorasan", name: "Khorasan", region: "persia", borders: ["iran_north", "iran_east", "turkmenistan", "afghanistan"], lat: 35.5, lon: 59.5 },
  { id: "baluchistan", name: "Baluchistan", region: "persia", borders: ["iran_south", "iran_east", "afghanistan", "pakistan_south"], lat: 28.0, lon: 62.5 },

  // ---- Central Asia ----
  { id: "kazakhstan", name: "Kazakhstan", region: "central_asia", borders: ["ural_west", "ural_east", "west_siberia", "uzbekistan", "turkmenistan", "kyrgyzstan", "xinjiang"], lat: 48.0, lon: 67.0 },
  { id: "uzbekistan", name: "Uzbekistan", region: "central_asia", borders: ["kazakhstan", "turkmenistan", "tajikistan", "kyrgyzstan", "afghanistan"], lat: 41.4, lon: 64.6 },
  { id: "turkmenistan", name: "Turkmenistan", region: "central_asia", borders: ["kazakhstan", "uzbekistan", "khorasan", "afghanistan"], lat: 38.9, lon: 59.6 },
  { id: "tajikistan", name: "Tajikistan", region: "central_asia", borders: ["uzbekistan", "kyrgyzstan", "afghanistan", "xinjiang"], lat: 38.9, lon: 71.3 },
  { id: "kyrgyzstan", name: "Kyrgyzstan", region: "central_asia", borders: ["kazakhstan", "uzbekistan", "tajikistan", "xinjiang"], lat: 41.2, lon: 74.8 },

  // ---- Siberia ----
  { id: "ural_east", name: "Eastern Urals", region: "siberia", borders: ["ural_west", "kazakhstan", "west_siberia"], lat: 58.0, lon: 63.0 },
  { id: "west_siberia", name: "Western Siberia", region: "siberia", borders: ["ural_east", "kazakhstan", "central_siberia", "xinjiang", "mongolia"], lat: 58.0, lon: 80.0 },
  { id: "central_siberia", name: "Central Siberia", region: "siberia", borders: ["west_siberia", "yakutia", "mongolia", "manchuria"], lat: 60.0, lon: 105.0 },
  { id: "yakutia", name: "Yakutia", region: "siberia", borders: ["central_siberia", "chukotka", "kamchatka", "manchuria"], lat: 64.0, lon: 128.0 },
  { id: "chukotka", name: "Chukotka", region: "siberia", borders: ["yakutia", "kamchatka"], lat: 66.0, lon: 172.0 },
  { id: "kamchatka", name: "Kamchatka", region: "siberia", borders: ["yakutia", "chukotka"], lat: 56.0, lon: 159.0 },

  // ---- The Steppe ----
  { id: "mongolia", name: "Mongolia", region: "steppe", borders: ["west_siberia", "central_siberia", "inner_mongolia", "xinjiang", "manchuria"], lat: 46.9, lon: 103.8 },
  { id: "manchuria", name: "Manchuria", region: "steppe", borders: ["central_siberia", "yakutia", "mongolia", "inner_mongolia", "korea_north", "beijing"], lat: 45.0, lon: 126.0 },
  { id: "inner_mongolia", name: "Inner Mongolia", region: "steppe", borders: ["mongolia", "manchuria", "xinjiang", "beijing"], lat: 42.5, lon: 112.0 },
  { id: "xinjiang", name: "Xinjiang", region: "steppe", borders: ["kazakhstan", "kyrgyzstan", "tajikistan", "west_siberia", "mongolia", "inner_mongolia", "tibet", "afghanistan", "kashmir"], lat: 41.5, lon: 85.0 },

  // ---- China ----
  { id: "beijing", name: "Beijing", region: "china", borders: ["inner_mongolia", "manchuria", "shandong", "shanghai", "sichuan"], lat: 39.9, lon: 116.4 },
  { id: "shandong", name: "Shandong", region: "china", borders: ["beijing", "shanghai"], lat: 36.4, lon: 118.1 },
  { id: "shanghai", name: "Shanghai", region: "china", borders: ["beijing", "shandong", "sichuan", "guangdong"], lat: 31.2, lon: 120.5 },
  { id: "sichuan", name: "Sichuan", region: "china", borders: ["beijing", "shanghai", "guangdong", "yunnan", "tibet"], lat: 30.7, lon: 103.9 },
  { id: "guangdong", name: "Guangdong", region: "china", borders: ["shanghai", "sichuan", "yunnan", "vietnam"], lat: 23.1, lon: 113.3 },
  { id: "yunnan", name: "Yunnan", region: "china", borders: ["sichuan", "guangdong", "tibet", "myanmar", "laos", "vietnam"], lat: 25.0, lon: 101.5 },
  { id: "tibet", name: "Tibet", region: "china", borders: ["xinjiang", "sichuan", "yunnan", "myanmar", "nepal", "kashmir"], lat: 31.5, lon: 88.0 },

  // ---- Korea and Japan ----
  { id: "korea_north", name: "North Korea", region: "korea_japan", borders: ["manchuria", "korea_south"], lat: 40.0, lon: 127.0 },
  { id: "korea_south", name: "South Korea", region: "korea_japan", borders: ["korea_north"], lat: 36.4, lon: 127.9 },
  { id: "honshu", name: "Honshu", region: "korea_japan", borders: [], lat: 36.2, lon: 138.3 },
  { id: "hokkaido", name: "Hokkaido", region: "korea_japan", borders: [], lat: 43.3, lon: 142.8 },
  { id: "kyushu", name: "Kyushu", region: "korea_japan", borders: [], lat: 32.5, lon: 131.0 },

  // ---- The Hindu Kush ----
  { id: "afghanistan", name: "Afghanistan", region: "hindu_kush", borders: ["khorasan", "baluchistan", "turkmenistan", "uzbekistan", "tajikistan", "xinjiang", "pakistan_north", "pakistan_south"], lat: 33.9, lon: 66.0 },
  { id: "pakistan_north", name: "Northern Pakistan", region: "hindu_kush", borders: ["afghanistan", "pakistan_south", "kashmir", "punjab"], lat: 33.5, lon: 71.5 },
  { id: "pakistan_south", name: "Sindh", region: "hindu_kush", borders: ["afghanistan", "baluchistan", "pakistan_north", "rajasthan"], lat: 26.0, lon: 68.5 },
  { id: "kashmir", name: "Kashmir", region: "hindu_kush", borders: ["pakistan_north", "tibet", "punjab", "xinjiang"], lat: 34.1, lon: 76.5 },
  { id: "punjab", name: "Punjab", region: "hindu_kush", borders: ["pakistan_north", "kashmir", "rajasthan", "gangetic_plain"], lat: 30.9, lon: 75.9 },

  // ---- India ----
  { id: "rajasthan", name: "Rajasthan", region: "india", borders: ["pakistan_south", "punjab", "gangetic_plain", "deccan"], lat: 27.0, lon: 74.2 },
  { id: "gangetic_plain", name: "The Gangetic Plain", region: "india", borders: ["punjab", "rajasthan", "nepal", "bengal", "deccan"], lat: 26.8, lon: 82.0 },
  { id: "nepal", name: "Nepal", region: "india", borders: ["tibet", "gangetic_plain"], lat: 28.4, lon: 84.1 },
  { id: "bengal", name: "Bengal", region: "india", borders: ["gangetic_plain", "deccan", "myanmar"], lat: 23.7, lon: 89.5 },
  { id: "deccan", name: "The Deccan", region: "india", borders: ["rajasthan", "gangetic_plain", "bengal", "tamil_nadu"], lat: 18.5, lon: 77.0 },
  { id: "tamil_nadu", name: "Tamil Nadu", region: "india", borders: ["deccan"], lat: 11.1, lon: 78.7 },
  { id: "sri_lanka", name: "Sri Lanka", region: "india", borders: [], lat: 7.9, lon: 80.8 },

  // ---- Indochina ----
  { id: "myanmar", name: "Myanmar", region: "indochina", borders: ["bengal", "tibet", "yunnan", "thailand", "laos"], lat: 21.9, lon: 96.0 },
  { id: "thailand", name: "Thailand", region: "indochina", borders: ["myanmar", "laos", "cambodia", "malaya"], lat: 15.9, lon: 100.9 },
  { id: "laos", name: "Laos", region: "indochina", borders: ["myanmar", "thailand", "cambodia", "vietnam", "yunnan"], lat: 19.9, lon: 102.5 },
  { id: "cambodia", name: "Cambodia", region: "indochina", borders: ["thailand", "laos", "vietnam"], lat: 12.6, lon: 104.9 },
  { id: "vietnam", name: "Vietnam", region: "indochina", borders: ["laos", "cambodia", "yunnan", "guangdong"], lat: 14.1, lon: 108.3 },

  // ---- Insulindia ----
  { id: "malaya", name: "Malaya", region: "insulindia", borders: ["thailand"], lat: 4.2, lon: 102.0 },
  { id: "sumatra", name: "Sumatra", region: "insulindia", borders: [], lat: -0.6, lon: 101.3 },
  { id: "java", name: "Java", region: "insulindia", borders: [], lat: -7.3, lon: 110.0 },
  { id: "borneo", name: "Borneo", region: "insulindia", borders: [], lat: 0.9, lon: 114.0 },
  { id: "sulawesi", name: "Sulawesi", region: "insulindia", borders: [], lat: -2.0, lon: 120.9 },
  { id: "philippines", name: "The Philippines", region: "insulindia", borders: [], lat: 12.9, lon: 122.8 },

  // ---- Australia ----
  { id: "western_australia", name: "Western Australia", region: "australia", borders: ["northern_territory", "south_australia"], lat: -25.0, lon: 122.0 },
  { id: "northern_territory", name: "Northern Territory", region: "australia", borders: ["western_australia", "queensland", "south_australia"], lat: -19.5, lon: 133.4 },
  { id: "queensland", name: "Queensland", region: "australia", borders: ["northern_territory", "south_australia", "new_south_wales"], lat: -22.6, lon: 144.3 },
  { id: "south_australia", name: "South Australia", region: "australia", borders: ["western_australia", "northern_territory", "queensland", "new_south_wales", "victoria"], lat: -30.0, lon: 135.8 },
  { id: "new_south_wales", name: "New South Wales", region: "australia", borders: ["queensland", "south_australia", "victoria"], lat: -32.2, lon: 147.0 },
  { id: "victoria", name: "Victoria", region: "australia", borders: ["south_australia", "new_south_wales"], lat: -37.0, lon: 144.3 },

  // ---- Oceania ----
  { id: "new_guinea", name: "New Guinea", region: "oceania", borders: [], lat: -5.7, lon: 141.0 },
  { id: "new_zealand", name: "New Zealand", region: "oceania", borders: [], lat: -41.5, lon: 172.8 },
  { id: "fiji", name: "Fiji", region: "oceania", borders: [], lat: -17.7, lon: 178.0 },
  { id: "new_caledonia", name: "New Caledonia", region: "oceania", borders: [], lat: -21.3, lon: 165.6 },
]

const AMERICAS: Spec[] = [
  // ---- Western Canada ----
  { id: "alaska", name: "Alaska", region: "canada_west", borders: ["yukon", "british_columbia"], lat: 64.2, lon: -149.5 },
  { id: "yukon", name: "Yukon", region: "canada_west", borders: ["alaska", "northwest_territories", "british_columbia"], lat: 64.3, lon: -135.0 },
  { id: "northwest_territories", name: "Northwest Territories", region: "canada_west", borders: ["yukon", "british_columbia", "alberta", "nunavut"], lat: 64.8, lon: -119.0 },
  { id: "british_columbia", name: "British Columbia", region: "canada_west", borders: ["alaska", "yukon", "northwest_territories", "alberta", "cascadia"], lat: 53.7, lon: -125.0 },
  { id: "alberta", name: "Alberta", region: "canada_west", borders: ["british_columbia", "northwest_territories", "saskatchewan", "rockies"], lat: 53.9, lon: -114.0 },

  // ---- Eastern Canada ----
  { id: "nunavut", name: "Nunavut", region: "canada_east", borders: ["northwest_territories", "saskatchewan", "ontario", "quebec"], lat: 66.0, lon: -92.0 },
  { id: "saskatchewan", name: "Saskatchewan", region: "canada_east", borders: ["alberta", "nunavut", "ontario", "dakotas"], lat: 52.9, lon: -106.0 },
  { id: "ontario", name: "Ontario", region: "canada_east", borders: ["saskatchewan", "nunavut", "quebec", "great_lakes_us"], lat: 50.0, lon: -85.0 },
  { id: "quebec", name: "Quebec", region: "canada_east", borders: ["ontario", "nunavut", "maritimes", "new_england"], lat: 52.0, lon: -71.0 },
  { id: "maritimes", name: "The Maritimes", region: "canada_east", borders: ["quebec", "new_england"], lat: 46.0, lon: -64.0 },
  { id: "greenland", name: "Greenland", region: "canada_east", borders: [], lat: 71.7, lon: -42.6 },

  // ---- The American West ----
  { id: "cascadia", name: "Cascadia", region: "usa_west", borders: ["british_columbia", "california", "great_basin", "rockies"], lat: 45.5, lon: -121.0 },
  { id: "california", name: "California", region: "usa_west", borders: ["cascadia", "great_basin", "southwest", "baja"], lat: 36.8, lon: -119.4 },
  { id: "great_basin", name: "The Great Basin", region: "usa_west", borders: ["cascadia", "california", "southwest", "rockies"], lat: 39.5, lon: -116.5 },
  { id: "southwest", name: "The Southwest", region: "usa_west", borders: ["california", "great_basin", "rockies", "texas", "sonora"], lat: 34.0, lon: -110.0 },
  { id: "rockies", name: "The Rockies", region: "usa_west", borders: ["cascadia", "great_basin", "southwest", "alberta", "dakotas", "nebraska", "texas"], lat: 43.0, lon: -108.5 },

  // ---- The American Plains ----
  { id: "dakotas", name: "The Dakotas", region: "usa_central", borders: ["saskatchewan", "rockies", "nebraska", "great_lakes_us"], lat: 45.0, lon: -100.0 },
  { id: "nebraska", name: "Nebraska", region: "usa_central", borders: ["dakotas", "rockies", "missouri", "texas"], lat: 41.5, lon: -99.9 },
  { id: "missouri", name: "Missouri", region: "usa_central", borders: ["nebraska", "great_lakes_us", "texas", "appalachia"], lat: 38.5, lon: -92.5 },
  { id: "texas", name: "Texas", region: "usa_central", borders: ["southwest", "rockies", "nebraska", "missouri", "carolinas", "sonora", "central_mexico"], lat: 31.5, lon: -99.3 },
  { id: "great_lakes_us", name: "The Great Lakes", region: "usa_central", borders: ["ontario", "dakotas", "missouri", "appalachia", "mid_atlantic"], lat: 43.5, lon: -85.5 },

  // ---- The American East ----
  { id: "new_england", name: "New England", region: "usa_east", borders: ["quebec", "maritimes", "mid_atlantic"], lat: 43.5, lon: -71.5 },
  { id: "mid_atlantic", name: "The Mid-Atlantic", region: "usa_east", borders: ["new_england", "great_lakes_us", "appalachia"], lat: 40.3, lon: -76.5 },
  { id: "appalachia", name: "Appalachia", region: "usa_east", borders: ["mid_atlantic", "great_lakes_us", "missouri", "carolinas"], lat: 37.5, lon: -81.5 },
  { id: "carolinas", name: "The Carolinas", region: "usa_east", borders: ["appalachia", "texas", "florida"], lat: 34.5, lon: -79.5 },
  { id: "florida", name: "Florida", region: "usa_east", borders: ["carolinas"], lat: 28.5, lon: -82.0 },

  // ---- Mexico ----
  { id: "baja", name: "Baja California", region: "mexico", borders: ["california", "sonora"], lat: 27.5, lon: -113.5 },
  { id: "sonora", name: "Sonora", region: "mexico", borders: ["baja", "southwest", "texas", "central_mexico"], lat: 29.3, lon: -110.3 },
  { id: "central_mexico", name: "Central Mexico", region: "mexico", borders: ["sonora", "texas", "yucatan", "guatemala"], lat: 20.5, lon: -100.5 },
  { id: "yucatan", name: "Yucatan", region: "mexico", borders: ["central_mexico", "guatemala", "honduras"], lat: 19.5, lon: -89.0 },

  // ---- Central America ----
  { id: "guatemala", name: "Guatemala", region: "central_america", borders: ["central_mexico", "yucatan", "honduras"], lat: 15.5, lon: -90.3 },
  { id: "honduras", name: "Honduras", region: "central_america", borders: ["guatemala", "yucatan", "nicaragua"], lat: 14.6, lon: -86.6 },
  { id: "nicaragua", name: "Nicaragua", region: "central_america", borders: ["honduras", "costa_rica"], lat: 12.9, lon: -85.2 },
  { id: "costa_rica", name: "Costa Rica", region: "central_america", borders: ["nicaragua", "panama"], lat: 9.7, lon: -84.0 },
  { id: "panama", name: "Panama", region: "central_america", borders: ["costa_rica", "colombia"], lat: 8.5, lon: -80.1 },

  // ---- The Caribbean ----
  { id: "cuba", name: "Cuba", region: "caribbean", borders: [], lat: 21.5, lon: -79.5 },
  { id: "jamaica", name: "Jamaica", region: "caribbean", borders: [], lat: 18.1, lon: -77.3 },
  { id: "hispaniola", name: "Hispaniola", region: "caribbean", borders: [], lat: 18.9, lon: -70.2 },
  { id: "puerto_rico", name: "Puerto Rico", region: "caribbean", borders: [], lat: 18.2, lon: -66.5 },
  { id: "lesser_antilles", name: "The Lesser Antilles", region: "caribbean", borders: [], lat: 14.5, lon: -61.0 },

  // ---- The Andes ----
  { id: "colombia", name: "Colombia", region: "andes", borders: ["panama", "venezuela", "ecuador", "peru", "amazonas"], lat: 4.6, lon: -74.1 },
  { id: "venezuela", name: "Venezuela", region: "andes", borders: ["colombia", "guyana", "amazonas"], lat: 7.1, lon: -66.0 },
  { id: "ecuador", name: "Ecuador", region: "andes", borders: ["colombia", "peru"], lat: -1.4, lon: -78.4 },
  { id: "peru", name: "Peru", region: "andes", borders: ["colombia", "ecuador", "bolivia", "chile", "amazonas", "mato_grosso"], lat: -9.2, lon: -75.0 },
  { id: "bolivia", name: "Bolivia", region: "andes", borders: ["peru", "chile", "paraguay", "mato_grosso"], lat: -16.3, lon: -64.6 },
  { id: "chile", name: "Chile", region: "andes", borders: ["peru", "bolivia", "pampas", "patagonia"], lat: -30.0, lon: -71.0 },

  // ---- Amazonia ----
  { id: "guyana", name: "Guyana", region: "amazonia", borders: ["venezuela", "suriname", "amazonas", "para"], lat: 5.0, lon: -58.9 },
  { id: "suriname", name: "Suriname", region: "amazonia", borders: ["guyana", "para"], lat: 4.0, lon: -55.9 },
  { id: "amazonas", name: "Amazonas", region: "amazonia", borders: ["colombia", "venezuela", "peru", "guyana", "para", "mato_grosso"], lat: -3.5, lon: -63.0 },
  { id: "para", name: "Para", region: "amazonia", borders: ["amazonas", "guyana", "suriname", "nordeste", "mato_grosso"], lat: -3.8, lon: -52.5 },
  { id: "nordeste", name: "The Nordeste", region: "amazonia", borders: ["para", "bahia", "mato_grosso"], lat: -7.5, lon: -39.5 },

  // ---- Brazil ----
  { id: "bahia", name: "Bahia", region: "brazil", borders: ["nordeste", "minas_gerais", "mato_grosso"], lat: -12.5, lon: -41.7 },
  { id: "minas_gerais", name: "Minas Gerais", region: "brazil", borders: ["bahia", "sao_paulo", "mato_grosso"], lat: -18.5, lon: -44.6 },
  { id: "sao_paulo", name: "Sao Paulo", region: "brazil", borders: ["minas_gerais", "parana", "mato_grosso"], lat: -22.2, lon: -48.6 },
  { id: "parana", name: "Parana", region: "brazil", borders: ["sao_paulo", "mato_grosso", "paraguay", "uruguay"], lat: -25.5, lon: -51.5 },
  { id: "mato_grosso", name: "Mato Grosso", region: "brazil", borders: ["amazonas", "para", "nordeste", "bahia", "minas_gerais", "sao_paulo", "parana", "bolivia", "paraguay", "peru"], lat: -13.5, lon: -56.0 },

  // ---- The Southern Cone ----
  { id: "paraguay", name: "Paraguay", region: "southern_cone", borders: ["bolivia", "mato_grosso", "parana", "pampas"], lat: -23.4, lon: -58.4 },
  { id: "uruguay", name: "Uruguay", region: "southern_cone", borders: ["parana", "pampas"], lat: -32.5, lon: -55.8 },
  { id: "pampas", name: "The Pampas", region: "southern_cone", borders: ["paraguay", "uruguay", "chile", "patagonia"], lat: -35.0, lon: -63.0 },
  { id: "patagonia", name: "Patagonia", region: "southern_cone", borders: ["pampas", "chile"], lat: -45.5, lon: -69.0 },
]

const REGIONS: { id: string; name: string }[] = [
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
  { id: "iberia", name: "Iberia" },
  { id: "british_isles", name: "The British Isles" },
  { id: "gaul", name: "Gaul" },
  { id: "low_countries", name: "The Low Countries" },
  { id: "nordics", name: "The Nordics" },
  { id: "central_europe", name: "Central Europe" },
  { id: "italy", name: "Italy" },
  { id: "balkans", name: "The Balkans" },
  { id: "carpathia", name: "Carpathia" },
  { id: "baltic", name: "The Baltic" },
  { id: "russia_west", name: "Western Russia" },
  { id: "anatolia", name: "Anatolia" },
  { id: "caucasus", name: "The Caucasus" },
  { id: "levant", name: "The Levant" },
  { id: "arabia", name: "Arabia" },
  { id: "persia", name: "Persia" },
  { id: "central_asia", name: "Central Asia" },
  { id: "siberia", name: "Siberia" },
  { id: "steppe", name: "The Steppe" },
  { id: "china", name: "China" },
  { id: "korea_japan", name: "Korea and Japan" },
  { id: "hindu_kush", name: "The Hindu Kush" },
  { id: "india", name: "India" },
  { id: "indochina", name: "Indochina" },
  { id: "insulindia", name: "Insulindia" },
  { id: "australia", name: "Australia" },
  { id: "oceania", name: "Oceania" },
  { id: "canada_west", name: "Western Canada" },
  { id: "canada_east", name: "Eastern Canada" },
  { id: "usa_west", name: "The American West" },
  { id: "usa_central", name: "The American Plains" },
  { id: "usa_east", name: "The American East" },
  { id: "mexico", name: "Mexico" },
  { id: "central_america", name: "Central America" },
  { id: "caribbean", name: "The Caribbean" },
  { id: "andes", name: "The Andes" },
  { id: "amazonia", name: "Amazonia" },
  { id: "brazil", name: "Brazil" },
  { id: "southern_cone", name: "The Southern Cone" },
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
  ["ireland", "wales"], // the Irish Sea
  ["ireland", "scotland"], // the North Channel
  ["england", "normandy"], // the English Channel
  ["england", "flanders"], // the Strait of Dover
  ["scotland", "norway"], // the North Sea crossing
  ["iceland", "norway"], // the Norwegian Sea
  ["sweden", "jutland"], // the Kattegat
  ["sweden", "estonia"], // the Gulf of Finland
  ["sicily", "apulia"], // the Strait of Messina, north around the toe
  ["sicily", "tunisia"], // the Sicilian narrows -- Europe to Africa
  ["andalusia", "morocco"], // the Strait of Gibraltar
  ["cyprus", "anatolia_central"], // the Cilician coast
  ["cyprus", "syria"], // the Levantine crossing
  ["korea_south", "kyushu"], // the Korea Strait
  ["kyushu", "honshu"], // the Kanmon Strait
  ["honshu", "hokkaido"], // the Tsugaru Strait
  ["tamil_nadu", "sri_lanka"], // the Palk Strait
  ["malaya", "sumatra"], // the Strait of Malacca
  ["sumatra", "java"], // the Sunda Strait
  ["java", "borneo"], // the Java Sea
  ["borneo", "sulawesi"], // the Makassar Strait
  ["borneo", "philippines"], // the Sulu Sea
  ["sulawesi", "new_guinea"], // the Banda Sea
  ["new_guinea", "queensland"], // the Torres Strait -- Asia to Australia
  ["new_guinea", "northern_territory"], // the Arafura Sea
  ["new_zealand", "victoria"], // the Tasman Sea
  ["new_caledonia", "queensland"], // the Coral Sea
  ["fiji", "new_caledonia"], // the Koro Sea
  ["new_caledonia", "new_guinea"], // the Coral Sea, north -- keeps Oceania whole
  ["new_zealand", "fiji"], // the South Pacific -- keeps Oceania whole
  ["kamchatka", "alaska"], // the Bering Strait -- Asia to the Americas, as in classic Risk
  ["greenland", "nunavut"], // the Nares Strait
  ["greenland", "iceland"], // the Denmark Strait -- the Americas to Europe
  ["cuba", "florida"], // the Straits of Florida
  ["cuba", "yucatan"], // the Yucatan Channel
  ["cuba", "jamaica"], // the Cayman Trench
  ["cuba", "hispaniola"], // the Windward Passage
  ["hispaniola", "puerto_rico"], // the Mona Passage
  ["puerto_rico", "lesser_antilles"], // the Anegada Passage
  ["lesser_antilles", "venezuela"], // the Gulf of Paria -- the Caribbean to South America
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

export const WORLD: GameMap = build([...AFRICA, ...EUROPE, ...ASIA, ...AMERICAS], REGIONS)

/** Every territory's approximate centroid, for `src/map/coords.ts`. */
export const SPECS: readonly Spec[] = [...AFRICA, ...EUROPE, ...ASIA, ...AMERICAS]
