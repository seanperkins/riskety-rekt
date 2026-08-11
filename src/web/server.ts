import { createServer } from "node:http"
import type { Server } from "node:http"
import { hashToken, newToken } from "../auth/token.js"
import { tickInstant } from "../season.js"
import { serializeSessionCookie } from "./session.js"
import type { AuthStore, SeasonStore } from "../store/types.js"
import { MAX_FACTIONS, MIN_FACTIONS } from "../config.js"
import { COORDS } from "../map/coords.js"
import { selectSubMap } from "../map/select.js"
import { makeRng } from "../rng.js"
import { WORLD } from "../map/world.js"
import { esc, page, renderMap } from "./render.js"

export interface WebDeps {
  port: number
  store: AuthStore & SeasonStore
  seasonId: string
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
const ROUTES: Record<string, (params: URLSearchParams) => string | undefined> = {
  "/": (p) => mapPage(p),
  "/map": (p) => mapPage(p),
}

/**
 * Three views over one renderer: the whole world, a dealt board, and either of
 * those narrowed to one region.
 *
 * Returns `undefined` for anything malformed, which the caller turns into a
 * 404. Falling back to the world would silently swallow a typo and show
 * something plausible — the worst outcome for a page whose job is catching
 * mistakes.
 */
function mapPage(params: URLSearchParams): string | undefined {
  const board = readBoard(params)
  if (board === "bad") return undefined

  const base = board === undefined ? WORLD : selectSubMap(WORLD, board.factions, makeRng(board.seed))

  const region = params.get("region")
  if (region !== null) {
    // Checked against the map ACTUALLY on screen, not the world: a region that
    // exists but was not selected onto this board has nothing to show, and
    // silently drawing the world's copy would misrepresent the deal.
    if (!base.regions.some((r) => r.id === region)) return undefined
    return renderMap({ base, focusId: region, ...(board === undefined ? {} : { board }) }, COORDS)
  }
  return renderMap({ base, ...(board === undefined ? {} : { board }) }, COORDS)
}

/**
 * `?factions=` and `?seed=`, or neither. Both are untrusted text.
 *
 * `factions` is bounded by MIN_FACTIONS/MAX_FACTIONS rather than left to
 * selectSubMap, which THROWS on an impossible roster — a 500 where a 404 is
 * owed. The seed is optional and defaults to something stable, so a bare
 * `?factions=11` is a valid link.
 */
function readBoard(params: URLSearchParams): { factions: number; seed: number } | "bad" | undefined {
  const rawFactions = params.get("factions")
  const rawSeed = params.get("seed")
  if (rawFactions === null) return rawSeed === null ? undefined : "bad"

  const factions = Number(rawFactions)
  if (!Number.isSafeInteger(factions) || factions < MIN_FACTIONS || factions > MAX_FACTIONS) {
    return "bad"
  }
  const seed = rawSeed === null ? DEFAULT_SEED : Number(rawSeed)
  if (!Number.isSafeInteger(seed) || seed < 0) return "bad"
  return { factions, seed }
}

/** Stable, so a bare `?factions=11` link always shows the same board. */
const DEFAULT_SEED = 4711

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
    // The URL constructor needs an absolute base to parse against. The path
    // selects the route; the query string is the route's own business.
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" })
      res.end("method not allowed\n")
      return
    }

    // Prefix route: the token is a path segment, so it cannot be a key in the
    // exact-match table below.
    if (path.startsWith("/login/")) {
      const season = deps.store.season(deps.seasonId)
      if (season === undefined) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        res.end("no season\n")
        return
      }
      const now = new Date()
      // The session dies with the season, so nobody is bounced mid-week -- and
      // a faction id means nothing in the next one anyway.
      const seasonEnd = tickInstant(season, season.lengthDays)
      const sessionToken = newToken()

      const faction = deps.store.consumeLoginToken({
        tokenHash: hashToken(path.slice("/login/".length)),
        seasonId: deps.seasonId,
        sessionHash: hashToken(sessionToken),
        sessionExpiresAt: seasonEnd,
        now,
      })

      if (faction === undefined) {
        // Deliberately identical for expired, already-used and never-existed.
        // Distinguishing them tells someone holding a stale link which kind of
        // wrong it is, and helps nobody entitled to be here.
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" })
        res.end(
          page(
            "Link expired",
            `<div class="rail"><h1 class="title">That link is no longer good</h1>
             <p class="sub">Links last ten minutes and work once.
             Run <code>/login</code> in Slack for a fresh one.</p></div>`,
          ),
        )
        return
      }

      log(`login: session created for ${faction}`)
      // 303 rather than 200, so refreshing the landing page does not re-submit
      // a token that has already been consumed.
      res.writeHead(303, {
        location: "/",
        "set-cookie": serializeSessionCookie(sessionToken, seasonEnd),
      })
      res.end()
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
      const html = handler(url.searchParams)
      if (html === undefined) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" })
        res.end(
          page(
            "Not found",
            `<div class="rail"><h1 class="title">Not found</h1>
        <p class="sub">No region <code>${esc(url.searchParams.get("region"))}</code>.
        <a href="/map">Whole world</a>.</p></div>`,
          ),
        )
        return
      }
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
