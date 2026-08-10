import type { GameState } from "../engine/index.js"
import type { Poster } from "../slack/post.js"
import { renderRecap } from "../slack/recap.js"

export interface PostRecapDeps {
  poster: Poster
  /** The post-tick state, day N. */
  state: GameState
  /** Day N-1, for standings movement. */
  previous: GameState
  lengthDays: number
  /** A rerun. Marked visibly rather than posted as a silent second recap. */
  correction?: boolean
  log?: (msg: string) => void
}

/**
 * Post the day's recap.
 *
 * Deliberately separate from resolution, and never called by `resolve()`. Plan
 * 4's tick runner saves state first and calls this afterwards, so a Slack
 * outage cannot stall or double-run a tick.
 */
export async function runPostRecap(deps: PostRecapDeps): Promise<void> {
  const log = deps.log ?? (() => {})
  // Spread rather than `correction: deps.correction`: exactOptionalPropertyTypes
  // is on, so an explicit `undefined` is not the same as an absent key.
  const message = renderRecap({
    state: deps.state,
    previous: deps.previous,
    lengthDays: deps.lengthDays,
    ...(deps.correction === undefined ? {} : { correction: deps.correction }),
  })
  await deps.poster.post(message)
  log(`recap posted for day ${deps.state.day}`)
}
