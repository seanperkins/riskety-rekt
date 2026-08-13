import { describe, expect, it } from "vitest"
import { MAX_LIVE_TOKENS, hashToken } from "../auth/token.js"
import { openStore } from "../store/sqlite.js"
import { handleLoginCommand } from "./login.js"
import type { Directory } from "./post.js"

const NOW = new Date("2026-09-02T12:00:00Z")
const SEASON_END = new Date("2026-09-16T01:00:00Z")

/**
 * `dealt` is the axis self-join turns on: a season that exists means the board
 * is already sized and handed out, so a latecomer would own nothing.
 */
function seeded({ rostered = true, dealt = true } = {}) {
  const store = openStore(":memory:")
  if (dealt) store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
  if (rostered) {
    store.addRosterMember({ slackUserId: "U01ABCDEF", factionId: "f1", displayName: "Ada" })
  }
  return store
}

const directory = (members: { userId: string; name: string }[]): Directory => ({
  nameFor: async () => undefined,
  membersOf: async () => members,
})

const deps = (store: ReturnType<typeof openStore>, dir?: Directory) => ({
  store,
  seasonId: "s1",
  webUrl: "https://rr.example.com",
  now: NOW,
  directory: dir ?? directory([{ userId: "U0NEWBIE", name: "Newbie" }]),
  channelId: "C1",
})

const tokenIn = (reply: string) => /\/login\/([A-Za-z0-9_-]+)/.exec(reply)?.[1]

describe("handleLoginCommand", () => {
  it("returns a link containing a token", async () => {
    const store = seeded()
    const reply = await handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store))
    expect(reply).toMatch(/https:\/\/rr\.example\.com\/login\/[A-Za-z0-9_-]+/)
    store.close()
  })

  it("stores the token HASHED, never raw", async () => {
    // The property the whole design rests on: the raw value must not open the
    // row, only its hash.
    const store = seeded()
    const raw = tokenIn(
      await handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store)),
    )!
    expect(
      store.consumeLoginToken({
        tokenHash: raw,
        seasonId: "s1",
        sessionHash: hashToken("x"),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      }),
    ).toBeUndefined()
    store.close()
  })

  it("mints a token that actually works", async () => {
    const store = seeded()
    const raw = tokenIn(
      await handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store)),
    )!
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken(raw),
        seasonId: "s1",
        sessionHash: hashToken("sess"),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      }),
    ).toBe("f1")
    store.close()
  })

  it("tells a player how to change their name", async () => {
    // The reply is the only place the command is advertised — there is no menu
    // and no help text anywhere else.
    const store = seeded()
    const reply = await handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store))
    expect(reply).toContain("/name")
    store.close()
  })

  it("never logs the raw token", async () => {
    const lines: string[] = []
    const store = seeded()
    const reply = await handleLoginCommand(
      { userId: "U01ABCDEF", teamId: "T1" },
      { ...deps(store), log: (m) => lines.push(m) },
    )
    expect(lines.join("\n")).not.toContain(tokenIn(reply)!)
    store.close()
  })

  it("a second login leaves the first link working", async () => {
    const store = seeded()
    const first = tokenIn(
      await handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store)),
    )!
    await handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store))
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken(first),
        seasonId: "s1",
        sessionHash: hashToken("x"),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      }),
    ).toBe("f1")
    store.close()
  })

  it(`a ${MAX_LIVE_TOKENS + 1}th login retires the oldest link`, async () => {
    const store = seeded()
    const raws: string[] = []
    for (let i = 0; i < MAX_LIVE_TOKENS + 1; i++) {
      raws.push(tokenIn(await handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store)))!)
    }
    const use = (raw: string) =>
      store.consumeLoginToken({
        tokenHash: hashToken(raw),
        seasonId: "s1",
        sessionHash: hashToken(raw),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      })
    expect(use(raws[0]!)).toBeUndefined()
    expect(use(raws[MAX_LIVE_TOKENS]!)).toBe("f1")
    store.close()
  })
})

