import { DISPLAY_NAME_MAX_CHARS } from "../config.js"
import { normalizeDisplayName } from "../roster.js"
import type { RosterStore } from "../store/types.js"
import { RECAP_NAME_MAX_CHARS } from "./config.js"
import { safeText } from "./text.js"

export interface NamePayload {
  userId: string
  /** Everything after the command, exactly as Slack sent it. */
  text: string
}

/**
 * The `/name` slash command.
 *
 * Pure in the same sense as `handleLoginCommand`: no Bolt, no network client,
 * no clock. Synchronous, because unlike joining it needs nothing from Slack —
 * the player supplied the name and the roster already knows who they are.
 *
 * **No season gate.** Joining is gated on the board not having been dealt;
 * renaming is not, and deliberately so. Every display site resolves the name
 * from the roster at render time, so a change lands on the board, the standings
 * and tonight's recap immediately — including replays of days already played,
 * which re-render from the current roster.
 *
 * The faction id never moves. It is written into every saved state and every
 * log line, so following the name would detach a player from their own history.
 */
export function handleNameCommand(
  payload: NamePayload,
  deps: { store: RosterStore; log?: (msg: string) => void },
): string {
  const log = deps.log ?? (() => {})
  const factionId = deps.store.factionForSlackUser(payload.userId)
  if (factionId === undefined) {
    return "You're not on the roster, so there's no name to change. Run `/login` first."
  }

  const parsed = normalizeDisplayName(payload.text)
  if (!parsed.ok) {
    if (parsed.reason === "empty") {
      return "Usage: `/name Your Name` — tell me what to call you."
    }
    return `That name is too long. ${DISPLAY_NAME_MAX_CHARS} characters is the limit.`
  }

  // Same faction id, new name. `addRosterMember` upserts on the Slack user id,
  // so this is the whole write.
  deps.store.addRosterMember({
    slackUserId: payload.userId,
    factionId,
    displayName: parsed.name,
  })
  log(`name: ${factionId} is now "${parsed.name}"`)

  // safeText on the way OUT, not on the way in. The stored name is the one the
  // player chose; this is the Slack payload's own escaping, and it is what stops
  // a name rendering as a live channel ping in the confirmation.
  return `Done — you're **${safeText(parsed.name, RECAP_NAME_MAX_CHARS)}** from now on.`
}
