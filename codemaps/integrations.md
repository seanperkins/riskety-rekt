> Generated: 2026-08-11 | Token-lean format for LLM context

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
| `parse.ts` | `toCandidate`, `toSettlement`, `parseDecimal`, `capQuestion`, `seriesOf`, `DropReason`, `CandidateResult` |
| `index.ts` | `createKalshiAdapter(opts) → MarketAdapter` |
| `raw.ts` | `RawKalshiMarket`, `RawKalshiMarketsResponse` — untrusted wire shapes, all fields optional |

### Client

```ts
ClientOptions { fetchImpl?, sleep?, baseUrl?, maxPages?, onTruncate? }
```

`getJson` sorts query params, sets `AbortSignal.timeout(HTTP_TIMEOUT_MS)`, and
retries `HTTP_RETRIES` times on 429/5xx only — 4xx escapes immediately. The
timeout is load-bearing: a hung TLS handshake with no signal leaves the 08:00 job
running until systemd kills it and the day silently gets no slate.

`getAllMarkets` walks the cursor to `MAX_PAGES`. A page without a `markets` array
**throws** — quietly truncating surfaces later only as an inexplicably thin
slate. An empty page ends the walk even when a cursor is returned (Kalshi hands
back a cursor on the final page and following it loops). Hitting the cap fires
`onTruncate(pages, collected)`; the CLI prints a loud WARNING.

### Parsing

`toCandidate(raw, window, volumeFloor)` → `{ ok: true, candidate } | { ok: false, reason }`.

| `DropReason` | Fires when |
|---|---|
| `multivariate` | non-empty `mve_collection_ticker` — combo markets have machine-generated titles |
| `malformed` | bad ticker/title/`close_time`, or NaN volume or price |
| `close-window` | `close_time` **not strictly inside** the window |
| `volume` | `volume_fp < volumeFloor` |
| `price-range` | either midpoint outside `[PRICE_MIN, PRICE_MAX]` |
| `crossed-book` | `priceYes + priceNo < 1 − 1e-9` |

- `parseDecimal` accepts only `/^-?\d+(\.\d+)?$/`. `Number("")` and `Number(null)`
  are 0, so a missing quote parsed with `Number` becomes a free price of zero.
- Prices are midpoints of `{yes,no}_{bid,ask}_dollars`, rounded to 1e-6. Not
  cosmetic: `(0.47+0.62)/2 = 0.5449999999999999` sinks below a band edge and
  makes a normal book's mids sum below 1 — 86 valid combinations were being
  dropped as crossed books.
- A crossed book would make the both-sides hedge pay more than the 10% house bonus.
- Strict window exclusion drops markets closing at exactly 21:00 ET — one live
  check removed 2,440 of them, since that is Kalshi's standard daily close.
  Kalshi's `min_close_ts`/`max_close_ts` are inclusive, so the parser re-checks.
- `capQuestion` normalizes whitespace and truncates; it deliberately **escapes
  nothing** — each sink (Block Kit `plain_text`, JSX, SVG) owns its own encoding.
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
prices exist so a wager is priced at PLACEMENT (`order_wagers.price`), which is
the stale-price fix; re-staking re-prices.

Slate selection lives in `src/slate/select.ts`: rank by volume desc (id as
tiebreak), **at most one market per series**, then re-sort by id for storage. One
observed window held 2,257 eligible markets across 44 series, so ranking by
volume alone publishes five rungs of one crypto ladder. Volume decides what is
chosen; id decides how it is written down.

## Slack (`src/slack/`)

Only `app.ts` imports Bolt and only `post.ts` imports `@slack/web-api`.
Everything else is pure, which is what keeps the suite offline.

| File | Role |
|---|---|
| `env.ts` | `loadSlackEnv(env)` → `SlackEnv { signingSecret, botToken, teamId, channelId }` |
| `app.ts` | `createSlackApp(deps)` — the Bolt Events webhook |
| `events.ts` | `interpretMessage`, `interpretReaction`, `normalizeEmoji` — pure decisions |
| `handlers.ts` | `handleMessageEvent`, `handleReactionEvent` — dedupe, roster lookup, writes |
| `approvals.ts` | `dailyApprovals(store, seasonId, day)` → `{ approvals, postedToday }` |
| `recap.ts` | `renderRecap(input)` → `{ text, blocks }`; `ruleIds` renders "Rule in force" |
| `announce.ts` | `renderSlate(day, slate)` → `{ text, blocks }` |
| `offer.ts` | `renderRuleOffer(day, offers, {supersedes})` — the numeral ballot |
| `rule-vote.ts` | `tallyRuleVote` (pure), `dailyRuleSelection` — derived at the midnight tick |
| `login.ts` | the `/login` slash command → hashed magic link DM (web session entry) |
| `post.ts` | `createPoster(env, client?)` → `Poster` |
| `text.ts` | `safeText(value, max)` |
| `cli.ts` | the long-running bot; `PORT` default 3001 |

