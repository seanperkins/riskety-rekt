import type { GameMap } from "./types.js"

export const RISK_MAP: GameMap = {
  continents: [
    { id: "na", name: "North America", bonus: 5 },
    { id: "sa", name: "South America", bonus: 2 },
    { id: "eu", name: "Europe", bonus: 5 },
    { id: "af", name: "Africa", bonus: 3 },
    { id: "as", name: "Asia", bonus: 7 },
    { id: "au", name: "Australia", bonus: 2 },
  ],
  territories: [
    // North America
    { id: "alaska", name: "Alaska", continent: "na", neighbors: ["northwest_territory", "alberta", "kamchatka"] },
    { id: "northwest_territory", name: "Northwest Territory", continent: "na", neighbors: ["alaska", "alberta", "ontario", "greenland"] },
    { id: "alberta", name: "Alberta", continent: "na", neighbors: ["alaska", "northwest_territory", "ontario", "western_united_states"] },
    { id: "ontario", name: "Ontario", continent: "na", neighbors: ["northwest_territory", "alberta", "western_united_states", "eastern_united_states", "quebec", "greenland"] },
    { id: "quebec", name: "Quebec", continent: "na", neighbors: ["ontario", "eastern_united_states", "greenland"] },
    { id: "western_united_states", name: "Western United States", continent: "na", neighbors: ["alberta", "ontario", "eastern_united_states", "central_america"] },
    { id: "eastern_united_states", name: "Eastern United States", continent: "na", neighbors: ["western_united_states", "ontario", "quebec", "central_america"] },
    { id: "central_america", name: "Central America", continent: "na", neighbors: ["western_united_states", "eastern_united_states", "venezuela"] },
    { id: "greenland", name: "Greenland", continent: "na", neighbors: ["northwest_territory", "ontario", "quebec", "iceland"] },

    // South America
    { id: "venezuela", name: "Venezuela", continent: "sa", neighbors: ["central_america", "peru", "brazil"] },
    { id: "peru", name: "Peru", continent: "sa", neighbors: ["venezuela", "brazil", "argentina"] },
    { id: "brazil", name: "Brazil", continent: "sa", neighbors: ["venezuela", "peru", "argentina", "north_africa"] },
    { id: "argentina", name: "Argentina", continent: "sa", neighbors: ["peru", "brazil"] },

    // Europe
    { id: "iceland", name: "Iceland", continent: "eu", neighbors: ["greenland", "great_britain", "scandinavia"] },
    { id: "scandinavia", name: "Scandinavia", continent: "eu", neighbors: ["iceland", "great_britain", "northern_europe", "ukraine"] },
    { id: "ukraine", name: "Ukraine", continent: "eu", neighbors: ["scandinavia", "northern_europe", "southern_europe", "ural", "afghanistan", "middle_east"] },
    { id: "great_britain", name: "Great Britain", continent: "eu", neighbors: ["iceland", "scandinavia", "northern_europe", "western_europe"] },
    { id: "northern_europe", name: "Northern Europe", continent: "eu", neighbors: ["great_britain", "scandinavia", "ukraine", "southern_europe", "western_europe"] },
    { id: "western_europe", name: "Western Europe", continent: "eu", neighbors: ["great_britain", "northern_europe", "southern_europe", "north_africa"] },
    { id: "southern_europe", name: "Southern Europe", continent: "eu", neighbors: ["western_europe", "northern_europe", "ukraine", "middle_east", "egypt", "north_africa"] },

    // Africa
    { id: "north_africa", name: "North Africa", continent: "af", neighbors: ["brazil", "western_europe", "southern_europe", "egypt", "east_africa", "congo"] },
    { id: "egypt", name: "Egypt", continent: "af", neighbors: ["north_africa", "southern_europe", "middle_east", "east_africa"] },
    { id: "congo", name: "Congo", continent: "af", neighbors: ["north_africa", "east_africa", "south_africa"] },
    { id: "east_africa", name: "East Africa", continent: "af", neighbors: ["north_africa", "egypt", "middle_east", "congo", "south_africa", "madagascar"] },
    { id: "south_africa", name: "South Africa", continent: "af", neighbors: ["congo", "east_africa", "madagascar"] },
    { id: "madagascar", name: "Madagascar", continent: "af", neighbors: ["east_africa", "south_africa"] },

    // Asia
    { id: "middle_east", name: "Middle East", continent: "as", neighbors: ["ukraine", "southern_europe", "egypt", "east_africa", "afghanistan", "india"] },
    { id: "afghanistan", name: "Afghanistan", continent: "as", neighbors: ["ukraine", "ural", "china", "india", "middle_east"] },
    { id: "ural", name: "Ural", continent: "as", neighbors: ["ukraine", "siberia", "china", "afghanistan"] },
    { id: "siberia", name: "Siberia", continent: "as", neighbors: ["ural", "yakutsk", "irkutsk", "mongolia", "china"] },
    { id: "yakutsk", name: "Yakutsk", continent: "as", neighbors: ["siberia", "irkutsk", "kamchatka"] },
    { id: "irkutsk", name: "Irkutsk", continent: "as", neighbors: ["siberia", "yakutsk", "kamchatka", "mongolia"] },
    { id: "kamchatka", name: "Kamchatka", continent: "as", neighbors: ["yakutsk", "irkutsk", "mongolia", "japan", "alaska"] },
    { id: "mongolia", name: "Mongolia", continent: "as", neighbors: ["siberia", "irkutsk", "kamchatka", "japan", "china"] },
    { id: "japan", name: "Japan", continent: "as", neighbors: ["kamchatka", "mongolia"] },
    { id: "china", name: "China", continent: "as", neighbors: ["siberia", "ural", "afghanistan", "india", "siam", "mongolia"] },
    { id: "india", name: "India", continent: "as", neighbors: ["middle_east", "afghanistan", "china", "siam"] },
    { id: "siam", name: "Siam", continent: "as", neighbors: ["india", "china", "indonesia"] },

    // Australia
    { id: "indonesia", name: "Indonesia", continent: "au", neighbors: ["siam", "new_guinea", "western_australia"] },
    { id: "new_guinea", name: "New Guinea", continent: "au", neighbors: ["indonesia", "western_australia", "eastern_australia"] },
    { id: "western_australia", name: "Western Australia", continent: "au", neighbors: ["indonesia", "new_guinea", "eastern_australia"] },
    { id: "eastern_australia", name: "Eastern Australia", continent: "au", neighbors: ["new_guinea", "western_australia"] },
  ],
}
