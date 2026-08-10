import { describe, expect, it, vi } from "vitest"
import { RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction } from "../engine/index.js"
import type { SlackMessage } from "../slack/post.js"
import { openStore } from "../store/sqlite.js"
import { runPostRecap } from "./post-recap.js"

const factions: Faction[] = [{ id: "f1", playerName: "Ada", color: "#f00" }]
const ids = RISK_MAP.territories.map((t) => t.id)

const state = (day: number) => ({ ...createSeason("s1", factions, ids), day, log: [] })

describe("runPostRecap", () => {
  it("posts the rendered recap", async () => {
    const post = vi.fn(async (_m: SlackMessage) => {})
    await runPostRecap({ poster: { post }, state: state(3), previous: state(2), lengthDays: 21 })
    expect(post).toHaveBeenCalledOnce()
    expect(post.mock.calls[0]![0].text).toContain("day 3")
  })

  it("marks a correction", async () => {
    const post = vi.fn(async (_m: SlackMessage) => {})
    await runPostRecap({
      poster: { post },
      state: state(3),
      previous: state(2),
      lengthDays: 21,
      correction: true,
    })
    expect(JSON.stringify(post.mock.calls[0]![0].blocks)).toMatch(/Correction/i)
  })

  it("propagates a posting failure", async () => {
    // A failed recap must be visible as a non-zero exit, not swallowed.
    const post = vi.fn(async (_m: SlackMessage) => {
      throw new Error("ratelimited")
    })
    await expect(
      runPostRecap({ poster: { post }, state: state(3), previous: state(2), lengthDays: 21 }),
    ).rejects.toThrow("ratelimited")
  })
})

describe("runPostRecap — the idempotency ledger", () => {
  const ledgered = (over: Partial<Parameters<typeof runPostRecap>[0]> = {}) => {
    const post = vi.fn(async (_m: SlackMessage) => {})
    const store = openStore(":memory:")
    return {
      post,
      store,
      run: (o: Partial<Parameters<typeof runPostRecap>[0]> = {}) =>
        runPostRecap({
          poster: { post },
          state: state(3),
          previous: state(2),
          lengthDays: 21,
          ledger: store,
          seasonId: "s1",
          now: new Date("2026-09-04T01:00:00Z"),
          ...over,
          ...o,
        }),
    }
  }

  it("posts the first time and suppresses the second", async () => {
    // The lost-acknowledgement case: the timer fires again, or an operator
    // re-runs `recap 3`, and the day must not get two recaps.
    const { post, store, run } = ledgered()
    expect(await run()).toEqual({ status: "posted", attempt: 1 })
    expect(await run()).toEqual({ status: "suppressed", attempt: 1 })
    expect(post).toHaveBeenCalledOnce()
    store.close()
  })

  it("leaves the row present when the post throws, so a plain retry skips", async () => {
    // The claim precedes the post on purpose: a crash in between loses the
    // recap rather than duplicating it. A duplicate is confusing and public; a
    // miss is recoverable with --force.
    const store = openStore(":memory:")
    const failing = vi.fn(async (_m: SlackMessage) => {
      throw new Error("ratelimited")
    })
    const base = {
      state: state(3),
      previous: state(2),
      lengthDays: 21,
      ledger: store,
      seasonId: "s1",
    }
    await expect(runPostRecap({ ...base, poster: { post: failing } })).rejects.toThrow()

    const ok = vi.fn(async (_m: SlackMessage) => {})
    expect(await runPostRecap({ ...base, poster: { post: ok } })).toMatchObject({
      status: "suppressed",
    })
    expect(ok).not.toHaveBeenCalled()
    store.close()
  })

  it("--force inserts a new attempt and posts", async () => {
    const { post, store, run } = ledgered()
    await run()
    expect(await run()).toMatchObject({ status: "suppressed" })
    expect(await run({ force: true })).toEqual({ status: "posted", attempt: 2 })
    expect(post).toHaveBeenCalledTimes(2)
    // And the forced attempt is itself idempotent at its own number.
    expect(await run()).toMatchObject({ status: "suppressed", attempt: 1 })
    expect(post).toHaveBeenCalledTimes(2)
    store.close()
  })

  it("does not use max+1 on the default path", async () => {
    // The subtle one. "Skip when a row exists for this (day, kind, attempt)" is
    // trivially false for a fresh attempt, so deriving the attempt from max+1
    // on the default path would make the suppression never fire.
    const { post, store, run } = ledgered()
    for (let i = 0; i < 5; i++) await run()
    expect(post).toHaveBeenCalledOnce()
    store.close()
  })

  it("lets a correction post after the original, and a second correction after the first", async () => {
    // Re-running a day twice because the first fix was wrong is an ordinary
    // event. A (season, day, kind) key would suppress it -- the attempt column
    // is what allows it.
    const { post, store, run } = ledgered()
    expect(await run()).toMatchObject({ status: "posted" })
    expect(await run({ correction: true })).toEqual({ status: "posted", attempt: 1 })
    expect(await run({ correction: true })).toMatchObject({ status: "suppressed" })
    expect(await run({ correction: true, force: true })).toEqual({ status: "posted", attempt: 2 })
    expect(post).toHaveBeenCalledTimes(3)
    store.close()
  })

  it("keys on the day, so a different day is not suppressed", async () => {
    const { post, store, run } = ledgered()
    await run()
    expect(await run({ state: state(4), previous: state(3) })).toMatchObject({ status: "posted" })
    expect(post).toHaveBeenCalledTimes(2)
    store.close()
  })

  it("posts unconditionally when no ledger is supplied", async () => {
    const post = vi.fn(async (_m: SlackMessage) => {})
    for (let i = 0; i < 3; i++) {
      await runPostRecap({ poster: { post }, state: state(3), previous: state(2), lengthDays: 21 })
    }
    expect(post).toHaveBeenCalledTimes(3)
  })
})
