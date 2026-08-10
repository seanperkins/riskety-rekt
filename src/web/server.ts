import { createServer } from "node:http"
import type { Server } from "node:http"
import { COORDS } from "../map/coords.js"
import { WORLD } from "../map/world.js"
import { esc, page, renderMap } from "./render.js"

export interface WebDeps {
  port: number
  log?: (msg: string) => void
}

/**
 * Route table. A plain object rather than a router: there are two routes, and a
 * dependency that resolves patterns would be more machinery than the problem
 * has.
 *
 * Every handler returns a complete HTML string. Nothing here touches the
 * database yet — when it does, it must stay on this side of the process, since
 * the store is the one thing a bundler would break.
 */
const ROUTES: Record<string, () => string> = {
  "/": () => renderMap(WORLD, COORDS),
  "/map": () => renderMap(WORLD, COORDS),
}

/**
 * The web app.
 *
 * Returns the server without listening, so tests can drive it on an ephemeral
 * port and close it deterministically — the same reason the jobs take `now` as
 * an argument rather than reading a clock.
 */
export function createWebServer(deps: WebDeps): Server {
  const log = deps.log ?? (() => {})

  return createServer((req, res) => {
    // Only the path matters; a query string or a fragment must not turn "/" into
    // a 404, and the URL constructor needs an absolute base to parse against.
    const path = new URL(req.url ?? "/", "http://localhost").pathname

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" })
      res.end("method not allowed\n")
      return
    }

    const handler = ROUTES[path]
    if (handler === undefined) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" })
      res.end(page("Not found", `<div class="rail"><h1 class="title">Not found</h1>
        <p class="sub">No page at <code>${esc(path)}</code>.</p></div>`))
      return
    }

    try {
      const html = handler()
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // The map is derived from committed data, so it is identical until the
        // process restarts. No-store keeps a stale board off the screen while
        // the world is still being authored.
        "cache-control": "no-store",
      })
      // HEAD must send the headers and no body, or a health check hangs.
      res.end(req.method === "HEAD" ? undefined : html)
    } catch (err) {
      log(`500 ${path}: ${err instanceof Error ? err.stack : String(err)}`)
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      res.end("internal error\n")
    }
  })
}
