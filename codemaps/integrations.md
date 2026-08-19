> Generated: 2026-08-19 | Token-lean format for LLM context

# Integrations — Kalshi and Slack

The only two places the process speaks to a network, and both are cached to
SQLite well before the midnight tick. Both sides are gated by `season.modules`:
with `markets` off the slate job and both pollers skip (exit 0) without a
network call; with `irl` off the approval flow is never invoked.

## Kalshi (`src/adapters/kalshi/`)

Networking and parsing are split so every test runs offline against
`__fixtures__/candidates-page.json`.

| File | Exports |
|---|---|
| `client.ts` | `getJson`, `getAllMarkets`, `KalshiHttpError`, `ClientOptions`, `FetchLike` |
| `parse.ts` | `parseDecimal`, `questionOf`, `capQuestion`, `seriesOf`, `toCandidate`, `toSettlement`, `DropReason`, `CandidateResult` |
| `index.ts` | `createKalshiAdapter(opts) → MarketAdapter` |
| `raw.ts` | `RawKalshiMarket`, `RawKalshiMarketsResponse` — untrusted wire shapes, all fields optional |

### Client

`ClientOptions { fetchImpl?, sleep?, baseUrl?, maxPages?, onTruncate? }`.
`getJson` sorts query params, sets `AbortSignal.timeout(HTTP_TIMEOUT_MS)`, and
retries `HTTP_RETRIES` times on 429/5xx only — 4xx escapes immediately. The
timeout is load-bearing: a hung TLS handshake with no signal leaves the 08:00
job running until systemd kills it and the day silently gets no slate.

`getAllMarkets` walks the cursor to `MAX_PAGES` (or `opts.maxPages`). A page
without a `markets` array **throws** — quietly truncating surfaces later only
as an inexplicably thin slate. An empty page ends the walk even when a cursor
is returned (Kalshi hands back a cursor on the final page and following it
loops). Hitting the cap fires `onTruncate(pages, collected)`; the CLI prints a
loud WARNING.

### Parsing

`toCandidate(raw, window, volumeFloor)` → `{ ok: true, candidate } | { ok: false, reason }`.

| `DropReason` | Fires when |
|---|---|
| `multivariate` | non-empty `mve_collection_ticker` — combo markets have machine-generated titles |
| `malformed` | empty ticker/title, unparseable `close_time`, or NaN volume or price |
| `bad-ticker` | ticker fails `/^[A-Za-z0-9._-]{1,64}$/` — split out from `malformed` so a validated id reaches `slate_markets`, Slack, and an operator's shell |
| `close-window` | `close_time` **not strictly inside** the window |
| `short-lived` | parseable `open_time` and `close_time - open_time < MIN_MARKET_HOURS` hours (15-min crypto ladders); a missing/unparseable `open_time` does NOT disqualify |
| `volume` | `volume_fp < volumeFloor` |
| `price-range` | either midpoint outside `[PRICE_MIN, PRICE_MAX]` |
| `crossed-book` | `priceYes + priceNo < 1 − 1e-9` |

- `parseDecimal` accepts only `/^-?\d+(\.\d+)?$/`. `Number("")`/`Number(null)`
  are 0, so a missing quote parsed with `Number` becomes a free price of zero.
- `questionOf(title, subtitle)` = `capQuestion(title)` alone unless `subtitle`
  carries digits not already in the title, in which case it appends
  `"$title — $subtitle"` (re-capped). `capQuestion` returns `string | null` —
  whitespace-normalizes, truncates to `QUESTION_MAX_CHARS`, `null` on
  empty/non-string; it **escapes nothing**, each sink owns its own encoding.
- Prices are midpoints of `{yes,no}_{bid,ask}_dollars`, rounded to 1e-6. Not
  cosmetic: `(0.47+0.62)/2 = 0.5449999999999999` sinks below a band edge —
  86 valid combinations were being dropped as crossed books.
- Strict window exclusion drops markets closing at exactly `WINDOW_CLOSE_HOUR`
  (21:00 ET) — that hour is the *slate window*, not the order lock (the lock
  moved to midnight on 2026-08-15 and this deliberately did not follow it).
- `seriesOf("KXSOLE-26AUG1017-B74") === "KXSOLE"`.
- `toSettlement`: `status ∈ {settled, finalized}` **and** `result ∈ {yes, no}`,
  else `unsettled`. Querying `?status=settled` returns markets whose own status
  reads `finalized`.

