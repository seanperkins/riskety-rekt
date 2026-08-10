> Generated: 2026-08-10 | Token-lean format for LLM context

# Jobs (`src/jobs/`) and deployment

Every job takes its clock as a `now: Date` dependency, so tests pin the day
without touching a real clock.

| Job | Cadence | Entry |
|---|---|---|
| `runPublishSlate` | 08:00 daily | `publish-slate.ts` |
| `runPollSettlements` | every 30 min | `poll-settlements.ts` |
| `runPostRecap` | after the tick | `post-recap.ts` — **built, no caller yet** |

## publish-slate

```ts
PublishDeps { store: SlateStore, adapter: MarketAdapter, seasonId, now, log?, announce? }
PublishOutcome = { status: "published", day, count }
               | { status: "skipped", day, reason: SkipReason }
SkipReason = "before-season" | "after-season" | "final-day" | "already-published"
```

Flow: `store.season()` (throws if unknown) → `day = etDaysBetween(startDate, etDate(now))`
→ skip guards → `slatePublished` check → `getCandidates(window)` → `selectSlate`
→ `store.publishSlate` → optional `announce`.

- `day >= lengthDays` skips as `final-day`: day-N wagers escrow at tick N and
  settle at tick N+1, which for the last day never runs.
- `slatePublished` is checked **before** fetching — a double-fired timer should
  neither spend a round trip nor be in a position to see fresher prices. The
  write returning `false` is the second guard, for a lost race.
- An adapter failure **throws and writes nothing**. Recording an empty slate
  burns the day permanently; throwing lets a systemd retry minutes later still
  deliver one. An empty slate is only written after a *successful* fetch that
  yielded nothing eligible.
- `announce` runs only after the slate is persisted, and its failure is logged,
  never thrown — a Slack outage must not cost the day its slate, and a slate
  announced but not stored would be a lie.
- `slate.length < SLATE_MIN` logs and continues.

Running it late in the ET day legitimately publishes nothing. Judge it by an
08:00 run.

## poll-settlements

```ts
PollDeps { store, adapter, seasonId, now, log? }
PollResult { checked, recorded, stillOpen }
```

`marketsAwaitingSettlement(seasonId, now, SETTLEMENT_HORIZON_DAYS)` →
`adapter.getSettlements` → `recordSettlement` for each unambiguous yes/no.

**Never throws.** A Kalshi outage leaves markets unsettled, the next run retries,
and a wager unsettled for two ticks is refunded by the engine. That chain is the
entire reason the 21:00 tick is allowed to be offline.

## post-recap

```ts
PostRecapDeps { poster: Poster, state: GameState, previous: GameState,
                lengthDays, correction?, log? }
```

Deliberately separate from resolution and never called by `resolve()`. Plan 4's
tick runner saves state **first**, then calls this, so a Slack outage can neither
stall nor double-run a tick. `correction` is spread conditionally rather than
passed as `undefined` — `exactOptionalPropertyTypes` is on.

## CLI (`src/jobs/cli.ts`)

```
tsx src/jobs/cli.ts publish-slate | poll-settlements
                    season-init <YYYY-MM-DD> [length]
                    roster-add <slack-user-id> <faction-id> <display name>
                    roster-list
```

Env: `RR_DB_PATH`, `RR_SEASON_ID` (both required; `""` counts as unset).
Exit 0 on success or a deliberate skip, 1 on failure worth a systemd retry.

- **Never call `process.exit()` with the database open** — it skips the `finally`
  block and leaves a WAL file behind on every bad invocation. Set `exitCode`,
  fall through, `store.close()`, then exit.
- `announce` is wired only when `SLACK_BOT_TOKEN` is non-empty, so an
  unconfigured workspace can still publish to the database.
- `onTruncate` prints a WARNING rather than failing: a truncated candidate walk
  still yields a playable slate, but must never pass silently — the first live
  sampling run returned exactly `MAX_PAGES × 1000` markets on seven consecutive
  days and looked entirely like real data.

## Slack bot (`src/slack/cli.ts`)

Long-running. Reads `RR_DB_PATH` plus the four `SLACK_*` variables; any missing
one exits 1 at boot with a single operator-readable line, no stack trace. Env is
loaded **before** the store is opened so a misconfigured service leaves no WAL
file. Calls `app.init()` (deferred in `createSlackApp`) then `app.start(PORT)`,
default 3001. SIGINT/SIGTERM stop the app, close the store, exit 0.

## systemd (`deploy/`)

| Unit | Schedule / mode |
|---|---|
| `riskety-publish-slate.timer` | `OnCalendar=*-*-* 08:00:00` |
| `riskety-publish-slate.service` | `Restart=on-failure`, `RestartSec=300` |
| `riskety-poll-settlements.timer` | `OnCalendar=*:00/30` |
| `riskety-poll-settlements.service` | oneshot |
| `riskety-slack.service` | `Restart=always`, `RestartSec=5`, `Environment=PORT=3001` |

All three read `EnvironmentFile=/etc/riskety-rekt/env`,
`WorkingDirectory=/srv/riskety-rekt`. Full setup in `deploy/README.md`.

Target is a DigitalOcean droplet, **not** App Platform — an ephemeral filesystem
wipes SQLite on every redeploy.

## Open work

Plan 4 (tick runner + web app) still owes:

- Caddy routing `/slack/events` → port 3001. Slack's Event Subscriptions cannot
  be registered until that endpoint answers a public HTTPS `url_verification`
  challenge, so the bot is unusable and its round trip untestable until then.
- The tick runner: `dailyApprovals(store, seasonId, day)` feeds **both**
  `context.approvals` and `context.postedToday`; then `runPostRecap` after the
  state save, in that order.
- `claimTick` for idempotency; `loadState`/`saveState`/`loadOrders`/`saveOrder`.
- Wager locking at `min(close_time, settlements.observed_at)`.
