import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { createWebServer } from "./server.js"

let server: Server
let base: string

/**
 * A real server on an ephemeral port. `test/no-network.ts` replaces global
 * `fetch`, so these use `node:http` directly — which is right anyway: the point
 * is to exercise the server, not to reach the network.
 */
beforeAll(async () => {
  server = createWebServer({ port: 0 })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function request(
  path: string,
  method = "GET",
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { request: httpRequest } = await import("node:http")
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("the web server", () => {
  it("serves the map at / and /map", async () => {
    for (const path of ["/", "/map"]) {
      const res = await request(path)
      expect(res.status, path).toBe(200)
      expect(res.headers["content-type"], path).toBe("text/html; charset=utf-8")
      expect(res.body, path).toContain("Riskety")
      expect(res.body, path).toContain("<svg")
    }
  })

  it("ignores a query parameter it does not know", async () => {
    // The URL is parsed for its pathname, so an unrelated param -- a cache
    // buster, a tracking tag -- must not miss the route.
    expect((await request("/?cachebust=1")).status).toBe(200)
    expect((await request("/map?utm_source=slack")).status).toBe(200)
  })

  it("404s a KNOWN parameter used wrongly", async () => {
    // The distinction that matters: an unknown param is somebody else's
    // business, but "seed" without "factions" is a link this app generates,
    // typed wrong. Ignoring it would render the world and look like success.
    expect((await request("/?seed=1")).status).toBe(404)
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
