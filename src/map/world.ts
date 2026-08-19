import type { GameMap } from "../engine/index.js"
import { LAND_BORDERS } from "./adjacency.js"

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
 * - **Every land border is DERIVED from the drawn shapes**, in
 *   `src/map/adjacency.ts`; the sea links at the bottom of this file are the
 *   only adjacency authored by hand, and each carries a named strait.
 *
 * `bonus` is ALWAYS 0 here. It is computed per sub-map by `selectSubMap`,
 * because a region's defensibility depends on which of its neighbours were
 * selected — Northern Africa with Southern Europe and Western Asia on the board
 * has three ways in; on a board with neither it is a fortress. A non-zero value
 * here would be silently overwritten and would mislead anyone reading this file.
 *
 * Adjacency used to be hand-authored here, beside generated geometry, and the
 * two drifted: 77 pairs were drawn touching but unreachable, 39 reachable with
 * no shared edge. The worst was `gauteng`, whose drawn polygon absorbed North
 * West province, visibly bordered Botswana and could not attack it — a player
 * asked why in the channel. `npm run build:shapes` now emits both from one
 * topology, so the picture and the rules cannot disagree again.
 */

interface Spec {
  id: string
  name: string
  region: string
  /**
   * Land borders come from `LAND_BORDERS`, keyed by this id. What is authored
   * here is which territories EXIST, how they group into regions, and where
   * their labels sit.
   */
  lat: number
  lon: number
}

