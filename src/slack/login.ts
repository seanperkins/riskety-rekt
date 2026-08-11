import { MAX_LIVE_TOKENS, hashToken, newToken } from "../auth/token.js"
import type { AuthStore, RosterStore } from "../store/types.js"

/** How long a magic link is good for. Long enough to switch apps, no longer. */
export const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000

export interface LoginDeps {
  store: RosterStore & AuthStore
  /** Origin of the web app, e.g. https://rr.example.com. No trailing slash. */
  webUrl: string
  now: Date
  log?: (msg: string) => void
}

export interface LoginPayload {
  userId: string
  teamId: string
}

/**
 * The `/login` slash command.
 *
 * Pure: no Bolt, no network, no clock. `src/slack/app.ts` adapts Bolt's types
 * and sends the return value — the same split as the event handlers, and the
 * reason Bolt stays out of the test import graph.
 *
 * The return value contains the raw token exactly once, in the link. It is
 * never logged and never stored; only its hash reaches the database.
 */
export function handleLoginCommand(payload: LoginPayload, deps: LoginDeps): string {
  const log = deps.log ?? (() => {})

  const factionId = deps.store.factionForSlackUser(payload.userId)
  if (factionId === undefined) {
    // Not an error -- the normal state of a new player. The reply carries the
    // exact command with their id already in it, so they can paste it to the
    // operator rather than describing the problem.
    //
    // Self-service joining is deliberately not offered: the board is sized to
    // the roster at season-init and dealt round-robin, so a faction added
    // afterwards owns nothing and territoryIncome returns 0 for zero
    // territories, permanently.
    log(`login: ${payload.userId} is not on the roster`)
    return [
      "You're not on the Riskety Rekt roster yet.",
      "",
      "Send this to whoever runs the season:",
      "```",
      `npm run roster:add -- ${payload.userId} <faction-id> "Your Name"`,
      "```",
    ].join("\n")
  }

  const token = newToken()
  deps.store.mintLoginToken({
    slackUserId: payload.userId,
    factionId,
    tokenHash: hashToken(token),
    expiresAt: new Date(deps.now.getTime() + LOGIN_TOKEN_TTL_MS),
  })

  // The faction, never the token.
  log(`login: minted a token for ${payload.userId} (${factionId})`)

  return [
    `Here's your link, <@${payload.userId}> — good for 10 minutes, single use.`,
    `${deps.webUrl}/login/${token}`,
    "",
    `Run /login as often as you like — your last ${MAX_LIVE_TOKENS} links stay good.`,
  ].join("\n")
}
