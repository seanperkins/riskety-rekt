import { describe, expect, it } from "vitest"
import { hashToken } from "../auth/token.js"
import { openStore } from "../store/sqlite.js"
import { handleLoginCommand } from "./login.js"

const NOW = new Date("2026-09-02T12:00:00Z")
const SEASON_END = new Date("2026-09-16T01:00:00Z")

function seeded(rostered = true) {
  const store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
  if (rostered) {
    store.addRosterMember({ slackUserId: "U01ABCDEF", factionId: "f1", displayName: "Ada" })
  }
  return store
}

const deps = (store: ReturnType<typeof openStore>) => ({
  store,
  webUrl: "https://rr.example.com",
  now: NOW,
})

const tokenIn = (reply: string) => /\/login\/([A-Za-z0-9_-]+)/.exec(reply)?.[1]

describe("handleLoginCommand", () => {
  it("returns a link containing a token", () => {
    const store = seeded()
    const reply = handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store))
    expect(reply).toMatch(/https:\/\/rr\.example\.com\/login\/[A-Za-z0-9_-]+/)
    store.close()
  })

  it("stores the token HASHED, never raw", () => {
    // The property the whole design rests on: the raw value must not open the
    // row, only its hash.
    const store = seeded()
    const raw = tokenIn(handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store)))!
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

  it("mints a token that actually works", () => {
    const store = seeded()
    const raw = tokenIn(handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store)))!
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

  it("tells an unrostered player exactly what to send, with their id filled in", () => {
    // The message most new players will actually see. A vague one produces a DM
    // to the operator asking why the game is broken.
    const store = seeded(false)
    const reply = handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
    expect(reply).toContain("not on the")
    expect(reply).toContain("roster:add")
    expect(reply).toContain("U0NEWBIE")
    expect(tokenIn(reply)).toBeUndefined()
    store.close()
  })

  it("mints nothing for an unrostered player", () => {
    const store = seeded(false)
    handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
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

  it("never logs the raw token", () => {
    const lines: string[] = []
    const store = seeded()
    const reply = handleLoginCommand(
      { userId: "U01ABCDEF", teamId: "T1" },
      { ...deps(store), log: (m) => lines.push(m) },
    )
    expect(lines.join("\n")).not.toContain(tokenIn(reply)!)
    store.close()
  })

  it("a second login invalidates the first link", () => {
    const store = seeded()
    const first = tokenIn(handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store)))!
    handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store))
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken(first),
        seasonId: "s1",
        sessionHash: hashToken("x"),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      }),
    ).toBeUndefined()
    store.close()
  })
})
