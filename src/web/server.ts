import { createServer } from "node:http"
import type { Server } from "node:http"
import { MAX_LIVE_TOKENS, hashToken, newToken } from "../auth/token.js"
import { serializeSessionCookie } from "./session.js"
import type {
  AuthStore,
  OrderStore,
  SeasonStore,
  SlateStore,
  StateStore,
} from "../store/types.js"
import { MAX_FACTIONS, MIN_FACTIONS } from "../config.js"
import { COORDS } from "../map/coords.js"
import { selectSubMap } from "../map/select.js"
import { makeRng } from "../rng.js"
import { WORLD } from "../map/world.js"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { currentDay, tickInstant } from "../season.js"
import { projectionFor } from "./projection-data.js"
import { esc, page, renderBoard, renderDay, renderMap, renderRules, renderWagers } from "./render.js"
import { sessionFactionFor } from "./session.js"
import { parseOrderBody } from "../jobs/order-entry.js"

export interface WebDeps {
  port: number
  store: AuthStore & SeasonStore & StateStore & OrderStore & SlateStore
  seasonId: string
  log?: (msg: string) => void
}

/**
 * Leaflet, served from node_modules by an explicit allow-list.
 *
 * An allow-list rather than a directory: serving a folder wholesale is how a
 * path-traversal bug gets in, and there are exactly two files.
 */
const require_ = createRequire(import.meta.url)
const VENDOR: Record<string, { file: string; type: string }> = {
  "/vendor/leaflet.js": { file: "leaflet/dist/leaflet.js", type: "text/javascript; charset=utf-8" },
  "/vendor/leaflet.css": { file: "leaflet/dist/leaflet.css", type: "text/css; charset=utf-8" },
}
const vendorCache = new Map<string, string>()
function vendor(path: string): { body: string; type: string } | undefined {
  const entry = VENDOR[path]
  if (entry === undefined) return undefined
  let body = vendorCache.get(path)
  if (body === undefined) {
    body = readFileSync(require_.resolve(entry.file), "utf8")
    vendorCache.set(path, body)
  }
  return { body, type: entry.type }
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
  "/map": (p) => mapPage(p),
  // Session-free like /map, and for the same reason: it holds no state. It is
  // deliberately NOT linked from the signed-out page, which keeps its property
  // of telling a stranger nothing about the game.
  "/rules": () => renderRules(),
}

/**
 * The board, for a logged-in player.
 *
 * Returns undefined when there is no session, which the caller turns into the
 * sign-in page rather than a default faction — a fallback would hand a stranger
 * somebody else's orders.
 */
function boardPage(deps: WebDeps, faction: string, now: Date): string | undefined {
  const season = deps.store.season(deps.seasonId)
  if (season === undefined) return undefined

  // Orders target the CALENDAR day, exactly as the tick does -- a state-derived
  // clock would shear the moment a tick was missed. But the board shown is the
  // latest state that actually resolved, which is not always day - 1: after a
  // missed tick there is a gap, and assuming day - 1 exists 503s the whole app
  // on the one evening someone most needs to see it.
  const day = Math.max(1, currentDay(season, now))
  const latest = deps.store.latestSavedDay(deps.seasonId)
  if (latest === undefined) return undefined
  const state = deps.store.loadState(deps.seasonId, latest)
  if (state === undefined) return undefined

  const orderRow = deps.store.orderFor(deps.seasonId, day, faction)
  return renderBoard(
    projectionFor({
      state,
      day,
      factionId: faction,
      plan: orderRow ?? { deploys: [], attacks: [], protect: null },
      wagers: deps.store.wagersFor(deps.seasonId, day, faction),
      slate: deps.store.loadSlate(deps.seasonId, day),
      modules: season.modules ?? ["markets", "irl", "veto"],
      tickAt: tickInstant(season, day),
      now,
    }),
  )
}

