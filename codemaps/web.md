> Generated: 2026-08-11 | Token-lean format for LLM context

# Web (`src/web/`) — the player app

`node:http`, no framework, no bundler, no build step. Leaflet is the one
client dependency, served from `node_modules` by a two-file allow-list
(`/vendor/leaflet.js`, `/vendor/leaflet.css`) — it never touches the server.
Everything else client-side is hand-written, served from memory (`style.ts`,
`client.ts` inlined). `npm run web`, PORT default 3002.

## Routes (`server.ts`)

| Route | What |
|---|---|
| `GET /` | the board: your plan, countdown, standings. No session → sign-in page (says nothing about the game) |
| `POST /api/plan` | autosave `OrderBody`; 401 no session, 400 malformed, 409 gate-rejected, **422 protect for a veto-off season** |
| `GET /wagers` | today's slate + your stakes. **404 (absent, not hidden) when markets is off** |
| `GET /day/:n` | the night replayed from the day-n log |
| `GET /login/:token` | consumes the magic link (hash compared, single use, 10-min TTL), sets the session cookie |
| `GET /map` | world/board/region inspector (`?factions=&seed=`), 404 on malformed params |

## The security boundary

- **`factionId` never comes from a request.** `sessionFactionFor` (`session.ts`)
  is the only source, and it reads nothing but the session cookie.
- Login tokens are stored **hashed** (`src/auth/token.ts`); the raw value
  exists only in the DM, the URL and the cookie.
- **The page contains only the viewer's projection** (`projection-data.ts`).
  No other faction's deploys, attacks or protect pick is serialized at all —
  absent, not hidden. `board.test.ts` parses the page back out and asserts it.

## Projection (`projection-data.ts`)

`projectionFor({state, day, factionId, plan, wagers, slate, modules, tickAt, now})
→ Projection`. Public: ownership, garrisons, map geometry (shapes, fine shapes,
labels, label boxes, region outlines, off-board backdrop, sea links). Private:
`reserve`, `plan`, `wagers`. **`wagers`/`slate` are ABSENT — optional keys, not
empty — for a markets-off season**, and the wagers panel + nav link vanish with
them; `modules` rides along so the client renders only what is on. `day` is the
ORDER day (state.day + 1); `msToTick`/`locked` drive the countdown.

## Rendering (`render.ts`) and client (`client.ts`)

`renderBoard` / `renderWagers` / `renderDay` / `renderMap`; everything through
`esc()`. The day-replay event switch is **exhaustive** (`assertNever` — a new
`TickEvent` variant fails the build); `move` and `grant` events render. The
client is display-only ("it never validates"); plan edits autosave via
`/api/plan`, Cmd+Z undoes, and the over-budget hint names the seniority rule:
wagers are locked at their market's close, so a short reserve drops deploys.

Map rendering traps (pane stack, LOD shapes, backdrop canvas):
`docs/map-rendering.md`. `src/map/shapes.ts` is GENERATED — edit
`scripts/build-shapes.ts` and `npm run build:shapes`.
