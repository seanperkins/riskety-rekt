import { describe, expect, it, vi } from "vitest"
import { createPoster } from "./post.js"

const env = { signingSecret: "s", botToken: "xoxb-t", teamId: "T1", channelId: "C1", webUrl: "https://rr.test" }

const reactions = () => ({ add: vi.fn().mockResolvedValue({ ok: true }) })

describe("createPoster", () => {
  it("posts to the configured channel with a fallback text", async () => {
    const chat = { postMessage: vi.fn().mockResolvedValue({ ok: true }) }
    const poster = createPoster(env, { chat, reactions: reactions() })
    await poster.post({ text: "fallback", blocks: [{ type: "divider" }] })

    expect(chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "fallback",
      blocks: [{ type: "divider" }],
      unfurl_links: false,
      unfurl_media: false,
    })
  })

  it("returns the posted message ts, which the offer ledger records", async () => {
    const chat = { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1756758000.000100" }) }
    const poster = createPoster(env, { chat, reactions: reactions() })
    expect(await poster.post({ text: "x", blocks: [] })).toBe("1756758000.000100")
  })

  it("propagates a Slack failure rather than swallowing it", async () => {
    // A recap that failed to post must exit non-zero so the timer's failure is
    // visible. Silence here is how a season's recaps quietly stop.
    const chat = { postMessage: vi.fn().mockRejectedValue(new Error("channel_not_found")) }
    const poster = createPoster(env, { chat, reactions: reactions() })
    await expect(poster.post({ text: "x", blocks: [] })).rejects.toThrow("channel_not_found")
  })

  it("adds a reaction to the named message in the configured channel", async () => {
    const chat = { postMessage: vi.fn().mockResolvedValue({ ok: true }) }
    const rx = reactions()
    await createPoster(env, { chat, reactions: rx }).react("1756758000.000100", "one")
    expect(rx.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "1756758000.000100",
      name: "one",
    })
  })
})
