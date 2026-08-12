import { describe, expect, it, vi } from "vitest"
import { handleReactionEvent } from "../slack/handlers.js"
import { dailyRuleSelection } from "../slack/rule-vote.js"
import { openStore } from "../store/sqlite.js"
import { runPublishRules } from "./publish-rules.js"
import type { SlackMessage } from "../slack/post.js"

// startDate 2026-08-06; noon UTC on the 9th is ET morning of day 3.
const NOW = new Date("2026-08-09T12:05:00Z")

function setup(over: { lengthDays?: number } = {}) {
  const store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-08-06", lengthDays: over.lengthDays ?? 14 })
  return store
}

const okPoster = (ts = "1756758000.000100") => {
  const post = vi.fn(async (_m: SlackMessage) => ts)
  return { post }
}

describe("runPublishRules", () => {
  it("claims the draw, posts, and records the message ts", async () => {
    const store = setup()
    const poster = okPoster()
    const out = await runPublishRules({ store, seasonId: "s1", now: NOW, poster })
    expect(out).toMatchObject({ status: "posted", day: 3 })
    expect(poster.post).toHaveBeenCalledOnce()
    const offers = store.ruleOffersFor("s1", 3)
    expect(offers).toHaveLength(3) // all three season-one rules are eligible
    expect(offers.every((o) => o.messageTs === "1756758000.000100")).toBe(true)
    store.close()
  })

  it("draws deterministically and stores the auditable seed", async () => {
    const a = setup()
    const b = setup()
    await runPublishRules({ store: a, seasonId: "s1", now: NOW, poster: okPoster() })
    await runPublishRules({ store: b, seasonId: "s1", now: NOW, poster: okPoster() })
    const expectSeed = String(((0 ^ (3 * 0x9e3779b9)) >>> 0))
    expect(a.ruleOffersFor("s1", 3)).toEqual(b.ruleOffersFor("s1", 3))
    expect(a.ruleOffersFor("s1", 3)[0]!.seed).toBe(expectSeed)
    a.close()
    b.close()
  })

  it("skips a second run — already posted", async () => {
    const store = setup()
    await runPublishRules({ store, seasonId: "s1", now: NOW, poster: okPoster() })
    const poster = okPoster()
    const out = await runPublishRules({ store, seasonId: "s1", now: NOW, poster })
    expect(out).toEqual({ status: "skipped", day: 3, reason: "already-posted" })
    expect(poster.post).not.toHaveBeenCalled()
    store.close()
  })

  it("skips outside the season, final day included in range", async () => {
    const store = setup()
    expect(
      await runPublishRules({
        store, seasonId: "s1", now: new Date("2026-08-05T12:00:00Z"), poster: okPoster(),
      }),
    ).toMatchObject({ status: "skipped", reason: "before-season" })
    expect(
      await runPublishRules({
        store, seasonId: "s1", now: new Date("2026-09-01T12:00:00Z"), poster: okPoster(),
      }),
    ).toMatchObject({ status: "skipped", reason: "after-season" })
    // Day 14 of 14: rules apply to the same night's tick, so the final day posts.
    expect(
      await runPublishRules({
        store, seasonId: "s1", now: new Date("2026-08-20T12:00:00Z"), poster: okPoster(),
      }),
    ).toMatchObject({ status: "posted", day: 14 })
    store.close()
  })

  it("claims without posting when no poster is configured; a later run posts", async () => {
    const store = setup()
    const first = await runPublishRules({ store, seasonId: "s1", now: NOW })
    expect(first).toMatchObject({ status: "claimed", day: 3 })
    expect(store.ruleOffersFor("s1", 3).every((o) => o.messageTs === null)).toBe(true)

    const poster = okPoster()
    const second = await runPublishRules({ store, seasonId: "s1", now: NOW, poster })
    expect(second).toMatchObject({ status: "posted", day: 3 })
    // The recovery post marks supersession — indistinguishable from a
    // crash-after-post, and the copy must point players at the live message.
    expect(JSON.stringify(poster.post.mock.calls[0]![0].blocks)).toContain("Replaces the offer")
    store.close()
  })

  it("crash before post replays cleanly, and votes on the RE-POSTED message count", async () => {
    const store = setup()
    store.addRosterMember({ slackUserId: "U2", factionId: "f2", displayName: "Bex" })
    const dying = { post: vi.fn(async (_m: SlackMessage): Promise<string | undefined> => {
      throw new Error("slack 500")
    }) }
    await expect(
      runPublishRules({ store, seasonId: "s1", now: NOW, poster: dying }),
    ).rejects.toThrow("slack 500")
    // The claim landed; message_ts stays NULL — the crash-before-post state.
    expect(store.ruleOffersFor("s1", 3).every((o) => o.messageTs === null)).toBe(true)

    const poster = okPoster("1756759999.000500")
    await runPublishRules({ store, seasonId: "s1", now: NOW, poster })

    // A vote on the re-posted ts survives ingest and reaches the tally.
    const deps = { store, scope: { teamId: "T1", channelId: "C1" }, log: () => {} }
    const out = handleReactionEvent(
      {
        eventId: "Ev-vote",
        teamId: "T1",
        event: {
          type: "reaction_added" as const,
          user: "U2",
          reaction: "one",
          item_user: "UBOT",
          item: { type: "message", channel: "C1", ts: "1756759999.000500" },
          event_ts: "1756760000.000100",
        },
      },
      deps,
    )
    expect(out).toEqual({ kind: "vote" })
    const winner = dailyRuleSelection(store, "s1", 3, "2026-09-01T21:00:00.000Z")
    expect(winner).toHaveLength(1)
    expect(store.ruleOffersFor("s1", 3).find((o) => o.ordinal === 1)!.ruleId).toBe(winner[0])
    store.close()
  })
})
