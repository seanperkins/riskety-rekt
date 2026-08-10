import { SLATE_MAX } from "../config.js"
import type { Candidate } from "../adapters/types.js"
import type { Market } from "../engine/index.js"

/**
 * Pick the day's slate.
 *
 * Two rules beyond "take the best":
 *
 * At most one market per series. A same-day Kalshi window is dominated by
 * strike ladders -- one observed window held 2,257 eligible markets across only
 * 44 distinct series -- so ranking by volume alone publishes five rungs of one
 * crypto ladder, which is five wagers on a single number.
 *
 * Rank by volume, store by id. The spec asks for a deterministic order, and id
 * order gives that for the persisted slate; but picking the alphabetically
 * first markets would hand players the same series every single day. Volume
 * decides what is chosen, id decides how it is written down.
 */
export function selectSlate(candidates: Candidate[], max: number = SLATE_MAX): Market[] {
  const ranked = [...candidates].sort((a, b) => {
    if (b.volume !== a.volume) return b.volume - a.volume
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const seen = new Set<string>()
  const picked: Candidate[] = []
  for (const c of ranked) {
    if (picked.length >= max) break
    if (seen.has(c.series)) continue
    seen.add(c.series)
    picked.push(c)
  }

  return picked
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, question, priceYes, priceNo, closeTime }) => ({
      id,
      question,
      priceYes,
      priceNo,
      closeTime,
    }))
}