const AFRICA: Spec[] = [
  // ---- The Maghreb ----
  { id: "morocco", name: "Morocco", region: "maghreb", lat: 31.8, lon: -7.1 },
  { id: "western_sahara", name: "Western Sahara", region: "maghreb", lat: 24.2, lon: -13.0 },
  { id: "algeria", name: "Algeria", region: "maghreb", lat: 28.0, lon: 2.6 },
  { id: "tunisia", name: "Tunisia", region: "maghreb", lat: 34.0, lon: 9.6 },
  { id: "libya", name: "Libya", region: "maghreb", lat: 26.3, lon: 17.2 },

  // ---- The Nile ----
  { id: "egypt", name: "Egypt", region: "nile", lat: 26.8, lon: 30.8 },
  { id: "sudan", name: "Sudan", region: "nile", lat: 15.6, lon: 30.2 },
  { id: "south_sudan", name: "South Sudan", region: "nile", lat: 7.3, lon: 30.3 },
  { id: "ethiopia", name: "Ethiopia", region: "nile", lat: 9.1, lon: 40.5 },
  { id: "eritrea", name: "Eritrea", region: "nile", lat: 15.2, lon: 39.0 },

  // ---- The Sahel ----
  { id: "mauritania", name: "Mauritania", region: "sahel", lat: 20.3, lon: -10.9 },
  { id: "mali", name: "Mali", region: "sahel", lat: 17.6, lon: -4.0 },
  { id: "niger", name: "Niger", region: "sahel", lat: 17.6, lon: 8.1 },
  { id: "chad", name: "Chad", region: "sahel", lat: 15.5, lon: 18.7 },
  { id: "burkina_faso", name: "Burkina Faso", region: "sahel", lat: 12.2, lon: -1.6 },

  // ---- The Guinea Coast ----
  { id: "senegal", name: "Senegal", region: "guinea_coast", lat: 14.5, lon: -14.5 },
  { id: "guinea", name: "Guinea", region: "guinea_coast", lat: 9.9, lon: -11.3 },
  { id: "sierra_leone", name: "Sierra Leone", region: "guinea_coast", lat: 8.5, lon: -11.8 },
  { id: "liberia", name: "Liberia", region: "guinea_coast", lat: 6.4, lon: -9.4 },
  { id: "ivory_coast", name: "Ivory Coast", region: "guinea_coast", lat: 7.5, lon: -5.5 },
  { id: "ghana", name: "Ghana", region: "guinea_coast", lat: 7.9, lon: -1.0 },

  // ---- The Niger Delta ----
  { id: "togo", name: "Togo", region: "niger_delta", lat: 8.6, lon: 0.8 },
  { id: "benin", name: "Benin", region: "niger_delta", lat: 9.3, lon: 2.3 },
  { id: "nigeria", name: "Nigeria", region: "niger_delta", lat: 9.1, lon: 8.7 },
  { id: "cameroon", name: "Cameroon", region: "niger_delta", lat: 7.4, lon: 12.4 },

  // ---- The Horn ----
  { id: "djibouti", name: "Djibouti", region: "horn", lat: 11.8, lon: 42.6 },
  { id: "somalia", name: "Somalia", region: "horn", lat: 5.2, lon: 46.2 },
  { id: "kenya", name: "Kenya", region: "horn", lat: 0.0, lon: 37.9 },
  { id: "uganda", name: "Uganda", region: "horn", lat: 1.4, lon: 32.3 },

  // ---- The Congo Basin ----
  { id: "central_african_republic", name: "Central African Republic", region: "congo_basin", lat: 6.6, lon: 20.9 },
  { id: "dr_congo", name: "DR Congo", region: "congo_basin", lat: -4.0, lon: 21.8 },
  { id: "congo", name: "Congo", region: "congo_basin", lat: -0.2, lon: 15.8 },
  { id: "gabon", name: "Gabon", region: "congo_basin", lat: -0.8, lon: 11.6 },
  { id: "equatorial_guinea", name: "Equatorial Guinea", region: "congo_basin", lat: 1.6, lon: 10.3 },
  { id: "angola", name: "Angola", region: "congo_basin", lat: -11.2, lon: 17.9 },

  // ---- The Great Lakes ----
  { id: "rwanda", name: "Rwanda", region: "great_lakes", lat: -1.9, lon: 29.9 },
  { id: "burundi", name: "Burundi", region: "great_lakes", lat: -3.4, lon: 29.9 },
  { id: "tanzania", name: "Tanzania", region: "great_lakes", lat: -6.4, lon: 34.9 },
  { id: "zambia", name: "Zambia", region: "great_lakes", lat: -13.1, lon: 27.8 },
  { id: "malawi", name: "Malawi", region: "great_lakes", lat: -13.3, lon: 34.3 },

  // ---- The Zambezi ----
  { id: "namibia", name: "Namibia", region: "zambezi", lat: -22.6, lon: 17.1 },
  { id: "botswana", name: "Botswana", region: "zambezi", lat: -22.3, lon: 24.7 },
  { id: "zimbabwe", name: "Zimbabwe", region: "zambezi", lat: -19.0, lon: 29.2 },
  { id: "mozambique", name: "Mozambique", region: "zambezi", lat: -18.7, lon: 35.5 },
  { id: "madagascar", name: "Madagascar", region: "zambezi", lat: -18.8, lon: 46.9 },

  // ---- The Cape ----
  // South Africa is split into provinces the way classic Risk splits the United
  // States. As one territory it left this region at three, below the floor.
  { id: "limpopo", name: "Limpopo", region: "cape", lat: -23.4, lon: 29.5 },
  { id: "gauteng", name: "Gauteng", region: "cape", lat: -26.3, lon: 28.1 },
  { id: "northern_cape", name: "Northern Cape", region: "cape", lat: -29.0, lon: 21.9 },
  { id: "western_cape", name: "Western Cape", region: "cape", lat: -33.2, lon: 21.9 },
  { id: "eastern_cape", name: "Eastern Cape", region: "cape", lat: -32.3, lon: 26.4 },
  { id: "kwazulu_natal", name: "KwaZulu-Natal", region: "cape", lat: -28.5, lon: 30.9 },
  { id: "lesotho", name: "Lesotho", region: "cape", lat: -29.6, lon: 28.2 },
  { id: "eswatini", name: "Eswatini", region: "cape", lat: -26.5, lon: 31.5 },
]

