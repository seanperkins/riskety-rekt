import { describe, expect, it } from "vitest"
import { MAX_LIVE_TOKENS, hashToken, newToken } from "../auth/token.js"
import { openStore } from "./sqlite.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }
const NOW = new Date("2026-09-02T12:00:00Z")
const IN_10 = new Date("2026-09-02T12:10:00Z")
const SEASON_END = new Date("2026-09-16T01:00:00Z")

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  return store
}

/** Mint a token and hand back the RAW value, as the Slack handler would. */
function mint(store: ReturnType<typeof openStore>, user = "U1", faction = "f1") {
  const raw = newToken()
  store.mintLoginToken({
    slackUserId: user,
    factionId: faction,
    tokenHash: hashToken(raw),
    expiresAt: IN_10,
  })
  return raw
}

const consume = (
  store: ReturnType<typeof openStore>,
  raw: string,
  session: string,
  over: { seasonId?: string; now?: Date } = {},
) =>
  store.consumeLoginToken({
    tokenHash: hashToken(raw),
    seasonId: over.seasonId ?? "s1",
    sessionHash: hashToken(session),
    sessionExpiresAt: SEASON_END,
    now: over.now ?? NOW,
  })

describe("login tokens", () => {
  it("consumes a valid token and yields the faction", () => {
    const store = seeded()
    expect(consume(store, mint(store), "a")).toBe("f1")
    store.close()
  })

  it("refuses the same token twice", () => {
    // Single-use. A link opened again -- a preview fetch, a double tap -- must
    // not mint a second session.
    const store = seeded()
    const raw = mint(store)
    expect(consume(store, raw, "a")).toBe("f1")
    expect(consume(store, raw, "b")).toBeUndefined()
    store.close()
  })

  it("refuses an expired token", () => {
    const store = seeded()
    const raw = mint(store)
    expect(consume(store, raw, "a", { now: new Date("2026-09-02T12:11:00Z") })).toBeUndefined()
    store.close()
  })

  it("refuses a token that was never minted", () => {
    const store = seeded()
    expect(consume(store, "never-existed", "a")).toBeUndefined()
    store.close()
  })

  it("leaves the previous token working when the same user logs in again", () => {
    // The property the cap exists to give back: a second /login before you
    // clicked the first does not strand you.
    const store = seeded()
    const first = mint(store)
    const second = mint(store)
    expect(consume(store, first, "a")).toBe("f1")
    expect(consume(store, second, "b")).toBe("f1")
    store.close()
  })

  it(`keeps ${MAX_LIVE_TOKENS} live tokens at once`, () => {
    const store = seeded()
    const raws = Array.from({ length: MAX_LIVE_TOKENS }, () => mint(store))
    raws.forEach((raw, i) => expect(consume(store, raw, `s${i}`)).toBe("f1"))
    store.close()
  })

  it(`evicts the oldest when a ${MAX_LIVE_TOKENS + 1}th is minted`, () => {
    const store = seeded()
    const raws = Array.from({ length: MAX_LIVE_TOKENS + 1 }, () => mint(store))
    expect(consume(store, raws[0]!, "evicted")).toBeUndefined()
    raws.slice(1).forEach((raw, i) => expect(consume(store, raw, `s${i}`)).toBe("f1"))
    store.close()
  })

  it("counts the cap per user, not globally", () => {
    // One person minting their limit must not evict anybody else's link.
    const store = seeded()
    const theirs = mint(store, "U2", "f2")
    for (let i = 0; i <= MAX_LIVE_TOKENS; i++) mint(store, "U1", "f1")
    expect(consume(store, theirs, "sb")).toBe("f2")
    store.close()
  })

  it("frees a slot when a token is consumed", () => {
    // Eviction is by insertion order over the rows still present, so consuming
    // one must not leave the next mint evicting a live token to make room.
    const store = seeded()
    const raws = Array.from({ length: MAX_LIVE_TOKENS }, () => mint(store))
    expect(consume(store, raws[0]!, "used")).toBe("f1")
    const fresh = mint(store)
    for (const raw of raws.slice(1)) expect(consume(store, raw, raw)).toBe("f1")
    expect(consume(store, fresh, "fresh")).toBe("f1")
    store.close()
  })

  it("keeps different users' tokens independent", () => {
    const store = seeded()
    const a = mint(store, "U1", "f1")
    const b = mint(store, "U2", "f2")
    expect(consume(store, a, "sa")).toBe("f1")
    expect(consume(store, b, "sb")).toBe("f2")
    store.close()
  })

  it("leaves no session behind when the token is refused", () => {
    // The delete and the insert are one transaction; a refused token must not
    // leave a usable session.
    const store = seeded()
    consume(store, "bogus", "orphan")
    expect(store.sessionFaction(hashToken("orphan"), "s1", NOW)).toBeUndefined()
    store.close()
  })
})

describe("sessions", () => {
  const login = (store: ReturnType<typeof openStore>, session: string, user = "U1", f = "f1") =>
    consume(store, mint(store, user, f), session)

  it("resolves a live session to its faction", () => {
    const store = seeded()
    login(store, "sess")
    expect(store.sessionFaction(hashToken("sess"), "s1", NOW)).toBe("f1")
    store.close()
  })

  it("refuses an expired session", () => {
    const store = seeded()
    login(store, "sess")
    expect(
      store.sessionFaction(hashToken("sess"), "s1", new Date("2026-09-17T00:00:00Z")),
    ).toBeUndefined()
    store.close()
  })

  it("refuses a session minted for a different season", () => {
    // A factionId only means something within a season.
    const store = seeded()
    login(store, "sess")
    expect(store.sessionFaction(hashToken("sess"), "s2", NOW)).toBeUndefined()
    store.close()
  })

  it("refuses an unknown session", () => {
    const store = seeded()
    expect(store.sessionFaction(hashToken("nope"), "s1", NOW)).toBeUndefined()
    store.close()
  })

  it("revokes every session for a faction and reports how many", () => {
    const store = seeded()
    login(store, "one")
    login(store, "two")
    expect(store.revokeSessions("f1")).toBe(2)
    expect(store.sessionFaction(hashToken("one"), "s1", NOW)).toBeUndefined()
    store.close()
  })

  it("revoking one faction leaves another alone", () => {
    const store = seeded()
    login(store, "mine")
    login(store, "theirs", "U2", "f2")
    store.revokeSessions("f1")
    expect(store.sessionFaction(hashToken("theirs"), "s1", NOW)).toBe("f2")
    store.close()
  })
})
