import type { GameMap } from "./types.js"

export const RISK_MAP: GameMap = {
  regions: [
    { id: "na", name: "North America", bonus: 5 },
    { id: "sa", name: "South America", bonus: 2 },
    { id: "eu", name: "Europe", bonus: 5 },
    { id: "af", name: "Africa", bonus: 3 },
    { id: "as", name: "Asia", bonus: 7 },
    { id: "au", name: "Australia", bonus: 2 },
  ],
  territories: [
    // North America
    { id: "alaska", name: "Alaska", region: "na", neighbors: ["northwest_territory", "alberta", "kamchatka"] },
    { id: "northwest_territory", name: "Northwest Territory", region: "na", neighbors: ["alaska", "alberta", "ontario", "greenland"] },
    { id: "alberta", name: "Alberta", region: "na", neighbors: ["alaska", "northwest_territory", "ontario", "western_united_states"] },
    { id: "ontario", name: "Ontario", region: "na", neighbors: ["northwest_territory", "alberta", "western_united_states", "eastern_united_states", "quebec", "greenland"] },
    { id: "quebec", name: "Quebec", region: "na", neighbors: ["ontario", "eastern_united_states", "greenland"] },
    { id: "western_united_states", name: "Western United States", region: "na", neighbors: ["alberta", "ontario", "eastern_united_states", "central_america"] },
    { id: "eastern_united_states", name: "Eastern United States", region: "na", neighbors: ["western_united_states", "ontario", "quebec", "central_america"] },
    { id: "central_america", name: "Central America", region: "na", neighbors: ["western_united_states", "eastern_united_states", "venezuela"] },
    { id: "greenland", name: "Greenland", region: "na", neighbors: ["northwest_territory", "ontario", "quebec", "iceland"] },

    // South America
    { id: "venezuela", name: "Venezuela", region: "sa", neighbors: ["central_america", "peru", "brazil"] },
    { id: "peru", name: "Peru", region: "sa", neighbors: ["venezuela", "brazil", "argentina"] },
    { id: "brazil", name: "Brazil", region: "sa", neighbors: ["venezuela", "peru", "argentina", "north_africa"] },
    { id: "argentina", name: "Argentina", region: "sa", neighbors: ["peru", "brazil"] },

    // Europe
    { id: "iceland", name: "Iceland", region: "eu", neighbors: ["greenland", "great_britain", "scandinavia"] },
    { id: "scandinavia", name: "Scandinavia", region: "eu", neighbors: ["iceland", "great_britain", "northern_europe", "ukraine"] },
    { id: "ukraine", name: "Ukraine", region: "eu", neighbors: ["scandinavia", "northern_europe", "southern_europe", "ural", "afghanistan", "middle_east"] },
    { id: "great_britain", name: "Great Britain", region: "eu", neighbors: ["iceland", "scandinavia", "northern_europe", "western_europe"] },
    { id: "northern_europe", name: "Northern Europe", region: "eu", neighbors: ["great_britain", "scandinavia", "ukraine", "southern_europe", "western_europe"] },
    { id: "western_europe", name: "Western Europe", region: "eu", neighbors: ["great_britain", "northern_europe", "southern_europe", "north_africa"] },
    { id: "southern_europe", name: "Southern Europe", region: "eu", neighbors: ["western_europe", "northern_europe", "ukraine", "middle_east", "egypt", "north_africa"] },

    // Africa
    { id: "north_africa", name: "North Africa", region: "af", neighbors: ["brazil", "western_europe", "southern_europe", "egypt", "east_africa", "congo"] },
    { id: "egypt", name: "Egypt", region: "af", neighbors: ["north_africa", "southern_europe", "middle_east", "east_africa"] },
    { id: "congo", name: "Congo", region: "af", neighbors: ["north_africa", "east_africa", "south_africa"] },
    { id: "east_africa", name: "East Africa", region: "af", neighbors: ["north_africa", "egypt", "middle_east", "congo", "south_africa", "madagascar"] },
    { id: "south_africa", name: "South Africa", region: "af", neighbors: ["congo", "east_africa", "madagascar"] },
    { id: "madagascar", name: "Madagascar", region: "af", neighbors: ["east_africa", "south_africa"] },

    // Asia
    { id: "middle_east", name: "Middle East", region: "as", neighbors: ["ukraine", "southern_europe", "egypt", "east_africa", "afghanistan", "india"] },
    { id: "afghanistan", name: "Afghanistan", region: "as", neighbors: ["ukraine", "ural", "china", "india", "middle_east"] },
    { id: "ural", name: "Ural", region: "as", neighbors: ["ukraine", "siberia", "china", "afghanistan"] },
    { id: "siberia", name: "Siberia", region: "as", neighbors: ["ural", "yakutsk", "irkutsk", "mongolia", "china"] },
    { id: "yakutsk", name: "Yakutsk", region: "as", neighbors: ["siberia", "irkutsk", "kamchatka"] },
    { id: "irkutsk", name: "Irkutsk", region: "as", neighbors: ["siberia", "yakutsk", "kamchatka", "mongolia"] },
    { id: "kamchatka", name: "Kamchatka", region: "as", neighbors: ["yakutsk", "irkutsk", "mongolia", "japan", "alaska"] },
    { id: "mongolia", name: "Mongolia", region: "as", neighbors: ["siberia", "irkutsk", "kamchatka", "japan", "china"] },
    { id: "japan", name: "Japan", region: "as", neighbors: ["kamchatka", "mongolia"] },
    { id: "china", name: "China", region: "as", neighbors: ["siberia", "ural", "afghanistan", "india", "siam", "mongolia"] },
    { id: "india", name: "India", region: "as", neighbors: ["middle_east", "afghanistan", "china", "siam"] },
    { id: "siam", name: "Siam", region: "as", neighbors: ["india", "china", "indonesia"] },

    // Australia
    { id: "indonesia", name: "Indonesia", region: "au", neighbors: ["siam", "new_guinea", "western_australia"] },
    { id: "new_guinea", name: "New Guinea", region: "au", neighbors: ["indonesia", "western_australia", "eastern_australia"] },
    { id: "western_australia", name: "Western Australia", region: "au", neighbors: ["indonesia", "new_guinea", "eastern_australia"] },
    { id: "eastern_australia", name: "Eastern Australia", region: "au", neighbors: ["new_guinea", "western_australia"] },
  ],
}
