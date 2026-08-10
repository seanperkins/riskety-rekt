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

  it("ignores a query string rather than 404ing", async () => {
    // The URL is parsed for its pathname; "/?seed=1" must not miss the route.
    expect((await request("/?seed=1")).status).toBe(200)
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
