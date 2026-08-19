> Generated: 2026-08-19 | Token-lean format for LLM context

# Web (`src/web/`) — the player app

`node:http`, no framework, no bundler, no build step (`tsx` runs TypeScript
directly — required for `node:sqlite`, see `CLAUDE.md`). Leaflet is the one
client dependency, served from `node_modules` by a two-file allow-list
(`/vendor/leaflet.js`, `/vendor/leaflet.css` in `server.ts`'s `VENDOR` table)
— it never touches the server otherwise. Everything else client-side is
hand-written and served from memory: `style.ts` (`STYLE`), `client.ts`
(`CLIENT`), `replay.ts` (`REPLAY`) are template-string module exports inlined
by `render.ts`. `npm run web` (`cli.ts`), `PORT` default 3002 (Slack bot holds
3001). Needs `RR_DB_PATH` and `RR_SEASON_ID`.

## Routes (`server.ts`)

| Route | What |
|---|---|
| `GET /` | landing page for EVERYONE, signed in or not (`renderLanding`); reads no store, no session, dealt at render time from a constant seed |
| `GET /game` | the board: your plan, countdown, standings. No session → 303 to `/` |
| `POST /api/plan` | autosave `OrderBody`; 401 no session, 503 no season, 400 malformed, 409 gate-rejected, 422 `protect` on a veto-off season |
| `POST /api/wager` | place/change one wager; 401 no session, 503 no season, 422 markets-off, 400 malformed/not-exactly-one, 422 not on today's slate, 409 store refusal |
| `POST /api/name` | change display name; 401 no session, 409 no roster row, 400 bad json/empty/too-long |
| `GET/HEAD /api/day` | JSON `{resolved}` — `latestSavedDay`; no session needed, discloses one integer the recap posts to Slack anyway |
| `GET /day/:n` | the night replayed from day n's log (`renderReplay`); 404 if state for `n` or `n-1` is missing |
| `GET /login/:token` | consumes the magic link (hash compared, single use, TTL to season end), sets session cookie, 303 → `/game`; 503 if no season (token NOT consumed), 401 if expired/used/unknown (indistinguishable) |
| `GET /map` | world/board/region inspector (`?factions=&seed=&region=`), session-free, reads no store; 404 on malformed params or unknown region |
| `GET /rules` | static rules page (`renderRules`), session-free, reads no season |

Note: there is no separate `/wagers` route — the wagers panel lives inside the
`/game` board page, driven by `Projection.wagers`/`.slate` (absent, not
empty, when the markets module is off).

## The security boundary

- **`factionId` never comes from a request.** `sessionFactionFor` (`session.ts`)
  is the ONLY source: it reads nothing but the `rr_session` cookie (via
  `parseCookies`, first-`=`-only split) — no body, no query string, no other
  cookie. Returns `undefined` rather than a default faction.
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax` (Lax so a Slack-origin
  link still works; a cross-site POST still can't forge an order).
- Login/session tokens are 32 random bytes, base64url (`auth/token.ts`,
  `newToken`), stored **hashed** — SHA-256 hex, no salt, no work factor (a
  32-byte random value has nothing to brute-force). Lookup is by hash against
  a primary key, so no constant-time compare is needed. `MAX_LIVE_TOKENS = 5`
  live login tokens per person; minting a sixth evicts the oldest.
- **The page contains only the viewer's projection** (`projection-data.ts`).
  No other faction's deploys, attacks or protect pick is serialized anywhere
  in the page — absent, not hidden. `board.test.ts` ("contains NO other
  faction's plan, anywhere in the rendered page") parses the page back out and
  asserts it, including on the eliminated-faction path where a foreign
  `protect` matters most (legal only for an eliminated faction, so leaking it
  discloses who is about to go out).

## Projection — two shapes, one boundary

Both are built from `staticBoard(map)` (`projection-data.ts`): territories,
regions, shapes/`shapesFine`, centres, labels, `labelBoxes`, `regionOutlines`,
`offBoard`, `seaLinks` — identical geometry payload either way.

**Board projection** (`/game`) — `projectionFor({state, day, factionId, plan,
wagers, slate, modules, tickAt, now, names}) → Projection`. Adds: `ownership`,
`garrisons` (public), `reserve`, `income`, `plan` (viewer's own — private),
`wagers?`/`slate?` (present only if `modules` includes `"markets"`, via
conditional spread, not `undefined` — `exactOptionalPropertyTypes`), `modules`,
`msToTick`/`locked` (countdown), `resolvedDay` (the state's own day, distinct
from `day` = the order day = `state.day + 1`, since the board being shown
already resolved but orders target the night ahead).

**Replay projection** (`/day/:n`) — `replayFor({before, after, names}) →
Replay extends StaticBoard`. Adds: `Beat[]` narration built server-side (an
exhaustive switch over `TickEvent` with `assertNever`, so a new engine event
variant fails the build instead of silently not animating) and `BankRow[]`
(collected soldier-arrival events). No `factionId`, `plan`, `reserve`, or
`wagers` — a replay is public history, not a viewer's private state; payouts
bank under `e.faction`/`MARKETS` (`"—"`), never under `markets`, so no other
player's wager is named. `move` and `grant` events render like every other
kind — no gap in the switch.

## Rendering (`render.ts`)

Every page is a pure function of data → HTML string (`page`, `esc` — HTML-
escape applied to every interpolated value, no untrusted/trusted split).
Exports: `renderBoard(Projection)`, `renderReplay(Replay)`, `renderMap(MapView,
coords)`, `renderRules()`; `render.ts` imports `CLIENT` from `client.ts` and
`REPLAY` from `replay.ts` and inlines them as `<script>` bodies.

## Client — TWO separate clients

`/game` (`client.ts`, `CLIENT`) and `/day/:n` (`replay.ts`, `REPLAY`) are
**separate, independently-built strings** — the replay is not the board client
reused with a flag. The board client **never validates**: it shows the reserve
and what the plan spends, but legality belongs to the engine; a pre-validating
client would drift and lie silently. Plan edits autosave via `/api/plan`,
Cmd+Z undoes.

Load-bearing map facts (both clients build their own `L.map`):

- **`doubleClickZoom: false`** (`client.ts`). Correctness fix, not preference:
  the board's whole gesture is tap-territory-tap-again-to-deploy, so two fast
  taps are normal and also a double click; Leaflet's dblclick zoom is on the
  container and the polygon click handler doesn't stop it, so a fast pair used
  to deploy a soldier *and* fly the map. The +/-, wheel, keyboard, and
  clicking a player still zoom.
- **`FINE_FROM_ZOOM = 5`** (`client.ts`): `updateDetail()` swaps `P.shapes` →
  `P.shapesFine` once `map.getZoom() >= 5`, and back below it.
- **`zoomSnap: 0` for the opening `fitBounds`, then restored** (`client.ts`).
  0 lets the initial fit land on a fractional zoom (took the board from ~54%
  to ~88% of the frame); kept forever it costs a full animated zoom cycle per
  wheel notch (trackpad's continuous stream restarts the animation every few
  ms). After the opening `fitBounds`/`setView`, `map.options.zoomSnap` is set
  back to `0.25` (or `?zoomsnap=`) so wheel/keyboard land on discrete steps.
  `replay.ts` uses a plain `zoomSnap: 0, zoomDelta: 0.5` throughout (no
  restore) since its `fitBounds` is one-shot on load.
- **`paint()` tags each polygon with `dataset.territory`** (`client.ts`,
  `replay.ts` has its own simpler `paint()` without the tag). Leaflet gives a
  polygon path no DOM identity otherwise. Done in `paint()`, not at layer
  creation, because `getElement()` returns `undefined` until the layer is
  added and the renderer has built its path; `paint()` runs after the opening
  fit so the element always exists. `dataset` not `className`: a zoom does not
  touch a path's class list, but *assigning* `className` clobbers Leaflet's
  own classes (the `paintCounts` bug, which broke marker repositioning by
  wiping `leaflet-zoom-animated`).

Map rendering traps (pane stack, LOD shapes, backdrop canvas): see
`docs/map-rendering.md`. `src/map/shapes.ts` and `src/map/adjacency.ts` are
GENERATED — edit `scripts/build-shapes.ts` and run `npm run build:shapes`;
never hand-edit.