Gate order in `interpretReaction` (events.ts): team → channel → **vote branch**
→ `APPROVAL_EMOJI` filter → roster → self-approval. The vote branch sits before
the emoji filter (which would drop every numeral), does its OWN roster lookup
(the shipped order puts roster after that filter), and deliberately skips the
self-approval check — the offer message is bot-authored, so `item_user` is
never a player. `handleReactionEvent` mirrors it: the vote branch runs before
the `postFor` gate, because a bot-authored offer never enters `posts`; it
recognizes the day's offer by its stored `ts` via `offerForMessage`. An
ordinal with no offer row is dropped at ingest, never stored.

### Env

`""` and `undefined` are both absent — a systemd `EnvironmentFile` line with no
value yields `""`, and treating that as present is exactly how a service boots
with signature verification silently disabled. `loadSlackEnv` also throws if any
`NEXT_PUBLIC_*` variable contains `SECRET`/`TOKEN`/`KEY`/`PASSWORD`, because
Next.js inlines those into browser JavaScript.

### Ingress

`createSlackApp` refuses to start on an empty signing secret. Bolt verifies
`X-Slack-Signature` and rejects requests older than five minutes
(`requestTimestampMaxDeltaMin`); `signatureVerification` must never be set false.
`deferInitialization: true` is mandatory — without it the constructor calls
`auth.test` and every test that builds an app becomes a network test; `cli.ts`
calls `await app.init()` itself. `processBeforeResponse: true` so a throwing
write shows up as a 500 in Slack's own event log. `app.error` logs locally and
never lets exception text reach Slack.

Handlers dedupe on `event_id` **first, including for events that will be
dropped** — Slack redelivers up to three times and re-running scope checks buys
nothing. The roster is read per event (six rows) so a player can be added
mid-season without a restart.

| `DropReason` | |
|---|---|
| `wrong-team`, `wrong-channel`, `not-on-roster` | scope |
| `not-a-photo` | needs `subtype: file_share`, no `bot_id`, an `image/*` file |
| `thread-reply` | `thread_ts !== ts` — a re-share would post yesterday's workout again |
| `not-a-message`, `not-an-approval`, `self-approval` | reactions |

`message_deleted` is handled **before** the roster check — the deletion event
carries no user field, and the post it names was already proven ours.
`normalizeEmoji` lowercases and strips `::skin-tone-N`, then maps aliases; without
it a player with a skin tone set never approves anything.

### Approval derivation

`dailyApprovals` reads posts on `etDateAdd(season.startDate, day)`, keeps those
with `postedAt <= tickInstant(season, day)` (midnight ending the day, so the
cutoff and the ET date `postsOn` selects describe the same window), and for
each takes approvers
excluding the poster's own faction and past the cutoff. The **second** approver's
`reactedAt` becomes `approvedAt`; `eventId` is the post's own `message_ts` (stable,
unlike a reaction's `event_ts`, which moves when an approval is removed and
re-added). `postedToday` is the distinct set of posting factions, sorted.

Everything filters on Slack timestamps, never on database write time: a reaction
at 23:59:59 delivered at 00:00:01 must still count, or an eliminated player's
veto silently evaporates.

The self-approval check runs twice — at ingest and again here — to catch a row
written before an alt account was mapped onto the poster's faction.

### Rendering

Both renderers emit a structural `Block` union (header / divider / section /
context) rather than importing `@slack/types`, keeping them off Bolt's import
graph. `renderRecap` sections: Reinforcements, Protected, Field battles, Battles,
then standings. Sections truncate at `MAX_SECTION_LINES` / `MAX_SECTION_CHARS`
and **announce the truncation** — a recap that silently dropped half the day's
battles reads exactly like a quiet day. `correction: true` marks a re-run tick
visibly instead of posting a silent second recap.

`renderSlate` shows whole-cent prices and each market's own close time, because
wagers lock per-market at that close, not at midnight. An empty slate posts "the day
runs as plain Risk."

`renderRuleOffer` numbers candidates `:one:`…`:nine:` and states the vote rules
in the message itself (latest reaction counts, remove to un-vote, tally at midnight).
A recap renders `ruleIds` as name + description — an id the catalogue no longer
knows renders bare rather than throwing, so frozen history outlives an edit.

`Poster.post` returns the posted message's `ts`, which is what lets the offer's
claim-then-post ledger map later reactions back to a row.

`createPoster` sets `unfurl_links: false` and `unfurl_media: false` — a Kalshi
preview is fetched live and could reveal an outcome the recap has not stated.
