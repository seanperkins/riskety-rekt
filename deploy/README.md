# Deployment — market jobs and the Slack bot

Two timers and one long-running service, all on a single DigitalOcean droplet
alongside the SQLite file.

## Environment

`/etc/riskety-rekt/env`, mode 0600, owned by root, outside the repo tree:

```
TZ=America/New_York
RR_DB_PATH=/srv/riskety-rekt/data/riskety.db
RR_SEASON_ID=season-1
```

`TZ` matters. systemd `OnCalendar` resolves against the system timezone, and
`08:00:00` must mean 08:00 in New York or the slate is snapshotted at the wrong
hour for half the year. (The application's own date arithmetic is pinned to
America/New_York regardless — see `src/time.ts` — but the timer firing is not.)

Kalshi's public market-data endpoints need no credentials. The Slack bot does —
see "The Slack bot" below for the four variables it adds to this same file.

No variable in this file may begin with `NEXT_PUBLIC_`. Next.js inlines those
into the browser bundle; `loadSlackEnv` asserts it at boot and refuses to start.

## Install

```bash
sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now riskety-publish-slate.timer riskety-poll-settlements.timer
systemctl list-timers 'riskety-*'
```

## Start a season

```bash
sudo -u riskety RR_DB_PATH=... RR_SEASON_ID=season-1 npm run season:init -- 2026-09-01
```

The date is the **day-0 deal date**. Tick 1 runs the following day, and the
first slate is published on the morning of day 1.

## Operating notes

- Both jobs are idempotent. Running them by hand is safe.
- `publish-slate` refuses to overwrite a published slate, and checks that
  before it fetches. This is deliberate — a rerun at 20:00 would otherwise
  re-snapshot prices on the afternoon's information.
- A failed publish records nothing, so the `RestartSec=300` retry can still
  deliver a slate. Only a successful fetch that yields no eligible market
  writes an empty slate, and that day runs as plain Risk.
- The poller never fails the unit. A Kalshi outage leaves markets unsettled,
  the next run retries, and the engine refunds a wager unsettled for two ticks.
- Watch for `WARNING: stopped at the N-page cap`. It means the candidate walk
  was truncated and the day's slate was chosen from an incomplete set. Raise
  `MAX_PAGES` in `src/config.ts` if it recurs.
- `journalctl -u riskety-publish-slate.service -n 50`

## Running the jobs by hand

```bash
export RR_DB_PATH=/srv/riskety-rekt/data/riskety.db RR_SEASON_ID=season-1
npm run publish-slate
npm run poll-settlements
```

Exit 0 means success or a deliberate skip; exit 1 means a failure worth
retrying. Note that a `publish-slate` run late in the ET day legitimately finds
nothing: markets closing inside the 09:00–21:00 window have already closed, and
markets closing at exactly 21:00 are excluded by spec. Judge the job by an
08:00 run, not an evening one.

## The Slack bot

A long-running service, not a timer. Slack retries a failed event delivery three
times over about half an hour and then gives up, so downtime is silently missed
approvals.

### Slack app configuration

Create the app at api.slack.com/apps with these bot scopes:

| Scope | Why |
|---|---|
| `channels:history` | read `message` events in the public game channel |
| `reactions:read` | read `reaction_added` / `reaction_removed` |
| `chat:write` | post the slate and the recap |

Subscribe to these bot events: `message.channels`, `reaction_added`,
`reaction_removed`. Point the Request URL at `https://<host>/slack/events` —
Bolt's default path.

**Event Subscriptions can only be saved once that endpoint is live.** Slack
POSTs a `url_verification` challenge when the URL is entered and refuses to save
if nothing answers. Bolt handles the challenge itself, but the service has to be
running and reachable over public HTTPS first — Tailscale is not enough. Do the
rest of the app setup ahead of time; this step waits for the droplet and Caddy.

**Invite the bot to the channel.** Slack sends `message.channels` only for
channels the app is a member of, and there is no error if it is not: approvals
simply never arrive.

### Environment

Added to `/etc/riskety-rekt/env` (mode 0600):

```
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_TEAM_ID=T01ABCDEF
SLACK_CHANNEL_ID=C01ABCDEF
```

The service refuses to start if any is missing **or empty** — a blank line in an
EnvironmentFile yields `""`, and treating that as present is how a bot boots
with signature verification effectively disabled. It exits 1 with a single
explanatory line and never opens the database, so a misconfigured service leaves
no WAL file behind.

Once `SLACK_BOT_TOKEN` is set, `publish-slate` also announces the slate to the
channel. Leave it unset to publish to the database only.

### Seed the roster

Slack user ids are opaque. Read one from a player's profile → "Copy member ID".

```bash
export RR_DB_PATH=/srv/riskety-rekt/data/riskety.db RR_SEASON_ID=season-1
npm run roster:add -- U01ABCDEF f1 "Ada L."
npm run roster:list
```

A faction may map to exactly one Slack user. A second attempt fails on the
unique constraint — which is the point: a player with two mapped accounts could
approve their own post, since the self-approval check keys on faction id.

### Install

```bash
sudo cp deploy/riskety-slack.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now riskety-slack
journalctl -u riskety-slack -f
```

Caddy needs to route `/slack/events` to port 3001.

### Operating notes

- **Verify the round trip before the season starts.** Post a photo in the
  channel, react twice from two other accounts, then check the database:

  ```bash
  sqlite3 /srv/riskety-rekt/data/riskety.db \
    "SELECT p.faction_id, p.et_date, COUNT(r.faction_id) FROM posts p
       LEFT JOIN reactions r ON r.message_ts = p.message_ts
      WHERE p.deleted = 0 GROUP BY p.message_ts;"
  ```

  Two reactions from distinct factions on a live post is an approved action.

- **Only top-level photo posts count.** A `file_share` message carrying at least
  one `image/*` file, not in a thread. A photo re-shared into a thread is
  ignored on purpose, so yesterday's workout cannot be posted twice.

- **A retried event is not an error.** Slack redelivers when an ack is slow; the
  `slack_events` table absorbs it. Dropped events are recorded as seen too, so
  three retries of the same DM do not re-run the scope checks all day.

- **Approvals are read by Slack timestamp, never by write time.** A reaction at
  20:59:59 delivered at 21:00:01 still counts for that day. Do not "fix" a
  seemingly late row.

- **Deleting a photo retracts the action**, including its approvals and the
  poster's elimination veto for that day.

- `journalctl -u riskety-slack -n 50`