const EUROPE: Spec[] = [
  // ---- Iberia ----
  { id: "portugal", name: "Portugal", region: "iberia", lat: 39.6, lon: -8.0 },
  { id: "galicia", name: "Galicia", region: "iberia", lat: 42.8, lon: -8.0 },
  { id: "castile", name: "Castile", region: "iberia", lat: 41.0, lon: -4.0 },
  { id: "catalonia", name: "Catalonia", region: "iberia", lat: 41.8, lon: 1.5 },
  { id: "andalusia", name: "Andalusia", region: "iberia", lat: 37.4, lon: -4.8 },

  // ---- The British Isles ----
  { id: "ireland", name: "Ireland", region: "british_isles", lat: 53.3, lon: -8.0 },
  { id: "scotland", name: "Scotland", region: "british_isles", lat: 56.8, lon: -4.2 },
  { id: "wales", name: "Wales", region: "british_isles", lat: 52.3, lon: -3.8 },
  { id: "england", name: "England", region: "british_isles", lat: 52.5, lon: -1.2 },

  // ---- Gaul ----
  { id: "brittany", name: "Brittany", region: "gaul", lat: 48.1, lon: -2.9 },
  { id: "normandy", name: "Normandy", region: "gaul", lat: 49.2, lon: 0.2 },
  { id: "aquitaine", name: "Aquitaine", region: "gaul", lat: 44.8, lon: -0.6 },
  { id: "burgundy", name: "Burgundy", region: "gaul", lat: 47.1, lon: 4.6 },
  { id: "provence", name: "Provence", region: "gaul", lat: 43.9, lon: 5.9 },
  { id: "alsace", name: "Alsace", region: "gaul", lat: 48.3, lon: 7.4 },

  // ---- The Low Countries ----
  { id: "flanders", name: "Flanders", region: "low_countries", lat: 50.8, lon: 4.1 },
  { id: "holland", name: "Holland", region: "low_countries", lat: 52.2, lon: 5.3 },
  { id: "rhineland", name: "Rhineland", region: "low_countries", lat: 50.3, lon: 7.3 },
  { id: "westphalia", name: "Westphalia", region: "low_countries", lat: 52.0, lon: 8.6 },

  // ---- The Nordics ----
  { id: "iceland", name: "Iceland", region: "nordics", lat: 64.9, lon: -19.0 },
  { id: "norway", name: "Norway", region: "nordics", lat: 61.0, lon: 8.5 },
  { id: "sweden", name: "Sweden", region: "nordics", lat: 60.1, lon: 15.0 },
  { id: "finland", name: "Finland", region: "nordics", lat: 63.5, lon: 26.0 },
  { id: "jutland", name: "Jutland", region: "nordics", lat: 56.2, lon: 9.5 },

  // ---- Central Europe ----
  { id: "saxony", name: "Saxony", region: "central_europe", lat: 51.9, lon: 12.5 },
  { id: "bavaria", name: "Bavaria", region: "central_europe", lat: 48.8, lon: 11.4 },
  { id: "bohemia", name: "Bohemia", region: "central_europe", lat: 49.8, lon: 15.0 },
  { id: "slovakia", name: "Slovakia", region: "central_europe", lat: 48.7, lon: 19.5 },
  { id: "austria", name: "Austria", region: "central_europe", lat: 47.6, lon: 14.6 },
  { id: "switzerland", name: "Switzerland", region: "central_europe", lat: 46.8, lon: 8.2 },

  // ---- Italy ----
  { id: "piedmont", name: "Piedmont", region: "italy", lat: 45.1, lon: 7.9 },
  { id: "tyrol", name: "Tyrol", region: "italy", lat: 46.6, lon: 11.4 },
  { id: "lombardy", name: "Lombardy", region: "italy", lat: 45.5, lon: 9.7 },
  { id: "veneto", name: "Veneto", region: "italy", lat: 45.6, lon: 12.0 },
  { id: "tuscany", name: "Tuscany", region: "italy", lat: 43.5, lon: 11.2 },
  { id: "lazio", name: "Lazio", region: "italy", lat: 41.9, lon: 12.7 },
  { id: "campania", name: "Campania", region: "italy", lat: 40.8, lon: 14.8 },
  { id: "apulia", name: "Apulia", region: "italy", lat: 41.0, lon: 16.6 },
  { id: "sicily", name: "Sicily", region: "italy", lat: 37.6, lon: 14.0 },

  // ---- The Balkans ----
  { id: "slovenia", name: "Slovenia", region: "balkans", lat: 46.1, lon: 14.8 },
  { id: "croatia", name: "Croatia", region: "balkans", lat: 45.3, lon: 16.3 },
  { id: "bosnia", name: "Bosnia", region: "balkans", lat: 44.0, lon: 17.9 },
  { id: "serbia", name: "Serbia", region: "balkans", lat: 44.0, lon: 20.9 },
  { id: "montenegro", name: "Montenegro", region: "balkans", lat: 42.7, lon: 19.4 },
  { id: "albania", name: "Albania", region: "balkans", lat: 41.2, lon: 20.1 },
  { id: "macedonia", name: "Macedonia", region: "balkans", lat: 41.6, lon: 21.7 },
  { id: "greece", name: "Greece", region: "balkans", lat: 39.3, lon: 22.3 },

  // ---- Carpathia ----
  { id: "hungary", name: "Hungary", region: "carpathia", lat: 47.1, lon: 19.4 },
  { id: "poland", name: "Poland", region: "carpathia", lat: 52.1, lon: 19.4 },
  { id: "romania", name: "Romania", region: "carpathia", lat: 45.9, lon: 25.0 },
  { id: "moldova", name: "Moldova", region: "carpathia", lat: 47.2, lon: 28.5 },
  { id: "bulgaria", name: "Bulgaria", region: "carpathia", lat: 42.7, lon: 25.5 },
  { id: "ukraine_west", name: "Western Ukraine", region: "carpathia", lat: 49.5, lon: 27.0 },

  // ---- The Baltic ----
  { id: "kaliningrad", name: "Kaliningrad", region: "baltic", lat: 54.7, lon: 21.0 },
  { id: "lithuania", name: "Lithuania", region: "baltic", lat: 55.2, lon: 23.9 },
  { id: "latvia", name: "Latvia", region: "baltic", lat: 56.9, lon: 24.9 },
  { id: "estonia", name: "Estonia", region: "baltic", lat: 58.6, lon: 25.0 },
  { id: "belarus", name: "Belarus", region: "baltic", lat: 53.7, lon: 27.9 },

  // ---- Western Russia ----
  { id: "karelia", name: "Karelia", region: "russia_west", lat: 63.0, lon: 33.0 },
  { id: "novgorod", name: "Novgorod", region: "russia_west", lat: 58.5, lon: 31.3 },
  { id: "moscow", name: "Moscow", region: "russia_west", lat: 55.8, lon: 37.6 },
  { id: "ukraine_east", name: "Eastern Ukraine", region: "russia_west", lat: 48.5, lon: 37.0 },
  { id: "don", name: "The Don", region: "russia_west", lat: 47.5, lon: 42.0 },
  { id: "volga", name: "The Volga", region: "russia_west", lat: 52.0, lon: 46.0 },
  { id: "ural_west", name: "Western Urals", region: "russia_west", lat: 57.0, lon: 57.0 },

  // ---- Anatolia ----
  { id: "thrace", name: "Thrace", region: "anatolia", lat: 41.2, lon: 27.0 },
  { id: "anatolia_west", name: "Western Anatolia", region: "anatolia", lat: 38.9, lon: 28.5 },
  { id: "anatolia_central", name: "Central Anatolia", region: "anatolia", lat: 39.0, lon: 33.5 },
  { id: "anatolia_east", name: "Eastern Anatolia", region: "anatolia", lat: 39.4, lon: 41.0 },
  { id: "cyprus", name: "Cyprus", region: "anatolia", lat: 35.1, lon: 33.4 },

  // ---- The Caucasus ----
  { id: "georgia", name: "Georgia", region: "caucasus", lat: 42.3, lon: 43.4 },
  { id: "armenia", name: "Armenia", region: "caucasus", lat: 40.1, lon: 45.0 },
  { id: "azerbaijan", name: "Azerbaijan", region: "caucasus", lat: 40.3, lon: 47.9 },
  { id: "caucasus", name: "The Caucasus", region: "caucasus", lat: 43.5, lon: 44.5 },

  // ---- The Levant ----
  { id: "syria", name: "Syria", region: "levant", lat: 35.0, lon: 38.5 },
  { id: "lebanon", name: "Lebanon", region: "levant", lat: 33.9, lon: 35.9 },
  { id: "israel", name: "Israel", region: "levant", lat: 31.5, lon: 35.0 },
  { id: "jordan", name: "Jordan", region: "levant", lat: 31.3, lon: 36.6 },
  { id: "iraq", name: "Iraq", region: "levant", lat: 33.2, lon: 43.7 },
  { id: "sinai", name: "Sinai", region: "levant", lat: 29.5, lon: 33.8 },

  // ---- Arabia ----
  { id: "hejaz", name: "Hejaz", region: "arabia", lat: 22.0, lon: 40.0 },
  { id: "najd", name: "Najd", region: "arabia", lat: 24.5, lon: 45.5 },
  { id: "kuwait", name: "Kuwait", region: "arabia", lat: 29.3, lon: 47.6 },
  { id: "gulf_states", name: "The Gulf States", region: "arabia", lat: 24.3, lon: 52.5 },
  { id: "oman", name: "Oman", region: "arabia", lat: 21.0, lon: 56.5 },
  { id: "yemen", name: "Yemen", region: "arabia", lat: 15.5, lon: 47.6 },
]