### Adapter

`getCandidates` fetches `status=open` with `min_close_ts`/`max_close_ts`, maps
every raw row through `toCandidate`, reports drops via `onDrop`, returns sorted
by id. `getSettlements` defaults every requested id to `unsettled`, then queries
in batches of `SETTLEMENT_BATCH_SIZE` keyed by ticker (responses come back in
arbitrary order); a batch that throws is swallowed and stays unsettled. An
omitted market, a timeout and a void result are indistinguishable by design —
the engine refunds after two ticks either way.

`poll-prices` reuses `getCandidates` for the day's slate window and writes
`market_prices` every 30 minutes. The published slate stays frozen — live
prices exist so a wager is priced at PLACEMENT (`order_wagers.price`); re-staking
re-prices.

Slate selection lives in `src/slate/select.ts` (`selectSlate(candidates, max = SLATE_MAX)`):
rank by volume desc (id as tiebreak), **at most one market per series**, then
re-sort by id for storage. One observed window held 2,257 eligible markets
across 44 series, so ranking by volume alone would publish five rungs of one
crypto ladder.

## Slack (`src/slack/`)

Only `app.ts` imports `@slack/bolt` and only `post.ts` imports `@slack/web-api`.
Everything else is pure, which is what keeps the suite offline.

| File | Role |
|---|---|
| `env.ts` | `loadSlackEnv(env)` → `SlackEnv { signingSecret, botToken, teamId, channelId, webUrl }` |
| `app.ts` | `createSlackApp(deps)` — the Bolt Events webhook + `/login`, `/name` commands |
| `events.ts` | `interpretMessage`, `interpretReaction`, `normalizeEmoji` — pure decisions |
| `handlers.ts` | `handleMessageEvent`, `handleReactionEvent` — dedupe, roster lookup, writes |
| `approvals.ts` | `dailyApprovals(store, seasonId, day)` → `{ approvals, postedToday }` |
| `rule-vote.ts` | `tallyRuleVote` (pure), `dailyRuleSelection` — derived at the midnight tick |
| `table.ts` | `table`, `tableLayout`, `fallbackTable`, `truncateCell` — fenced-table renderer shared by recap/slate/offer |
| `recap.ts` | `renderRecap(input)` → `{ text, blocks }`; `ruleIds` renders "Rule in force" |
| `announce.ts` | `renderSlate(day, slate)` → `{ text, blocks }` |
| `offer.ts` | `renderRuleOffer(day, offers, {supersedes})` — the numeral ballot |
| `login.ts` | `handleLoginCommand` — the `/login` slash command → hashed magic link DM |
| `name.ts` | `handleNameCommand` — the `/name` slash command, pure, no season gate |
| `post.ts` | `createPoster(env, client?) → ReactingPoster`, `createDirectory(botToken, client?) → Directory` |
| `text.ts` | `safeText(value, max)` |
| `cli.ts` | the long-running bot; `PORT` default 3001 |

Gate order in `interpretReaction` (events.ts): team → channel → **vote branch**
→ `APPROVAL_EMOJI` filter → roster → self-approval. The vote branch sits before
the emoji filter (which would drop every numeral), does its OWN roster lookup,
and skips the self-approval check — the offer message is bot-authored, so
`item_user` is never a player. `handleReactionEvent` mirrors it: the vote
branch runs before the `postFor`/`unknown-post` gate, because a bot-authored
offer never enters `posts`; it recognizes the day's offer via
`store.offerForMessage(messageTs) → { seasonId, day, ordinals } | undefined`,
then rejects an ordinal not in `offer.ordinals` as `unmapped-numeral` before it
reaches `recordRuleReaction`/`removeRuleReaction`.

`""` and `undefined` are both absent for env vars — a systemd `EnvironmentFile`
line with no value yields `""`, and treating that as present is exactly how a
service boots with signature verification silently disabled. `loadSlackEnv`
also throws if any `NEXT_PUBLIC_*` variable contains
`SECRET`/`TOKEN`/`KEY`/`PASSWORD` (Next.js inlines those into browser JS).
`webUrl` (`RR_WEB_URL`) is required too — the origin `/login`'s link is built
from.

