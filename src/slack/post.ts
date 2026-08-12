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
