import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { hashToken, newToken } from "../auth/token.js"
import { openStore } from "../store/sqlite.js"
import { createWebServer } from "./server.js"

let server: Server
let base: string
let store: ReturnType<typeof openStore>

/**
 * A real server on an ephemeral port. `test/no-network.ts` replaces global
 * `fetch`, so these use `node:http` directly — which is right anyway: the point
 * is to exercise the server, not to reach the network.
 */
beforeAll(async () => {
  store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
  server = createWebServer({ port: 0, store, seasonId: "s1" })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  store.close()
})

async function request(
  path: string,
  method = "GET",
  cookie?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { request: httpRequest } = await import("node:http")
  const headers = cookie === undefined ? {} : { cookie }
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("the web server", () => {
  it("serves the debug map at /map", async () => {
    const res = await request("/map")
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8")
    expect(res.body).toContain("<svg")
  })

  it("serves the landing page at / when there is no session", async () => {
    // Never a default faction. The page argues for the game now, but it is
    // still built from a constant seed and reads nothing.
    const res = await request("/")
    expect(res.status).toBe(200)
    expect(res.body).toContain("/login")
    expect(res.body).not.toContain("__RR__")
  })

  it("tells a stranger both things they might need: the command, and the roster", async () => {
    // Two different dead ends land on this page, and only one is fixed by
    // running the command again. Somebody not on the roster can run /login all
    // day and never get a link, so the page has to name that case.
    const res = await request("/")
    expect(res.body).toContain("/login")
    expect(res.body).toMatch(/roster/i)
  })

  it("puts no live season on the signed-out page", async () => {
    // This page USED to be held to naming no game noun at all, which is the
    // invariant the landing page was written to break — a stranger who cannot
    // be told what the game is cannot be persuaded to join it. What survives is
    // the half that was ever about disclosure: no season reaches it.
    //
    // Asserted as an identity rather than a word list. `renderLanding` takes no
    // arguments and no store, so a page equal to its output cannot contain
    // anything read from one — and unlike a list of forbidden nouns, this does
    // not quietly stop covering the leak when the copy is reworded.
    const { renderLanding } = await import("./landing.js")
    const res = await request("/")
    expect(res.body).toBe(renderLanding())
    expect(res.body).not.toContain("__RR__")
  })

  it("serves /rules without a session, like /map", async () => {
    const res = await request("/rules")
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8")
    expect(res.body).toMatch(/simultaneous/i)
    expect(res.body).not.toContain("__RR__")
  })

  it("ignores a query parameter it does not know", async () => {
    // The URL is parsed for its pathname, so an unrelated param -- a cache
    // buster, a tracking tag -- must not miss the route.
    expect((await request("/map?cachebust=1")).status).toBe(200)
    expect((await request("/map?utm_source=slack")).status).toBe(200)
  })

  it("404s a KNOWN parameter used wrongly", async () => {
    // The distinction that matters: an unknown param is somebody else's
    // business, but "seed" without "factions" is a link this app generates,
    // typed wrong. Ignoring it would render the world and look like success.
    expect((await request("/map?seed=1")).status).toBe(404)
  })

  it("404s an unknown path without reflecting markup into the page", async () => {
    // Two layers, and it matters which one is doing the work. Node's URL parser
    // percent-encodes < and > in a pathname, so a raw tag never reaches the
    // renderer at all -- the escape is defence in depth behind that, not the
    // only guard.
    const res = await request("/nope<script>alert(1)</script>")
    expect(res.status).toBe(404)
    expect(res.body).not.toContain("<script>alert(1)")
    expect(res.body).toContain("%3Cscript%3E")
  })

  it("escapes the characters the URL parser leaves intact", () => {
    // & survives pathname parsing where < and > do not, so this is the
    // character that actually exercises the escape rather than the parser.
    expect(new URL("/a&b", "http://x").pathname).toBe("/a&b")
  })

  it("escapes an ampersand path into the 404 page", async () => {
    const res = await request("/nope&co")
    expect(res.status).toBe(404)
    expect(res.body).toContain("/nope&amp;co")
  })

  it("answers HEAD with headers and no body", async () => {
    // A health check that gets a body on HEAD hangs waiting for the end event.
    const res = await request("/", "HEAD")
    expect(res.status).toBe(200)
    expect(res.body).toBe("")
  })

  it("405s a method it does not serve, and says which it does", async () => {
    const res = await request("/", "POST")
    expect(res.status).toBe(405)
    expect(res.headers["allow"]).toBe("GET, HEAD")
  })
})

describe("region focus", () => {
  it("serves a focused region", async () => {
    const res = await request("/map?region=balkans")
    expect(res.status).toBe(200)
    expect(res.body).toContain("Serbia")
    // Far-away territories are excluded, which is the whole point.
    expect(res.body).not.toContain("Madagascar")
  })

  it("404s an unknown region rather than falling back to the world", async () => {
    // Silently showing something plausible is the worst outcome for a page
    // whose job is catching mistakes -- a typo'd region would look like a
    // successful check.
    const res = await request("/map?region=atlantis")
    expect(res.status).toBe(404)
    expect(res.body).not.toContain("Serbia")
  })

  it("escapes an unknown region into the 404 page", async () => {
    const res = await request("/map?region=a%26b")
    expect(res.status).toBe(404)
    expect(res.body).toContain("a&amp;b")
  })

  it("lists every region on the focused page, not just the ones on screen", async () => {
    // The rail is how you get from one region to the next, so it must not
    // shrink to whatever happens to be visible.
    const res = await request("/map?region=balkans")
    expect(res.body).toContain("The Maghreb")
    expect(res.body).toContain("Oceania")
  })
})

describe("board selection", () => {
  it("deals a board for a roster size", async () => {
    const res = await request("/map?factions=15")
    expect(res.status).toBe(200)
    expect(res.body).toContain("15-faction season")
    // Fewer territories than the world, because it is a selected sub-map.
    const circles = (res.body.match(/<circle /g) ?? []).length
    expect(circles).toBeGreaterThan(70)
    expect(circles).toBeLessThan(180)
  })

  it("is stable without a seed and different with one", async () => {
    const a = await request("/map?factions=11")
    const b = await request("/map?factions=11")
    const c = await request("/map?factions=11&seed=99")
    expect(a.body).toBe(b.body)
    expect(a.body).not.toBe(c.body)
  })

  it("reports territories per faction, which is the number that must be legal", async () => {
    const res = await request("/map?factions=15")
    expect(res.body).toContain("per faction")
  })

  it("404s a roster outside the faction bounds rather than throwing", async () => {
    // selectSubMap THROWS on an impossible roster, which would be a 500 where a
    // 404 is owed. The bound is checked before it is called.
    for (const q of ["factions=3", "factions=16", "factions=0", "factions=abc", "factions=1.5"]) {
      expect((await request(`/map?${q}`)).status, q).toBe(404)
    }
  })

  it("404s a malformed seed", async () => {
    for (const q of ["factions=8&seed=abc", "factions=8&seed=-1", "factions=8&seed=1.5"]) {
      expect((await request(`/map?${q}`)).status, q).toBe(404)
    }
  })

  it("focuses a region within a dealt board", async () => {
    // Both at once, because auditing a dealt board's region is the case this
    // exists for.
    const board = await request("/map?factions=15&seed=4711")
    const region = [...board.body.matchAll(/region=([a-z_]+)/g)].map((m) => m[1]!)[0]!
    const res = await request(`/map?factions=15&seed=4711&region=${region}`)
    expect(res.status).toBe(200)
    expect((res.body.match(/<circle /g) ?? []).length).toBeLessThan(
      (board.body.match(/<circle /g) ?? []).length,
    )
  })

  it("404s a region that exists but was not dealt onto this board", async () => {
    // Silently drawing the world's copy would misrepresent the deal -- it would
    // show a region on a board that does not contain it.
    const board = await request("/map?factions=4&seed=4711")
    const dealt = new Set([...board.body.matchAll(/region=([a-z_]+)/g)].map((m) => m[1]!))
    const absent = ["oceania", "caribbean", "cape", "insulindia"].find((r) => !dealt.has(r))
    expect(absent, "expected some region to be off a 4-faction board").toBeDefined()
    expect((await request(`/map?factions=4&seed=4711&region=${absent!}`)).status).toBe(404)
  })
})

describe("login", () => {
  it("401s an unknown, expired or reused token identically", async () => {
    // The same page for every kind of wrong: telling someone holding a stale
    // link which kind it is helps nobody entitled to be here.
    for (const t of ["nope", "aaaaaaaaaaaaaaaaaaaaaaaa"]) {
      const res = await request(`/login/${t}`)
      expect(res.status, t).toBe(401)
      expect(res.body, t).toContain("no longer good")
    }
  })

  /**
   * A live session cookie, for the routes that branch on one.
   *
   * Goes through the real `/login/:token` exchange rather than forging a row:
   * the cookie's value is a token the server hashed on the way in, and a test
   * that manufactured one would stop covering that.
   */
  const signIn = async (slackUserId: string, factionId: string): Promise<string> => {
    const raw = newToken()
    store.mintLoginToken({
      slackUserId,
      factionId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 600_000),
    })
    const res = await request(`/login/${raw}`)
    return String(res.headers["set-cookie"]).split(";")[0]!
  }

  /**
   * The landing page is a REFRESHER, not just a sales pitch for strangers.
   *
   * It used to be the signed-out branch of `/` and nothing else, so the moment
   * a player logged in, the one page explaining what the game is became
   * unreachable to them — exactly the person most likely to want it a week in.
   * The board now lives at `/game` and `/` is the explainer for everybody.
   */
  it("still serves the landing page at / to a signed-in player", async () => {
    const cookie = await signIn("U-refresher", "f1")
    const res = await request("/", "GET", cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatch(/world conquest/i)
    expect(res.body).toMatch(/nobody moves first/i)
    // Still no board data on it, session or not.
    expect(res.body).not.toContain("__RR__")
  })

  it("points a signed-in visitor at their board, and a stranger at /login", async () => {
    const cookie = await signIn("U-cta", "f1")
    const signedIn = await request("/", "GET", cookie)
    expect(signedIn.body).toContain('href="/game"')

    const stranger = await request("/")
    expect(stranger.body).not.toContain('href="/game"')
    expect(stranger.body).toContain("/login")
  })

  it("serves the board at /game", async () => {
    const { RISK_MAP, createSeason } = await import("../engine/index.js")
    const dealt = createSeason(
      "s1",
      [
        { id: "f1", playerName: "Ada", color: "#e6194b" },
        { id: "f2", playerName: "Bo", color: "#3cb44b" },
      ],
      RISK_MAP.territories.map((t) => t.id),
    )
    store.saveState({ ...dealt, day: 1 }, "test")

    const cookie = await signIn("U-game", "f1")
    const res = await request("/game", "GET", cookie)
    expect(res.status).toBe(200)
    // The projection is the board's own payload; the landing page has none.
    expect(res.body).toContain("__RR__")
  })

  it("sends a signed-out visitor from /game to the landing page", async () => {
    // Not a 404 and not the board: someone following a stale bookmark or a
    // shared link should land somewhere that explains how to get in.
    const res = await request("/game")
    expect(res.status).toBe(303)
    expect(res.headers["location"]).toBe("/")
  })

  it("does not set a cookie when the token is refused", async () => {
    expect((await request("/login/nope")).headers["set-cookie"]).toBeUndefined()
  })

  it("issues a session cookie and redirects for a good token", async () => {
    const raw = newToken()
    store.mintLoginToken({
      slackUserId: "U1",
      factionId: "f1",
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 600_000),
    })
    const res = await request(`/login/${raw}`)
    expect(res.status).toBe(303)
    // To the board, not to the explainer -- someone who just ran /login wants
    // to play, and `/` is now the landing page for signed-in players too.
    expect(res.headers["location"]).toBe("/game")
    const cookie = String(res.headers["set-cookie"])
    expect(cookie).toContain("rr_session=")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
  })

  it("refuses the same link twice", async () => {
    const raw = newToken()
    store.mintLoginToken({
      slackUserId: "U2",
      factionId: "f2",
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 600_000),
    })
    expect((await request(`/login/${raw}`)).status).toBe(303)
    expect((await request(`/login/${raw}`)).status).toBe(401)
  })
})

