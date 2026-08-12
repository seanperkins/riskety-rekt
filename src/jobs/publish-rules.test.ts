import { describe, expect, it, vi } from "vitest"
import { handleReactionEvent } from "../slack/handlers.js"
import { dailyRuleSelection } from "../slack/rule-vote.js"
import { openStore } from "../store/sqlite.js"
import { runPublishRules } from "./publish-rules.js"
import { RULES_PER_OFFER } from "../config.js"
import { RULE_CATALOGUE } from "../engine/rules/index.js"
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
  const react = vi.fn(async (_ts: string, _emoji: string) => {})
  return { post, react }
}

/** A poster whose reaction seeding always fails — the missing-scope case. */
const noReactPoster = (ts = "1756758000.000100") => {
  const post = vi.fn(async (_m: SlackMessage) => ts)
  const react = vi.fn(async (_ts: string, _emoji: string) => {
    throw new Error("missing_scope")
  })
  return { post, react }
}

describe("runPublishRules", () => {
  it("claims the draw, posts, and records the message ts", async () => {
    const store = setup()
    const poster = okPoster()
    const out = await runPublishRules({ store, seasonId: "s1", now: NOW, poster })
    expect(out).toMatchObject({ status: "posted", day: 3 })
    expect(poster.post).toHaveBeenCalledOnce()
    const offers = store.ruleOffersFor("s1", 3)
    expect(offers).toHaveLength(RULES_PER_OFFER)
    expect(offers.map((o) => o.ordinal)).toEqual([1, 2, 3])
    expect(offers.every((o) => o.messageTs === "1756758000.000100")).toBe(true)
    store.close()
  })

  it("draws a SUBSET of the catalogue — the ballot is smaller than the catalogue", async () => {
    const store = setup()
    await runPublishRules({ store, seasonId: "s1", now: NOW, poster: okPoster() })
    const drawn = store.ruleOffersFor("s1", 3).map((o) => o.ruleId)
    expect(drawn).toHaveLength(RULES_PER_OFFER)
    expect(RULE_CATALOGUE.length).toBeGreaterThan(RULES_PER_OFFER)
    // Every drawn id is a real catalogue entry, and the draw has no repeats.
    const ids = new Set(RULE_CATALOGUE.map((r) => r.id))
    for (const id of drawn) expect(ids.has(id)).toBe(true)
    expect(new Set(drawn).size).toBe(drawn.length)
    store.close()
  })

  it("draws different sets on different days", async () => {
    // Guards against a seed derivation that ignores the day. Checked across
    // several days so the assertion is not one unlucky collision away from
    // flaking.
    const store = setup()
    const days = [
      new Date("2026-08-07T12:00:00Z"),
      new Date("2026-08-09T12:00:00Z"),
      new Date("2026-08-11T12:00:00Z"),
      new Date("2026-08-13T12:00:00Z"),
    ]
    const draws: string[] = []
    for (const now of days) {
      await runPublishRules({ store, seasonId: "s1", now, poster: okPoster() })
      const day = Math.round((now.getTime() - Date.parse("2026-08-06T04:00:00Z")) / 86_400_000)
      draws.push(store.ruleOffersFor("s1", day).map((o) => o.ruleId).join(","))
    }
    expect(new Set(draws).size).toBeGreaterThan(1)
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

  it("pre-seeds the ballot with one numeral per candidate, in order", async () => {
    const store = setup()
    const poster = okPoster()
    await runPublishRules({ store, seasonId: "s1", now: NOW, poster })
    expect(poster.react.mock.calls.map((c) => c[1])).toEqual(["one", "two", "three"])
    // Always against the message that was just posted.
    for (const call of poster.react.mock.calls) expect(call[0]).toBe("1756758000.000100")
    store.close()
  })

  it("a missing reactions:write scope costs the ballot nothing", async () => {
    // The seeding is strictly cosmetic. If the scope is absent every react()
    // throws, and the offer must still be posted, recorded and votable —
    // players just add the numeral themselves.
    const store = setup()
    const poster = noReactPoster()
    const out = await runPublishRules({ store, seasonId: "s1", now: NOW, poster })

    expect(out).toMatchObject({ status: "posted", day: 3 })
    expect(poster.react).toHaveBeenCalledTimes(3) // every one attempted, none fatal
    const offers = store.ruleOffersFor("s1", 3)
    expect(offers).toHaveLength(RULES_PER_OFFER)
    expect(offers.every((o) => o.messageTs === "1756758000.000100")).toBe(true)
    store.close()
  })

  it("seeds only AFTER the message ts is recorded", async () => {
    // Ordering is load-bearing: the vote works the moment the ts is stored, so
    // recording must not sit behind a call that can fail.
    const store = setup()
    const seen: (string | null)[] = []
    const poster = {
      post: vi.fn(async (_m: SlackMessage) => "1756758000.000100"),
      react: vi.fn(async (_ts: string, _emoji: string) => {
        seen.push(store.ruleOffersFor("s1", 3)[0]!.messageTs)
      }),
    }
    await runPublishRules({ store, seasonId: "s1", now: NOW, poster })
    expect(seen).toEqual(Array(3).fill("1756758000.000100"))
    store.close()
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
    const dying = {
      post: vi.fn(async (_m: SlackMessage): Promise<string | undefined> => {
        throw new Error("slack 500")
      }),
      react: vi.fn(async (_ts: string, _emoji: string) => {}),
    }
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
