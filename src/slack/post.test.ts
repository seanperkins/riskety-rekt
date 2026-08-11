import { describe, expect, it, vi } from "vitest"
import { createPoster } from "./post.js"

const env = { signingSecret: "s", botToken: "xoxb-t", teamId: "T1", channelId: "C1", webUrl: "https://rr.test" }

describe("createPoster", () => {
  it("posts to the configured channel with a fallback text", async () => {
    const chat = { postMessage: vi.fn().mockResolvedValue({ ok: true }) }
    const poster = createPoster(env, { chat })
    await poster.post({ text: "fallback", blocks: [{ type: "divider" }] })

    expect(chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "fallback",
      blocks: [{ type: "divider" }],
      unfurl_links: false,
      unfurl_media: false,
    })
  })

  it("propagates a Slack failure rather than swallowing it", async () => {
    // A recap that failed to post must exit non-zero so the timer's failure is
    // visible. Silence here is how a season's recaps quietly stop.
    const chat = { postMessage: vi.fn().mockRejectedValue(new Error("channel_not_found")) }
    const poster = createPoster(env, { chat })
    await expect(poster.post({ text: "x", blocks: [] })).rejects.toThrow("channel_not_found")
  })
})