describe("login before the season is dealt", () => {
  // A workspace between seasons: the bot is up and /login mints links, but
  // season:init has not run. This is an operator state, not a fault, and the
  // player arriving on a fresh link must not be shown a bare 500.
  let bare: ReturnType<typeof createWebServer>
  let bareBase: string

  beforeAll(async () => {
    bare = createWebServer({ port: 0, store, seasonId: "not-a-season" })
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve))
    bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => bare.close(() => resolve()))
  })

  const get = async (path: string): Promise<{ status: number; body: string }> => {
    const { request: httpRequest } = await import("node:http")
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${bareBase}${path}`, { method: "GET" }, (res) => {
        let body = ""
        res.on("data", (c) => (body += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on("error", reject)
      req.end()
    })
  }

  it("says the season has not started instead of 500ing", async () => {
    const raw = newToken()
    store.mintLoginToken({
      slackUserId: "U-preseason",
      factionId: "f1",
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 600_000),
    })
    const res = await get(`/login/${raw}`)
    expect(res.status).toBe(503)
    expect(res.body).toContain("The season hasn't started")
    expect(res.body).toContain("Your link is still good")
  })

  it("does NOT consume the token, so the link still works once dealt", async () => {
    // The whole point of answering early: a player who clicks before the deal
    // must not have burned their single-use link.
    const raw = newToken()
    store.mintLoginToken({
      slackUserId: "U-preseason-2",
      factionId: "f1",
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 600_000),
    })
    expect((await get(`/login/${raw}`)).status).toBe(503)
    // Same token, now against the server that HAS a season.
    expect((await request(`/login/${raw}`)).status).toBe(303)
  })
})
