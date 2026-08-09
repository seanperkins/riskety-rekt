import type { FactionId } from "./types.js"

export interface Force {
  factionId: FactionId
  size: number
}

/**
 * Split a defender's strength across the attacking forces.
 *
 * Total casualties equal EXACTLY the defense value. Applying the full defense
 * against each attacker independently would let a 4-troop garrison destroy 8
 * troops, breaking troop conservation.
 *
 * Pro-rata by force size, with largest-remainder rounding so the parts sum to
 * the whole. Remainder ties break on the lower faction id, which keeps the
 * result deterministic for golden-file replay.
 */
export function allocateCasualties(forces: Force[], defense: number): Map<FactionId, number> {
  const total = forces.reduce((s, f) => s + f.size, 0)
  if (total <= defense) return new Map(forces.map((f) => [f.factionId, f.size]))

  const rows = forces.map((f) => {
    const exact = (defense * f.size) / total
    const base = Math.floor(exact)
    return { factionId: f.factionId, base, rem: exact - base }
  })

  const out = new Map(rows.map((r) => [r.factionId, r.base]))
  const short = defense - rows.reduce((s, r) => s + r.base, 0)

  const order = [...rows].sort(
    (a, b) => b.rem - a.rem || (a.factionId < b.factionId ? -1 : a.factionId > b.factionId ? 1 : 0),
  )
  for (let i = 0; i < short; i++) {
    const id = order[i]!.factionId
    out.set(id, out.get(id)! + 1)
  }

  return out
}
