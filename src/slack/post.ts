import { WebClient } from "@slack/web-api"
import type { SlackEnv } from "./env.js"

export interface SlackMessage {
  text: string
  blocks: unknown[]
}

export interface Poster {
  /**
   * Resolves to the posted message's ts — claim-then-post ledgers (the rule
   * offer) record it so reactions can find their message. Callers that don't
   * need it ignore the return value.
   */
  post(message: SlackMessage): Promise<string | undefined>
}

/**
 * A poster that can also react. Separate from `Poster` because only the rule
 * offer needs it — the recap and the slate announcement post and nothing more,
 * and widening the base interface would make every one of their test fakes
 * stub a method they never call.
 */
export interface ReactingPoster extends Poster {
  /**
   * Add a reaction to an existing message. Pre-seeds the rule offer's numeral
   * ballot so voting is one tap rather than an emoji hunt.
   *
   * Needs the `reactions:write` scope, which the game does not otherwise use —
   * so callers MUST treat failure as cosmetic. The bot's own reactions are
   * harmless to the tally: the bot user is not on the roster, so
   * `factionForSlackUser` drops them at ingest.
   */
  react(messageTs: string, emoji: string): Promise<void>
}

/** The narrow slice of WebClient this file uses, so tests can fake it. */
export interface ChatClient {
  chat: { postMessage(args: Record<string, unknown>): Promise<unknown> }
  reactions: { add(args: Record<string, unknown>): Promise<unknown> }
}

export interface UserClient {
  users: { info(args: Record<string, unknown>): Promise<unknown> }
  conversations: { members(args: Record<string, unknown>): Promise<unknown> }
}

/** Reads the channel and its people, so nobody has to retype what Slack knows. */
export interface Directory {
  /**
   * Slack's name for a user, or undefined if it cannot be read — an unknown id,
   * a missing scope, a workspace that hides profiles. Never throws: the caller
   * is `roster:add`, where the fallback is simply "pass the name yourself".
   */
  nameFor(userId: string): Promise<string | undefined>
  /**
   * Every human in the channel, bots excluded, paged to the end.
   *
   * THROWS on failure, unlike `nameFor`. The difference is what the caller can
   * do about it: a missing name has an obvious fallback, whereas a roster built
   * from a truncated or empty member list would silently deal a season without
   * half the players in it.
   */
  membersOf(channelId: string): Promise<{ userId: string; name: string }[]>
}

/**
 * The only code that speaks to the Slack Web API.
 *
 * `unfurl_links: false` matters more than it looks: a recap naming a market
 * would otherwise expand a Kalshi preview under every post, and the preview is
 * fetched live — which is to say, it can show an outcome the recap deliberately
 * has not stated yet.
 */
export function createPoster(env: SlackEnv, client?: ChatClient): ReactingPoster {
  // Constructed lazily so a test that injects a client never builds a real one.
  const web: ChatClient = client ?? (new WebClient(env.botToken) as unknown as ChatClient)
  return {
    async post(message: SlackMessage): Promise<string | undefined> {
      const res = await web.chat.postMessage({
        channel: env.channelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      })
      return (res as { ts?: string }).ts
    },

    async react(messageTs: string, emoji: string): Promise<void> {
      await web.reactions.add({ channel: env.channelId, timestamp: messageTs, name: emoji })
    },
  }
}

/**
 * Takes the bot token alone, not the whole `SlackEnv`.
 *
 * Deliberate: the roster is built before a workspace is fully configured, and
 * `loadSlackEnv` demands the signing secret and RR_WEB_URL — neither of which
 * reading a channel needs. Requiring them would mean the command you run first
 * could not run until everything else was already set up.
 */
export function createDirectory(botToken: string, client?: UserClient): Directory {
  const web: UserClient = client ?? (new WebClient(botToken) as unknown as UserClient)
  return {
    async nameFor(userId: string): Promise<string | undefined> {
      try {
        const res = (await web.users.info({ user: userId })) as {
          ok?: boolean
          user?: {
            real_name?: string
            is_bot?: boolean
            profile?: { display_name?: string; real_name?: string }
          }
        }
        if (res.ok !== true || res.user === undefined) return undefined
        const p = res.user.profile ?? {}
        // Slack's own precedence: display_name is what a person chose to be
        // called, real_name is the fallback when they set none. Empty string is
        // how Slack says "unset", so it must not win.
        return [p.display_name, p.real_name, res.user.real_name].find(
          (n): n is string => typeof n === "string" && n.trim() !== "",
        )
      } catch {
        return undefined
      }
    },

    async membersOf(channelId: string): Promise<{ userId: string; name: string }[]> {
      const ids: string[] = []
      let cursor: string | undefined
      // Paged to the end deliberately. Reading only the first page would look
      // like it worked and quietly leave everyone past member 100 out of the
      // season -- and the board is sized to the roster, so they could not be
      // added afterwards.
      do {
        const res = (await web.conversations.members({
          channel: channelId,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        })) as {
          ok?: boolean
          error?: string
          members?: string[]
          response_metadata?: { next_cursor?: string }
        }
        if (res.ok !== true) {
          const hint =
            res.error === "missing_scope"
              ? " — the bot needs the channels:read scope (groups:read for a private channel)"
              : ""
          throw new Error(`conversations.members failed: ${res.error ?? "unknown"}${hint}`)
        }
        ids.push(...(res.members ?? []))
        const next = res.response_metadata?.next_cursor
        cursor = next === undefined || next === "" ? undefined : next
      } while (cursor !== undefined)

      const out: { userId: string; name: string }[] = []
      for (const userId of ids) {
        const res = (await web.users.info({ user: userId })) as {
          ok?: boolean
          user?: {
            real_name?: string
            is_bot?: boolean
            deleted?: boolean
            profile?: { display_name?: string; real_name?: string }
          }
        }
        if (res.ok !== true || res.user === undefined) continue
        // The bot itself is in the channel it reads. So is Slackbot, and so are
        // any deactivated accounts still listed as members.
        if (res.user.is_bot === true || res.user.deleted === true) continue
        const p = res.user.profile ?? {}
        const name = [p.display_name, p.real_name, res.user.real_name].find(
          (n): n is string => typeof n === "string" && n.trim() !== "",
        )
        out.push({ userId, name: name ?? userId })
      }
      return out
    },
  }
}
