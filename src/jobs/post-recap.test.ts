import { describe, expect, it, vi } from "vitest"
import { RISK_MAP, createSeason } from "../engine/index.js"
import type { Faction } from "../engine/index.js"
import type { SlackMessage } from "../slack/post.js"
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