`createSlackApp` refuses to start on an empty signing secret. Bolt verifies
`X-Slack-Signature` and rejects requests older than five minutes
(`requestTimestampMaxDeltaMin`); `signatureVerification` must never be false.
`deferInitialization: true` is mandatory — without it the constructor calls
`auth.test` and every test that builds an app becomes a network test; `cli.ts`
calls `await app.init()` itself. `processBeforeResponse: true` so a throwing
write shows up as a 500 in Slack's own event log. `app.error` logs locally and
never lets exception text reach Slack. `deps.directory` (built by
`createDirectory` in `post.ts`) is injected by the entrypoint, not constructed
in `app.ts`, so the Web API client never enters a test's import graph.

Handlers dedupe on `event_id` **first, including for events that will be
dropped** — Slack redelivers up to three times. The roster is read per event
(six rows) so a player can be added mid-season without a restart.

| `DropReason` | |
|---|---|
| `wrong-team`, `wrong-channel`, `not-on-roster` | scope |
| `not-a-photo` | needs `subtype: file_share`, no `bot_id`, an `image/*` file |
| `thread-reply` | `thread_ts !== ts` — a re-share would post yesterday's workout again |
| `not-a-message`, `not-an-approval`, `self-approval` | reactions |
| `not-an-offer`, `unmapped-numeral` | the vote branch |

`message_deleted` is handled **before** the roster check — the deletion event
carries no user field, and the post it names was already proven ours.
`normalizeEmoji` lowercases and strips `::skin-tone-N`, then maps aliases.

### Approval derivation

`dailyApprovals` reads posts on `etDateAdd(season.startDate, day)`, keeps those
with `postedAt <= tickInstant(season, day)`, and for each takes approvers
excluding the poster's own faction and past the cutoff. The **second**
approver's `reactedAt` becomes `approvedAt`; `eventId` is the post's own
`message_ts` (stable, unlike a reaction's `event_ts`, which moves when an
approval is removed and re-added). `postedToday` is the distinct set of
posting factions, sorted. Everything filters on Slack timestamps, never on
database write time. The self-approval check runs twice — at ingest and again
here — to catch a row written before an alt account was mapped onto the
poster's faction.

### Rendering

Both renderers emit a structural `Block` union (header / divider / section /
context) from `recap.ts` rather than importing `@slack/types`, keeping them off
Bolt's import graph. A section's text is `{ type: "mrkdwn" }` when it holds a
table (fenced ```` ``` ```` block via `table()`) and `{ type: "plain_text" }`
elsewhere — `recap.ts`, `announce.ts`, `offer.ts` build every section through
`table.ts`, not by hand.

`tableLayout(title, headers, rows)` caps row count to `MAX_SECTION_LINES - 1`
(reserving one line for a `"…and N more"` marker), then re-checks the rendered
fence against `MAX_SECTION_CHARS` and drops trailing rows — bumping `dropped`
— until it fits or is empty. `table()` wraps the result as one `mrkdwn`
section; `fallbackTable()` renders the same rows as plain text for the
message's `text` fallback, with `://` neutered to `": / "`. `truncateCell(value,
maxWidth = 200)` grapheme-truncates a cell (East-Asian/emoji code points count
as width 2) and collapses 3+ backticks to one so a cell can never break out of
the code fence.

`renderRecap` sections, each a table: Reinforcements, Protected, Movements,
Field battles, Battles, Markets, Rejected orders, then Standings (and Season
result on the final day). Truncation is visible inside the rendered table
itself. `correction: true` marks a re-run tick visibly instead of posting a
silent second recap.

`renderSlate` renders a `Market`/`YES`/`NO`/`LOCK` table — whole-cent prices
and each market's own close time. Each question cell is truncated to
`MARKET_QUESTION_MAX` (60, `src/config.ts`) display columns so odds and close
stay on-screen — narrower than the general `QUESTION_MAX_CHARS` (200) the text
is already capped to. An empty slate posts "the day runs as plain Risk," no
table.

`renderRuleOffer` renders a `#`/`Rule`/`What it does` table, numbering
candidates 1–9 (`NUMERAL_NAMES`, mirrored by `NUMERAL_EMOJI` in `config.ts`)
and states the vote rules in a trailing context block. A recap renders
`ruleIds` as name + description — an id the catalogue no longer knows renders
bare rather than throwing.

`Poster.post` returns the posted message's `ts`, which is what lets the
offer's claim-then-post ledger map later reactions back to a row.
`createPoster` sets `unfurl_links: false` and `unfurl_media: false` — a Kalshi
preview is fetched live and could reveal an outcome the recap has not stated.