/**
 * Shown when there is no session. Deliberately says nothing about the game —
 * no faction, no board, no day, not even whether a season is running. A
 * stranger who guesses the URL learns only how to sign in.
 *
 * Two different dead ends land here and only one is fixed by running the
 * command again, so the page names both. Somebody off the roster can run
 * `/login` all day and never get a link; the reply hands them the `roster:add`
 * line instead (`src/slack/login.ts`), and this page is where they find out
 * that is the expected answer rather than a failure.
 *
 * The "ask before it starts" warning is load-bearing, not politeness:
 * `season-init` sizes and deals the board from the roster, so a latecomer owns
 * nothing and earns nothing, permanently. It is phrased WITHOUT naming any
 * game noun — the test's leak list holds this page to that, because copy that
 * explains the rules to a stranger is the slow way to lose the invariant.
 */
function signInPage(): string {
  return page(
    "Riskety Rekt",
    `<div class="rail"><h1 class="title">Riskety&nbsp;Rekt</h1>
     <p class="sub">Run <code>/login</code> in Slack and follow the link it sends you.</p>
     <p class="note">The link is good for ten minutes and works once. Run
       <code>/login</code> as often as you like — your last ${MAX_LIVE_TOKENS} links all
       keep working, so asking for a new one never breaks the one you were about to tap.</p>
     <h2 class="h2">No link came back?</h2>
     <p class="note">Then you are not on the roster yet, and <code>/login</code> replied
       with the one-line command to add you instead. Send that line to whoever runs the
       season — joining is not self-service on purpose.</p>
     <p class="note">Ask <strong>before</strong> a season starts. Everything is handed out
       when it begins, so joining partway through leaves you with nothing to play.</p></div>`,
  )
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

    if (req.method === "POST" && new URL(req.url ?? "/", "http://localhost").pathname === "/api/plan") {
      savePlan(req, res, deps)
      return
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" })
      res.end("method not allowed\n")
      return
    }

    const asset = vendor(path)
    if (asset !== undefined) {
      res.writeHead(200, { "content-type": asset.type, "cache-control": "public, max-age=86400" })
      res.end(req.method === "HEAD" ? undefined : asset.body)
      return
    }

    // Prefix route: the token is a path segment, so it cannot be a key in the
    // exact-match table below.
    if (path.startsWith("/login/")) {
      const season = deps.store.season(deps.seasonId)
      if (season === undefined) {
        // Not a crash: the operator has not run season:init yet, which is the
        // normal state of a workspace between seasons. 503 rather than 500 --
        // the condition clears on its own, and a bare "no season" in plain text
        // reads like a broken server to the player who just clicked a link.
        //
        // The token is NOT consumed. This returns before consumeLoginToken, so
        // the same link still works once the season is dealt.
        res.writeHead(503, { "content-type": "text/html; charset=utf-8" })
        res.end(
          page(
            "No season",
            `<div class="rail"><h1 class="title">The season hasn't started</h1>
          <p class="sub">Your link is still good — open it again once the board is dealt.</p></div>`,
          ),
        )
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

    const now = new Date()
    const faction = sessionFactionFor(req, {
      store: deps.store,
      seasonId: deps.seasonId,
      now,
    })

    if (path === "/") {
      if (faction === undefined) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(req.method === "HEAD" ? undefined : signInPage())
        return
      }
      const html = boardPage(deps, faction, now)
      if (html === undefined) {
        res.writeHead(503, { "content-type": "text/html; charset=utf-8" })
        res.end(page("Not dealt", `<div class="rail"><h1 class="title">No board yet</h1>
          <p class="sub">The season has not been dealt.</p></div>`))
        return
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(req.method === "HEAD" ? undefined : html)
      return
    }

    if (path === "/wagers") {
      // Absent, not hidden: a markets-off season has no wagers page at all.
      const gateSeason = deps.store.season(deps.seasonId)
      if (gateSeason !== undefined && !(gateSeason.modules ?? ["markets"]).includes("markets")) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        res.end("not found\n")
        return
      }
      if (faction === undefined) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(req.method === "HEAD" ? undefined : signInPage())
        return
      }
      const season = deps.store.season(deps.seasonId)
      const day = season === undefined ? 1 : Math.max(1, currentDay(season, now))
      const state = deps.store.loadState(deps.seasonId, day - 1)
      if (season === undefined || state === undefined) {
        res.writeHead(503, { "content-type": "text/html; charset=utf-8" })
        res.end(page("Not dealt", `<div class="rail"><h1 class="title">No board yet</h1></div>`))
        return
      }
      const html = renderWagers(
        projectionFor({
          state,
          day,
          factionId: faction,
          plan: deps.store.orderFor(deps.seasonId, day, faction) ?? {
            deploys: [],
            attacks: [],
            protect: null,
          },
          wagers: deps.store.wagersFor(deps.seasonId, day, faction),
          slate: deps.store.loadSlate(deps.seasonId, day),
          modules: season.modules ?? ["markets", "irl", "veto"],
          tickAt: tickInstant(season, day),
          now,
        }),
        now,
      )
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(req.method === "HEAD" ? undefined : html)
      return
    }

    if (path.startsWith("/day/")) {
      const day = Number(path.slice("/day/".length))
      const after = Number.isSafeInteger(day) && day >= 1
        ? deps.store.loadState(deps.seasonId, day)
        : undefined
      const before = after === undefined ? undefined : deps.store.loadState(deps.seasonId, day - 1)
      if (after === undefined || before === undefined) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" })
        res.end(
          page("No such day", `<div class="rail"><h1 class="title">Nothing happened that day</h1>
            <p class="sub">Day ${esc(path.slice("/day/".length))} has not resolved.</p></div>`),
        )
        return
      }
      const fname = new Map(after.factions.map((f) => [f.id, f.playerName]))
      const tname = new Map(after.map.territories.map((t) => [t.id, t.name]))
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(
        req.method === "HEAD"
          ? undefined
          : renderDay({
              day,
              before,
              after,
              factionName: (id) => fname.get(id) ?? id,
              territoryName: (id) => tname.get(id) ?? id,
            }),
      )
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

/**
 * Save the whole plan. The order body replaces what was there, matching
 * `saveOrder` — the plan IS the order, so there is no merge.
 *
 * `factionId` comes from the session and from nowhere else. The body carries
 * deploys, attacks and protect; a `factionId` in it would simply be ignored by
 * `parseOrderBody`, which rejects unknown fields.
 */
function savePlan(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  deps: WebDeps,
): void {
  const now = new Date()
  const faction = sessionFactionFor(req, { store: deps.store, seasonId: deps.seasonId, now })
  const json = (code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(body))
  }
  if (faction === undefined) return json(401, { ok: false, reason: "not signed in" })

  const season = deps.store.season(deps.seasonId)
  if (season === undefined) return json(503, { ok: false, reason: "no season" })
  const day = Math.max(1, currentDay(season, now))

  let raw = ""
  req.on("data", (c: Buffer) => {
    raw += c
    // A plan is a few hundred bytes. Anything past this is not a plan.
    if (raw.length > 64_000) req.destroy()
  })
  req.on("end", () => {
    let body
    try {
      body = parseOrderBody(raw, {
        territoryCount: deps.store.loadState(deps.seasonId, 0)?.map.territories.length ?? 300,
      })
    } catch (err) {
      return json(400, { ok: false, reason: err instanceof Error ? err.message : "bad plan" })
    }
    // An order field whose module is off is REJECTED with a reason — silent
    // acceptance of a field the engine will ignore is a lost order.
    const modules = season.modules ?? ["markets", "irl", "veto"]
    if (body.protect !== null && !modules.includes("veto")) {
      return json(422, { ok: false, reason: "the veto module is off this season" })
    }
    const out = deps.store.saveOrder(deps.seasonId, day, faction, body, now)
    return json(out.ok ? 200 : 409, out.ok ? { ok: true } : { ok: false, reason: out.reason })
  })
}
