import { describe, expect, it } from "vitest"
import { hashToken } from "../auth/token.js"
import { openStore } from "../store/sqlite.js"
import {
  SESSION_COOKIE,
  parseCookies,
  serializeSessionCookie,
  sessionFactionFor,
} from "./session.js"

const NOW = new Date("2026-09-02T12:00:00Z")
const END = new Date("2026-09-16T01:00:00Z")

describe("parseCookies", () => {
  it("reads several cookies", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" })
  })

  it("is empty for a missing or blank header", () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies("")).toEqual({})
  })

  it("keeps a value containing =", () => {
    // base64url has no "=", but a padded base64 value would, and silently
    // truncating a credential is the worst kind of bug to debug.
    expect(parseCookies("t=aa=bb")).toEqual({ t: "aa=bb" })
  })

  it("decodes percent-encoding and ignores junk segments", () => {
    expect(parseCookies("a=%20x; ; b")).toEqual({ a: " x" })
  })

  it("survives a malformed escape rather than throwing", () => {
    expect(() => parseCookies("a=%zz")).not.toThrow()
  })
})

describe("serializeSessionCookie", () => {
  const cookie = serializeSessionCookie("tok", END)

  it("is HttpOnly, Secure, SameSite=Lax and site-wide", () => {
    // HttpOnly because no client script needs it. Lax rather than Strict so the
    // link from Slack still works, while a cross-site POST cannot forge an
    // order.
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Path=/")
  })

  it("carries the token and an expiry", () => {
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`)
    expect(cookie).toContain("Expires=")
  })
})

describe("sessionFactionFor", () => {
  function loggedIn() {
    const store = openStore(":memory:")
    store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
    store.mintLoginToken({
      slackUserId: "U1",
      factionId: "f1",
      tokenHash: hashToken("login"),
      expiresAt: new Date("2026-09-02T12:10:00Z"),
    })
    store.consumeLoginToken({
      tokenHash: hashToken("login"),
      seasonId: "s1",
      sessionHash: hashToken("sess"),
      sessionExpiresAt: END,
      now: NOW,
    })
    return store
  }

  it("resolves a valid cookie to its faction", () => {
    const store = loggedIn()
    expect(
      sessionFactionFor(
        { headers: { cookie: `${SESSION_COOKIE}=sess` } },
        { store, seasonId: "s1", now: NOW },
      ),
    ).toBe("f1")
    store.close()
  })

  it("yields undefined for no cookie, junk, or the wrong season", () => {
    // Never a default faction. Falling back to one would hand a stranger
    // somebody's orders.
    const store = loggedIn()
    const call = (cookie: string | undefined, seasonId = "s1") =>
      sessionFactionFor({ headers: { cookie } }, { store, seasonId, now: NOW })
    expect(call(undefined)).toBeUndefined()
    expect(call("")).toBeUndefined()
    expect(call(`${SESSION_COOKIE}=nonsense`)).toBeUndefined()
    expect(call("other=sess")).toBeUndefined()
    expect(call(`${SESSION_COOKIE}=sess`, "s2")).toBeUndefined()
    store.close()
  })

  it("refuses a session after the season ends", () => {
    const store = loggedIn()
    expect(
      sessionFactionFor(
        { headers: { cookie: `${SESSION_COOKIE}=sess` } },
        { store, seasonId: "s1", now: new Date("2026-09-17T00:00:00Z") },
      ),
    ).toBeUndefined()
    store.close()
  })

  it("cannot be overridden by a factionId anywhere in the request", () => {
    // THE test. factionId is absent from the wire format, not merely validated
    // -- this asserts a request shouting a different faction is still resolved
    // from the session.
    const store = loggedIn()
    expect(
      sessionFactionFor(
        { headers: { cookie: `factionId=f9; ${SESSION_COOKIE}=sess; faction_id=f9` } },
        { store, seasonId: "s1", now: NOW },
      ),
    ).toBe("f1")
    store.close()
  })
})