describe("handleLoginCommand, once a season is dealt", () => {
  it("tells an unrostered player exactly what to send, with their id filled in", async () => {
    // The board is sized and handed out at season-init, so a faction added now
    // owns nothing and earns nothing, permanently. Joining has to be a decision
    // somebody makes on purpose.
    const store = seeded({ rostered: false })
    const reply = await handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
    expect(reply).toContain("not on the")
    expect(reply).toContain("roster:add")
    expect(reply).toContain("U0NEWBIE")
    expect(tokenIn(reply)).toBeUndefined()
    store.close()
  })

  it("adds nobody, even though they are in the channel", async () => {
    const store = seeded({ rostered: false })
    await handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
    expect(store.roster()).toEqual([])
    store.close()
  })

  it("mints nothing for an unrostered player", async () => {
    const store = seeded({ rostered: false })
    await handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken("anything"),
        seasonId: "s1",
        sessionHash: hashToken("x"),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      }),
    ).toBeUndefined()
    store.close()
  })
})

describe("handleLoginCommand, before a season is dealt", () => {
  it("adds a channel member to the roster and logs them straight in", async () => {
    const store = seeded({ rostered: false, dealt: false })
    const reply = await handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
    expect(store.roster()).toEqual([
      { slackUserId: "U0NEWBIE", factionId: "newbie", displayName: "Newbie" },
    ])
    // The link comes in the SAME reply. Adding them and then telling them to run
    // the command again is a dead end with extra steps.
    expect(tokenIn(reply)).toBeDefined()
    store.close()
  })

  it("says it added them, rather than silently doing it", async () => {
    const store = seeded({ rostered: false, dealt: false })
    const reply = await handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
    expect(reply).toMatch(/added you|you're in|signed you up/i)
    store.close()
  })

  it("refuses somebody who is not in the game channel", async () => {
    // A slash command is workspace-wide. Without this, anybody who can see
    // /login can claim a seat, and every phantom seat shrinks everyone's share
    // of the board at season-init.
    const store = seeded({ rostered: false, dealt: false })
    const reply = await handleLoginCommand(
      { userId: "U0STRANGER", teamId: "T1" },
      deps(store, directory([{ userId: "U0SOMEONEELSE", name: "Else" }])),
    )
    expect(store.roster()).toEqual([])
    expect(tokenIn(reply)).toBeUndefined()
    expect(reply).toMatch(/channel/i)
    store.close()
  })

  it("gives a joiner an id that does not collide with an existing one", async () => {
    const store = seeded({ rostered: false, dealt: false })
    store.addRosterMember({ slackUserId: "U1", factionId: "newbie", displayName: "Newbie" })
    await handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
    expect(store.factionForSlackUser("U0NEWBIE")).toBe("newbie-2")
    store.close()
  })

  it("does not re-add somebody already on the roster", async () => {
    const store = seeded({ rostered: true, dealt: false })
    await handleLoginCommand(
      { userId: "U01ABCDEF", teamId: "T1" },
      deps(store, directory([{ userId: "U01ABCDEF", name: "Renamed In Slack" }])),
    )
    // Their chosen name and their faction id both survive.
    expect(store.roster()).toEqual([
      { slackUserId: "U01ABCDEF", factionId: "f1", displayName: "Ada" },
    ])
    store.close()
  })

  it("truncates an over-long Slack name instead of refusing the join", async () => {
    const store = seeded({ rostered: false, dealt: false })
    await handleLoginCommand(
      { userId: "U0LONG", teamId: "T1" },
      deps(store, directory([{ userId: "U0LONG", name: "L".repeat(200) }])),
    )
    const [row] = store.roster()
    expect(row?.displayName.length).toBeLessThanOrEqual(32)
    store.close()
  })

  it("falls back to the operator message when the channel cannot be read", async () => {
    // membersOf THROWS on failure. A slash command that 500s tells the player
    // nothing they can act on, so the reply degrades to the one that names a
    // human who can help.
    const store = seeded({ rostered: false, dealt: false })
    const reply = await handleLoginCommand(
      { userId: "U0NEWBIE", teamId: "T1" },
      deps(store, {
        nameFor: async () => undefined,
        membersOf: async () => {
          throw new Error("missing scope")
        },
      }),
    )
    expect(store.roster()).toEqual([])
    expect(reply).toContain("roster:add")
    store.close()
  })
})