const ASIA: Spec[] = [
  // ---- Persia ----
  { id: "iran_north", name: "Northern Iran", region: "persia", lat: 36.2, lon: 49.5 },
  { id: "iran_south", name: "Southern Iran", region: "persia", lat: 29.5, lon: 52.5 },
  { id: "iran_east", name: "Eastern Iran", region: "persia", lat: 32.5, lon: 57.5 },
  { id: "khorasan", name: "Khorasan", region: "persia", lat: 35.5, lon: 59.5 },
  { id: "baluchistan", name: "Baluchistan", region: "persia", lat: 28.0, lon: 62.5 },

  // ---- Central Asia ----
  { id: "kazakhstan", name: "Kazakhstan", region: "central_asia", lat: 48.0, lon: 67.0 },
  { id: "uzbekistan", name: "Uzbekistan", region: "central_asia", lat: 41.4, lon: 64.6 },
  { id: "turkmenistan", name: "Turkmenistan", region: "central_asia", lat: 38.9, lon: 59.6 },
  { id: "tajikistan", name: "Tajikistan", region: "central_asia", lat: 38.9, lon: 71.3 },
  { id: "kyrgyzstan", name: "Kyrgyzstan", region: "central_asia", lat: 41.2, lon: 74.8 },

  // ---- Siberia ----
  { id: "ural_east", name: "Eastern Urals", region: "siberia", lat: 58.0, lon: 63.0 },
  { id: "west_siberia", name: "Western Siberia", region: "siberia", lat: 58.0, lon: 80.0 },
  { id: "central_siberia", name: "Central Siberia", region: "siberia", lat: 60.0, lon: 105.0 },
  { id: "yakutia", name: "Yakutia", region: "siberia", lat: 64.0, lon: 128.0 },
  { id: "chukotka", name: "Chukotka", region: "siberia", lat: 66.0, lon: 172.0 },
  { id: "kamchatka", name: "Kamchatka", region: "siberia", lat: 56.0, lon: 159.0 },

  // ---- The Steppe ----
  { id: "mongolia", name: "Mongolia", region: "steppe", lat: 46.9, lon: 103.8 },
  { id: "manchuria", name: "Manchuria", region: "steppe", lat: 45.0, lon: 126.0 },
  { id: "inner_mongolia", name: "Inner Mongolia", region: "steppe", lat: 42.5, lon: 112.0 },
  { id: "xinjiang", name: "Xinjiang", region: "steppe", lat: 41.5, lon: 85.0 },

  // ---- China ----
  { id: "beijing", name: "Beijing", region: "china", lat: 39.9, lon: 116.4 },
  { id: "shandong", name: "Shandong", region: "china", lat: 36.4, lon: 118.1 },
  { id: "shanghai", name: "Shanghai", region: "china", lat: 31.2, lon: 120.5 },
  { id: "sichuan", name: "Sichuan", region: "china", lat: 30.7, lon: 103.9 },
  { id: "guangdong", name: "Guangdong", region: "china", lat: 23.1, lon: 113.3 },
  { id: "yunnan", name: "Yunnan", region: "china", lat: 25.0, lon: 101.5 },
  { id: "tibet", name: "Tibet", region: "china", lat: 31.5, lon: 88.0 },

  // ---- Korea and Japan ----
  { id: "korea_north", name: "North Korea", region: "korea_japan", lat: 40.0, lon: 127.0 },
  { id: "korea_south", name: "South Korea", region: "korea_japan", lat: 36.4, lon: 127.9 },
  { id: "honshu", name: "Honshu", region: "korea_japan", lat: 36.2, lon: 138.3 },
  { id: "hokkaido", name: "Hokkaido", region: "korea_japan", lat: 43.3, lon: 142.8 },
  { id: "kyushu", name: "Kyushu", region: "korea_japan", lat: 32.5, lon: 131.0 },

  // ---- The Hindu Kush ----
  { id: "afghanistan", name: "Afghanistan", region: "hindu_kush", lat: 33.9, lon: 66.0 },
  { id: "pakistan_north", name: "Northern Pakistan", region: "hindu_kush", lat: 33.5, lon: 71.5 },
  { id: "pakistan_south", name: "Sindh", region: "hindu_kush", lat: 26.0, lon: 68.5 },
  { id: "kashmir", name: "Kashmir", region: "hindu_kush", lat: 34.1, lon: 76.5 },
  { id: "punjab", name: "Punjab", region: "hindu_kush", lat: 30.9, lon: 75.9 },

  // ---- India ----
  { id: "rajasthan", name: "Rajasthan", region: "india", lat: 27.0, lon: 74.2 },
  { id: "gangetic_plain", name: "The Gangetic Plain", region: "india", lat: 26.8, lon: 82.0 },
  { id: "nepal", name: "Nepal", region: "india", lat: 28.4, lon: 84.1 },
  { id: "bengal", name: "Bengal", region: "india", lat: 23.7, lon: 89.5 },
  { id: "deccan", name: "The Deccan", region: "india", lat: 18.5, lon: 77.0 },
  { id: "tamil_nadu", name: "Tamil Nadu", region: "india", lat: 11.1, lon: 78.7 },
  { id: "sri_lanka", name: "Sri Lanka", region: "india", lat: 7.9, lon: 80.8 },

  // ---- Indochina ----
  { id: "myanmar", name: "Myanmar", region: "indochina", lat: 21.9, lon: 96.0 },
  { id: "thailand", name: "Thailand", region: "indochina", lat: 15.9, lon: 100.9 },
  { id: "laos", name: "Laos", region: "indochina", lat: 19.9, lon: 102.5 },
  { id: "cambodia", name: "Cambodia", region: "indochina", lat: 12.6, lon: 104.9 },
  { id: "vietnam", name: "Vietnam", region: "indochina", lat: 14.1, lon: 108.3 },

  // ---- Insulindia ----
  { id: "malaya", name: "Malaya", region: "insulindia", lat: 4.2, lon: 102.0 },
  { id: "sumatra", name: "Sumatra", region: "insulindia", lat: -0.6, lon: 101.3 },
  { id: "java", name: "Java", region: "insulindia", lat: -7.3, lon: 110.0 },
  { id: "borneo", name: "Borneo", region: "insulindia", lat: 0.9, lon: 114.0 },
  { id: "sulawesi", name: "Sulawesi", region: "insulindia", lat: -2.0, lon: 120.9 },
  { id: "philippines", name: "The Philippines", region: "insulindia", lat: 12.9, lon: 122.8 },

  // ---- Australia ----
  { id: "western_australia", name: "Western Australia", region: "australia", lat: -25.0, lon: 122.0 },
  { id: "northern_territory", name: "Northern Territory", region: "australia", lat: -19.5, lon: 133.4 },
  { id: "queensland", name: "Queensland", region: "australia", lat: -22.6, lon: 144.3 },
  { id: "south_australia", name: "South Australia", region: "australia", lat: -30.0, lon: 135.8 },
  { id: "new_south_wales", name: "New South Wales", region: "australia", lat: -32.2, lon: 147.0 },
  { id: "victoria", name: "Victoria", region: "australia", lat: -37.0, lon: 144.3 },

  // ---- Oceania ----
  { id: "new_guinea", name: "New Guinea", region: "oceania", lat: -5.7, lon: 141.0 },
  { id: "new_zealand", name: "New Zealand", region: "oceania", lat: -41.5, lon: 172.8 },
  { id: "fiji", name: "Fiji", region: "oceania", lat: -17.7, lon: 178.0 },
  { id: "new_caledonia", name: "New Caledonia", region: "oceania", lat: -21.3, lon: 165.6 },
]

