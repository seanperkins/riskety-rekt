import { MAX_LIVE_TOKENS, hashToken, newToken } from "../auth/token.js"
import { coerceDisplayName, factionIdFrom } from "../roster.js"
import type { AuthStore, RosterStore, SeasonStore } from "../store/types.js"
import type { Directory } from "./post.js"

/** How long a magic link is good for. Long enough to switch apps, no longer. */
export const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000

export interface LoginDeps {
  store: RosterStore & AuthStore & SeasonStore
  /** Which season decides whether the board has been handed out yet. */
  seasonId: string
  /** Origin of the web app, e.g. https://rr.example.com. No trailing slash. */
  webUrl: string
  now: Date
  /**
   * Reads channel membership, and ONLY consulted when somebody is joining.
   * Injected rather than constructed here for the same reason the store is:
   * it keeps `@slack/bolt` and the Web API client out of this file's import
   * graph, which is what keeps the suite offline.
   */
  directory: Directory
  channelId: string
  log?: (msg: string) => void
}

export interface LoginPayload {
  userId: string
  teamId: string
}

/**
 * What an unrostered player is told once the board has already been handed out.
 *
 * The reply carries the exact command with their id already in it, so they can
 * paste it to the operator rather than describing the problem.
 */
function askAnOperator(userId: string): string {
  return [
    "You're not on the Riskety Rekt roster yet, and a season is already running.",
    "",
    "The board is dealt from the roster when the season starts, so a seat added now",
    "would own no territory and earn no income — joining mid-season has to be a",
    "decision somebody makes deliberately. Send this to whoever runs the season:",
    "```",
    `npm run roster:add -- ${userId} <faction-id> "Your Name"`,
    "```",
  ].join("\n")
}

/**
 * The `/login` slash command.
 *
 * No Bolt, no network client and no clock of its own — `src/slack/app.ts`
 * adapts Bolt's types and sends the return value, the same split as the event
 * handlers. Async only because joining has to ask Slack who is in the channel.
 *
 * The return value contains the raw token exactly once, in the link. It is
 * never logged and never stored; only its hash reaches the database.
 *
 * **Joining is self-service only before a season exists.** That is not a
 * softening of the old rule, it is the same rule: the objection was always that
 * `season-init` sizes and deals the board from the roster, so a faction added
 * afterwards owns nothing, permanently. Before the deal that objection does not
 * apply, and the friction was buying nothing.
 */
export async function handleLoginCommand(
  payload: LoginPayload,
  deps: LoginDeps,
): Promise<string> {
  const log = deps.log ?? (() => {})

  let factionId = deps.store.factionForSlackUser(payload.userId)

  if (factionId === undefined) {
    if (deps.store.season(deps.seasonId) !== undefined) {
      log(`login: ${payload.userId} is not on the roster and the season is dealt`)
      return askAnOperator(payload.userId)
    }

    let members: { userId: string; name: string }[]
    try {
      members = await deps.directory.membersOf(deps.channelId)
    } catch (err) {
      // `membersOf` throws — a missing scope, a bot not in the channel, an
      // outage. None of that is something the player can fix, and a slash
      // command that raises tells them nothing, so degrade to the reply that
      // names a human who can help.
      log(`login: could not read the channel, not joining: ${String(err)}`)
      return askAnOperator(payload.userId)
    }

    const me = members.find((m) => m.userId === payload.userId)
    if (me === undefined) {
      log(`login: ${payload.userId} is not in the game channel`)
      return [
        "You're not in the Riskety Rekt channel yet, so there's nothing to join.",
        "",
        "Join the channel and run `/login` again — the season hasn't been dealt, so",
        "you can still get a seat.",
      ].join("\n")
    }

    const taken = new Set(deps.store.roster().map((m) => m.factionId))
    factionId = factionIdFrom(me.name, taken)
    deps.store.addRosterMember({
      slackUserId: payload.userId,
      factionId,
      // Coerced, not refused: nobody typed this name, and the only person who
      // could shorten it is the one being refused.
      displayName: coerceDisplayName(me.name, factionId),
    })
    log(`login: ${payload.userId} joined as ${factionId}`)
    return [
      `You're in, <@${payload.userId}> — added you to the roster as \`${factionId}\`.`,
      "",
      ...linkLines(mint(payload.userId, factionId, deps), deps.webUrl),
    ].join("\n")
  }

  return [
    `Here's your link, <@${payload.userId}> — good for 10 minutes, single use.`,
    ...linkLines(mint(payload.userId, factionId, deps), deps.webUrl),
  ].join("\n")
}

function mint(userId: string, factionId: string, deps: LoginDeps): string {
  const token = newToken()
  deps.store.mintLoginToken({
    slackUserId: userId,
    factionId,
    tokenHash: hashToken(token),
    expiresAt: new Date(deps.now.getTime() + LOGIN_TOKEN_TTL_MS),
  })
  // The faction, never the token.
  ;(deps.log ?? (() => {}))(`login: minted a token for ${userId} (${factionId})`)
  return token
}

/**
 * The link itself, and the two things every player needs to know about it.
 *
 * Shared by both replies so the joiner is told exactly what a returning player
 * is told — `/name` is advertised nowhere else, so a branch that forgot it
 * would leave half the players unaware the command exists.
 */
function linkLines(token: string, webUrl: string): string[] {
  return [
    `${webUrl}/login/${token}`,
    "",
    `Run /login as often as you like — your last ${MAX_LIVE_TOKENS} links stay good.`,
    "Want a different name? `/name Something Else`, or change it from the board.",
  ]
}
