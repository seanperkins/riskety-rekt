import { cmp } from "../sort.js"
import type { Rule } from "../mechanics.js"

/**
 * The most contested region is closed to attacks for the day.
 *
 * "Most contested" is the count of DISTINCT owners in the region, which is a
 * pure function of ownership and needs no history. Ties break on region id so
 * the choice is deterministic and replayable.
 *
 * No per-territory events — a region is many territories; the recap names the
 * rule.
 */
export const regionalManagerRule: Rule = {
  id: "regional-manager",
  name: "Regional Manager",
  description: "The most contested region is closed to attacks. Middle management has spoken.",
  lock(state) {
    const ownersByRegion = new Map<string, Set<string>>()
    for (const t of state.map.territories) {
      const owner = state.ownership[t.id]
      if (owner === undefined) continue
      const set = ownersByRegion.get(t.region) ?? new Set<string>()
      set.add(owner)
      ownersByRegion.set(t.region, set)
    }
    if (ownersByRegion.size === 0) return []

    const ranked = [...ownersByRegion.entries()].sort(
      (a, b) => b[1].size - a[1].size || cmp(a[0], b[0]),
    )
    const region = ranked[0]![0]
    return state.map.territories
      .filter((t) => t.region === region)
      .map((t) => t.id)
      .sort()
      .map((territory) => ({ territory }))
  },
}
