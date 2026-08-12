import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { factionIdFrom, runRosterSync } from "./roster-sync.js"
import type { Directory } from "../slack/post.js"

const directory = (members: { userId: string; name: string }[]): Directory => ({
  nameFor: async () => undefined,
  membersOf: async () => members,
})

const store = () => openStore(":memory:")

describe("factionIdFrom", () => {
  it("makes a readable id out of a display name", () => {
    expect(factionIdFrom("Ada Lovelace", new Set())).toBe("ada-lovelace")
    expect(factionIdFrom("SEAN.md", new Set())).toBe("sean-md")
  })

  it("strips accents rather than dropping the letters", () => {
    // "José" must not become "jos" -- a truncated name is worse than a plain one.
    expect(factionIdFrom("José", new Set())).toBe("jose")
  })

  it("never collides, because two people really can share a display name", () => {
    const taken = new Set(["sam"])
    expect(factionIdFrom("Sam", taken)).toBe("sam-2")
    expect(factionIdFrom("Sam", new Set(["sam", "sam-2"]))).toBe("sam-3")
  })

  it("falls back rather than producing an empty id", () => {
    expect(factionIdFrom("🎲🎲", new Set())).toBe("player")
  })
})

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
    expect(second.updated).toHaveLength(0)
    expect(s.roster()).toHaveLength(1)
    s.close()
  })

  it("keeps the faction id when a display name changes", async () => {
    // The id is baked into every saved state and log line once a season starts.
    // A rename in Slack must not silently become a different faction.
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
    expect(out.updated).toHaveLength(1)
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
