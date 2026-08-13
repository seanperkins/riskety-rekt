import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { runRosterSync } from "./roster-sync.js"
import type { Directory } from "../slack/post.js"

const directory = (members: { userId: string; name: string }[]): Directory => ({
  nameFor: async () => undefined,
  membersOf: async () => members,
})

const store = () => openStore(":memory:")

// `factionIdFrom` moved to `src/roster.ts` when /login started inventing ids
// too; its tests moved with it to `src/roster.test.ts`.
describe("runRosterSync", () => {
  it("reports without writing unless applied", async () => {
    const s = store()
    const out = await runRosterSync({
      store: s,
      directory: directory([{ userId: "U1", name: "Ada" }]),
      channelId: "C1",
      apply: false,
    })
    expect(out.added).toHaveLength(1)
    expect(s.roster()).toHaveLength(0)
    s.close()
  })

  it("adds everyone in the channel when applied", async () => {
    const s = store()
    await runRosterSync({
      store: s,
      directory: directory([
        { userId: "U1", name: "Ada" },
        { userId: "U2", name: "Bo" },
      ]),
      channelId: "C1",
      apply: true,
    })
    expect(s.roster().map((m) => [m.factionId, m.displayName])).toEqual([
      ["ada", "Ada"],
      ["bo", "Bo"],
    ])
    s.close()
  })

  it("is idempotent — running it twice changes nothing", async () => {
    const s = store()
    const dir = directory([{ userId: "U1", name: "Ada" }])
    await runRosterSync({ store: s, directory: dir, channelId: "C1", apply: true })
    const second = await runRosterSync({ store: s, directory: dir, channelId: "C1", apply: true })
    expect(second.added).toHaveLength(0)
    expect(second.unchanged).toHaveLength(0)
    expect(s.roster()).toHaveLength(1)
    s.close()
  })

  it("reports a Slack rename but NEVER adopts it", async () => {
    // A player can set their own name with /name or from the board, and an
    // operator can set one with roster:add. Either is a more specific intent
    // than whatever the Slack profile happens to say, so a sync that adopted
    // Slack's would silently revert both — and the operator running it would
    // have no reason to suspect it had.
    const s = store()
    await runRosterSync({
      store: s,
      directory: directory([{ userId: "U1", name: "Ada" }]),
      channelId: "C1",
      apply: true,
    })
    const out = await runRosterSync({
      store: s,
      directory: directory([{ userId: "U1", name: "Ada L." }]),
      channelId: "C1",
      apply: true,
    })
    expect(out.unchanged).toHaveLength(1)
    // The report carries the name it did NOT take, so the drift is visible.
    expect(out.unchanged[0]!.displayName).toBe("Ada L.")
    expect(s.roster()).toEqual([{ slackUserId: "U1", factionId: "ada", displayName: "Ada" }])
    s.close()
  })

  it("keeps the faction id, which is what a rename must never move", async () => {
    // The id is baked into every saved state and log line once a season starts.
    const s = store()
    await runRosterSync({
      store: s,
      directory: directory([{ userId: "U1", name: "Ada" }]),
      channelId: "C1",
      apply: true,
    })
    s.addRosterMember({ slackUserId: "U1", factionId: "ada", displayName: "Ada L." })
    const out = await runRosterSync({
      store: s,
      directory: directory([{ userId: "U1", name: "Ada L." }]),
      channelId: "C1",
      apply: true,
    })
    expect(out.added).toEqual([])
    expect(s.roster()).toEqual([{ slackUserId: "U1", factionId: "ada", displayName: "Ada L." }])
    s.close()
  })

  it("reports someone who left the channel but NEVER removes them", async () => {
    // The board is dealt from the roster; a faction that vanished mid-season
    // would strand its territories with no owner.
    const s = store()
    await runRosterSync({
      store: s,
      directory: directory([
        { userId: "U1", name: "Ada" },
        { userId: "U2", name: "Bo" },
      ]),
      channelId: "C1",
      apply: true,
    })
    const out = await runRosterSync({
      store: s,
      directory: directory([{ userId: "U1", name: "Ada" }]),
      channelId: "C1",
      apply: true,
    })
    expect(out.absent.map((m) => m.factionId)).toEqual(["bo"])
    expect(s.roster()).toHaveLength(2)
    s.close()
  })

  it("propagates a failed member read instead of writing half a roster", async () => {
    const s = store()
    await expect(
      runRosterSync({
        store: s,
        directory: {
          nameFor: async () => undefined,
          membersOf: async () => {
            throw new Error("conversations.members failed: missing_scope")
          },
        },
        channelId: "C1",
        apply: true,
      }),
    ).rejects.toThrow(/missing_scope/)
    expect(s.roster()).toHaveLength(0)
    s.close()
  })
})
