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

/** The narrow slice of WebClient this file uses, so tests can fake it. */
export interface ChatClient {
  chat: { postMessage(args: Record<string, unknown>): Promise<unknown> }
}

/**
 * The only code that speaks to the Slack Web API.
 *
 * `unfurl_links: false` matters more than it looks: a recap naming a market
 * would otherwise expand a Kalshi preview under every post, and the preview is
 * fetched live — which is to say, it can show an outcome the recap deliberately
 * has not stated yet.
 */
export function createPoster(env: SlackEnv, client?: ChatClient): Poster {
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
  }
}