const AMERICAS: Spec[] = [
  // ---- Western Canada ----
  { id: "alaska", name: "Alaska", region: "canada_west", lat: 64.2, lon: -149.5 },
  { id: "yukon", name: "Yukon", region: "canada_west", lat: 64.3, lon: -135.0 },
  { id: "northwest_territories", name: "Northwest Territories", region: "canada_west", lat: 64.8, lon: -119.0 },
  { id: "british_columbia", name: "British Columbia", region: "canada_west", lat: 53.7, lon: -125.0 },
  { id: "alberta", name: "Alberta", region: "canada_west", lat: 53.9, lon: -114.0 },

  // ---- Eastern Canada ----
  { id: "nunavut", name: "Nunavut", region: "canada_east", lat: 66.0, lon: -92.0 },
  { id: "saskatchewan", name: "Saskatchewan", region: "canada_east", lat: 52.9, lon: -106.0 },
  { id: "ontario", name: "Ontario", region: "canada_east", lat: 50.0, lon: -85.0 },
  { id: "quebec", name: "Quebec", region: "canada_east", lat: 52.0, lon: -71.0 },
  { id: "maritimes", name: "The Maritimes", region: "canada_east", lat: 46.0, lon: -64.0 },
  { id: "greenland", name: "Greenland", region: "canada_east", lat: 71.7, lon: -42.6 },

  // ---- The American West ----
  { id: "cascadia", name: "Cascadia", region: "usa_west", lat: 45.5, lon: -121.0 },
  { id: "california", name: "California", region: "usa_west", lat: 36.8, lon: -119.4 },
  { id: "great_basin", name: "The Great Basin", region: "usa_west", lat: 39.5, lon: -116.5 },
  { id: "southwest", name: "The Southwest", region: "usa_west", lat: 34.0, lon: -110.0 },
  { id: "rockies", name: "The Rockies", region: "usa_west", lat: 43.0, lon: -108.5 },

  // ---- The American Plains ----
  { id: "dakotas", name: "The Dakotas", region: "usa_central", lat: 45.0, lon: -100.0 },
  { id: "nebraska", name: "Nebraska", region: "usa_central", lat: 41.5, lon: -99.9 },
  { id: "missouri", name: "Missouri", region: "usa_central", lat: 38.5, lon: -92.5 },
  { id: "texas", name: "Texas", region: "usa_central", lat: 31.5, lon: -99.3 },
  { id: "great_lakes_us", name: "The Great Lakes", region: "usa_central", lat: 43.5, lon: -85.5 },

  // ---- The American East ----
  { id: "new_england", name: "New England", region: "usa_east", lat: 43.5, lon: -71.5 },
  { id: "mid_atlantic", name: "The Mid-Atlantic", region: "usa_east", lat: 40.3, lon: -76.5 },
  { id: "appalachia", name: "Appalachia", region: "usa_east", lat: 37.5, lon: -81.5 },
  { id: "carolinas", name: "The Carolinas", region: "usa_east", lat: 34.5, lon: -79.5 },
  { id: "florida", name: "Florida", region: "usa_east", lat: 28.5, lon: -82.0 },

  // ---- Mexico ----
  { id: "baja", name: "Baja California", region: "mexico", lat: 27.5, lon: -113.5 },
  { id: "sonora", name: "Sonora", region: "mexico", lat: 29.3, lon: -110.3 },
  { id: "central_mexico", name: "Central Mexico", region: "mexico", lat: 20.5, lon: -100.5 },
  { id: "yucatan", name: "Yucatan", region: "mexico", lat: 19.5, lon: -89.0 },

  // ---- Central America ----
  { id: "guatemala", name: "Guatemala", region: "central_america", lat: 15.5, lon: -90.3 },
  { id: "honduras", name: "Honduras", region: "central_america", lat: 14.6, lon: -86.6 },
  { id: "nicaragua", name: "Nicaragua", region: "central_america", lat: 12.9, lon: -85.2 },
  { id: "costa_rica", name: "Costa Rica", region: "central_america", lat: 9.7, lon: -84.0 },
  { id: "panama", name: "Panama", region: "central_america", lat: 8.5, lon: -80.1 },

  // ---- The Caribbean ----
  { id: "cuba", name: "Cuba", region: "caribbean", lat: 21.5, lon: -79.5 },
  { id: "jamaica", name: "Jamaica", region: "caribbean", lat: 18.1, lon: -77.3 },
  { id: "hispaniola", name: "Hispaniola", region: "caribbean", lat: 18.9, lon: -70.2 },
  { id: "puerto_rico", name: "Puerto Rico", region: "caribbean", lat: 18.2, lon: -66.5 },
  { id: "lesser_antilles", name: "The Lesser Antilles", region: "caribbean", lat: 14.5, lon: -61.0 },

  // ---- The Andes ----
  { id: "colombia", name: "Colombia", region: "andes", lat: 4.6, lon: -74.1 },
  { id: "venezuela", name: "Venezuela", region: "andes", lat: 7.1, lon: -66.0 },
  { id: "ecuador", name: "Ecuador", region: "andes", lat: -1.4, lon: -78.4 },
  { id: "peru", name: "Peru", region: "andes", lat: -9.2, lon: -75.0 },
  { id: "bolivia", name: "Bolivia", region: "andes", lat: -16.3, lon: -64.6 },
  { id: "chile", name: "Chile", region: "andes", lat: -30.0, lon: -71.0 },

  // ---- Amazonia ----
  { id: "guyana", name: "Guyana", region: "amazonia", lat: 5.0, lon: -58.9 },
  { id: "suriname", name: "Suriname", region: "amazonia", lat: 4.0, lon: -55.9 },
  { id: "amazonas", name: "Amazonas", region: "amazonia", lat: -3.5, lon: -63.0 },
  { id: "para", name: "Para", region: "amazonia", lat: -3.8, lon: -52.5 },
  { id: "nordeste", name: "The Nordeste", region: "amazonia", lat: -7.5, lon: -39.5 },

  // ---- Brazil ----
  { id: "bahia", name: "Bahia", region: "brazil", lat: -12.5, lon: -41.7 },
  { id: "minas_gerais", name: "Minas Gerais", region: "brazil", lat: -18.5, lon: -44.6 },
  { id: "sao_paulo", name: "Sao Paulo", region: "brazil", lat: -22.2, lon: -48.6 },
  { id: "parana", name: "Parana", region: "brazil", lat: -25.5, lon: -51.5 },
  { id: "mato_grosso", name: "Mato Grosso", region: "brazil", lat: -13.5, lon: -56.0 },

  // ---- The Southern Cone ----
  { id: "paraguay", name: "Paraguay", region: "southern_cone", lat: -23.4, lon: -58.4 },
  { id: "uruguay", name: "Uruguay", region: "southern_cone", lat: -32.5, lon: -55.8 },
  { id: "pampas", name: "The Pampas", region: "southern_cone", lat: -35.0, lon: -63.0 },
  { id: "patagonia", name: "Patagonia", region: "southern_cone", lat: -45.5, lon: -69.0 },
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
export const SEA_LINKS: readonly (readonly [string, string])[] = [
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
  ["gulf_states", "kuwait"], // the Persian Gulf -- not a land border
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

  // Access links. The four above this comment join landmasses; these four exist
  // because a region reachable from only one other region almost never lands on
  // a board -- appearance rate tracks adjacency closely, and Korea and Japan at
  // one neighbour appeared on 10.2% of boards against Central Europe's 49.8% at
  // six. Each is still a real crossing; none of them is invented to patch a
  // number. Measured effect: Guinea Coast 8.1% -> 20.8%, Korea and Japan
  // 10.2% -> 17.9%, at no cost in board span.
  ["kyushu", "shandong"], // the Yellow Sea -- Japan to China
  ["hokkaido", "kamchatka"], // the Kuril chain -- Japan to Siberia
  ["western_australia", "java"], // the Timor Sea -- a second door into Australia
  ["nordeste", "senegal"], // the South Atlantic narrows, the shortest ocean
  //                          crossing there is, mirroring classic Risk's
  //                          brazil <-> north_africa
]

/**
 * Joins the derived land borders to the hand-authored sea links.
 *
 * A spec with no entry in `LAND_BORDERS` is an island as far as the geometry is
 * concerned — it reaches the board through `SEA_LINKS` alone, which is exactly
 * true of Madagascar, Iceland, Japan and the Caribbean.
 */
function build(specs: Spec[], regions: { id: string; name: string }[]): GameMap {
  const known = new Set(specs.map((s) => s.id))
  const borders = new Map(
    // Intersected with the specs, so a territory deleted from this file cannot
    // survive as a neighbour of its neighbours through a stale generated table.
    specs.map((s) => [s.id, (LAND_BORDERS[s.id] ?? []).filter((n) => known.has(n))]),
  )
  // A pair can be BOTH, and it is one border either way. Ceuta gives Andalusia a
  // real land border with Morocco while the Strait of Gibraltar is still listed
  // below; Ireland reaches Northern Ireland by land; several Japanese straits
  // have prefecture boundaries that meet across the water. Pushing blind gave
  // fourteen duplicate-neighbour findings from validateMap.
  for (const [a, b] of SEA_LINKS) {
    const from = borders.get(a)
    const to = borders.get(b)
    if (from !== undefined && !from.includes(b)) from.push(b)
    if (to !== undefined && !to.includes(a)) to.push(a)
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
