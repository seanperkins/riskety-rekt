# Deployment — market jobs and the Slack bot

Six timers and two long-running services, all on a single DigitalOcean droplet
alongside the SQLite file.

## The live droplet

| | |
|---|---|
| Host | `riskety.com` (`www` 301s to the apex) |
| Droplet | `riskety-rekt`, nyc3, s-1vcpu-1gb, `45.55.240.159` |
| DNS | Registered at Namecheap, **nameservers delegated to DigitalOcean** — records live in the DO zone, so `doctl compute domain records` changes them and the registrar holds only the delegation |
| TLS | Let's Encrypt via Caddy, auto-renewing |
| Access | `ssh -i ~/.ssh/digitalocean root@45.55.240.159`. **The key must be named**, or ssh offers the default identities, none of which the droplet accepts, and the only symptom is `Permission denied (publickey)` |

Provisioned from `cloud-init.yaml` (the machine) and `bootstrap.sh` (the
deployment). **`bootstrap.sh` is also the upgrade path** — rerunning it pulls
`origin/main`, reinstalls, reloads units and restarts services, and never
touches the database or `/etc/riskety-rekt/env`:

```bash
ssh -i ~/.ssh/digitalocean root@45.55.240.159 'bash -s' < deploy/bootstrap.sh
```

Worth doing once, so the `-i` stops being something to remember. Keyed on the
ADDRESS rather than an alias, which is what makes the bare `ssh root@45.55.240.159`
elsewhere in this file work as written — an alias would only apply to `ssh riskety`:

```
# ~/.ssh/config
Host 45.55.240.159
  User root
  IdentityFile ~/.ssh/digitalocean
  IdentitiesOnly yes
```

`s-1vcpu-1gb` is 1 GB, so cloud-init provisions 2 GB of swap. The process that
must never be OOM-killed is the midnight tick.

**Ports 3001 and 3002 are not reachable from outside.** ufw allows 22, 80 and
443 only; Caddy proxies to the services over loopback. This is load-bearing
rather than tidy: session cookies are `Secure`, and a service answering on plain
HTTP would be a way to reach the app with the cookie silently dropped.

### Still to do before a season

0. **Get the code onto `origin/main`.** `bootstrap.sh` does
   `git reset --hard origin/main`, so that branch is the deploy artifact and
   nothing else is reachable from the droplet. There is no CI, so `npm test`
   and `npm run typecheck` locally are the only gate.
1. **Fill in `SLACK_*` in `/etc/riskety-rekt/env`** (mode 0600). `bootstrap.sh`
   deliberately leaves `riskety-slack` stopped while they are blank rather than
   letting it restart-loop, and re-running it starts the service once they are
   set.
2. **Point the Slack app at `https://riskety.com/slack/events`** and re-verify.
   Slack sends a live challenge and will not save the URL until the endpoint
   answers — which it now does.
3. **Seed the roster, then `season:init`.** In that order; `season:init` deals
   from the roster and refuses an empty one.

DNS TTL is 300 while the address settles. Raise it once the droplet is stable.

## Environment

`/etc/riskety-rekt/env`, mode 0600, owned by root, outside the repo tree:

```
TZ=America/New_York
RR_DB_PATH=/srv/riskety-rekt/data/riskety.db
RR_SEASON_ID=season-1
RR_WEB_URL=https://rr.example.com
```

`RR_WEB_URL` is the public origin of the web app, with **no trailing slash** —
the Slack bot builds `/login` links from it. Get it wrong and every magic link
404s.

The web app reads `RR_DB_PATH` and `RR_SEASON_ID` like the jobs, and listens on
`PORT` (default 3002; the Slack bot holds 3001).

**Session cookies are `Secure`, so the app does not work over plain HTTP.**
Caddy terminates TLS in production; a local run works because browsers exempt
`localhost`.

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
sudo systemctl enable --now riskety-publish-slate.timer riskety-publish-rules.timer \
  riskety-poll-settlements.timer \
  riskety-poll-prices.timer riskety-tick.timer
sudo systemctl enable --now riskety-slack.service riskety-web.service
systemctl list-timers 'riskety-*'
```

## Start a season

```bash
# The roster comes first -- season:init deals from it and refuses an empty one.
sudo -u riskety npm run roster:add -- U01ABCDEF f1 "Ada L."
# ... one per player, then:
sudo -u riskety npm run season:init -- 2026-09-01 --seed 4711
```

`season-init` deals day 0 in one transaction and records the shuffle seed, so the
board is reproducible from the arguments alone. It **refuses** rather than
overwriting if the season already exists: `start_date` is what every day in the
system is derived from, so a second init would shift the calendar under a live
season and change which day every saved state belongs to.

It also refuses a roster outside `[4, 15]` factions, or a board outside 5-11
territories per faction. A 15-member roster on the default 42-territory map is
2.8 each and is correctly refused -- the larger map is not built yet.

## The tick

`riskety-tick.timer` fires at **00:05:30**, and both offsets are load-bearing.

The five minutes are Slack delivery grace. The cutoff is frozen at exactly
00:00:00 by `tickInstant()` and does NOT move with the timer, so a workout
posted at 23:59:58 and delivered at 00:00:03 still lands before the tick's
transaction reads, and still belongs to the day that just closed.

The `:30` is the older reason. The settlement poller runs at `*:00/30`, and the
offset keeps the tick clear of its firing instant -- the poller's writes are
transactional, so this is the second layer rather than the only one.

**Deploy order is directional.** New code with a stale 21:00 timer is a harmless
no-op: it computes yesterday, sees `already-run`, skips, and the day resolves at
the next 00:05. The 00:05 timer with OLD code stalls the season -- it computes
today, hits `before-cutoff`, skips, and there is no 21:00 run left to catch it.

The tick's claim, resolve and save are one transaction. A crash therefore leaves
nothing behind and the next run starts clean; a concurrent second run blocks,
then sees the state row and returns `already-run`.

**Refusals and skips both exit 0.** A refusal ("day 7 never ticked") is a
deliberate stop whose condition does not clear with time -- exiting non-zero
would restart-loop every 60s all night under `Restart=on-failure`. Watch for
them in the journal, not in the exit status:

**Exit 2 is final**, enforced by `RestartPreventExitStatus=2` on every retrying
unit. `Restart=on-failure` restarts on any non-zero status, so an operator
mistake used to loop exactly like a disk error: an `RR_SEASON_ID` naming a
season that was never initialized restart-looped the tick 778 times on this
droplet before anyone read the journal. If a unit exits 2, fix the
configuration -- retrying will never help.

```bash
journalctl -u riskety-tick.service -n 50
```

Recovery is `npm run tick:rerun -- <day> --confirm`, which replays every day from
`<day>` through yesterday against each one's recorded `tick_context` and posts a
correction recap for each. Without `--confirm` it prints the day list and does
nothing. A day that never ticked has no recorded context and needs
`--assemble-missing`, which builds one from the live tables -- accurate for
orders, approximate for approvals, since a deleted photo cannot be recovered.

If a recap failed to post but the day resolved fine, use
`npm run recap -- <day> --force`: the ledger suppresses a plain re-run, and
`--force` records a new attempt.

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
| `chat:write` | post the slate, the recap, and the daily rule offer |
| `commands` | the `/login` and `/name` slash commands. `/login` is the only way a player reaches the web app |
| `reactions:write` | pre-seed the rule offer's numeral ballot (OPTIONAL — see below) |

Subscribe to these bot events: `message.channels`, `reaction_added`,
`reaction_removed`. Point the Request URL at `https://<host>/slack/events` —
Bolt's default path.

**The daily rule vote needs no additional event subscriptions.** It rides the
same `reaction_added` / `reaction_removed` events approvals already use — the
ingest branches on the emoji, routing numerals (`:one:`…`:nine:`) to the day's
offer message and 👍 to workout posts.

`reactions:write` is the one **optional** scope in this table. With it the
offer job pre-seeds `:one:` `:two:` `:three:` on its own message, so voting is
one tap. Without it every seeding call fails, the job logs a line per numeral
and carries on — the offer is still posted, recorded and votable, and players
add the numeral themselves. Nothing about the tally changes either way, and
the bot's own reactions never count: the bot user is not on the roster, so
`factionForSlackUser` drops them at ingest.

To check what the live token actually holds, without side effects:

```bash
curl -sD- -o/dev/null -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  https://slack.com/api/auth.test | grep -i '^x-oauth-scopes'
```

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

It also needs **`RR_SEASON_ID`**, already in this file for the jobs, and refuses
to start without it for the same reason: `/login` reads it to decide whether the
board has been dealt, and a bot that guessed would either hand out seats during a
live season or refuse them before one.

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
  23:59:59 delivered at 00:00:01 still counts for that day. Do not "fix" a
  seemingly late row.

- **Deleting a photo retracts the action**, including its approvals and the
  poster's elimination veto for that day.

- `journalctl -u riskety-slack -n 50`


## The web app

`npm run web`, port 3002. Caddy routes the public origin to it, alongside the
existing `/slack/events` route to 3001.

Players sign in with the `/login` slash command, which needs a Slack app
configuration:

- **Two slash commands**, `/login` and `/name`, both pointing at the bot's public
  URL (`https://<host>/slack/events`, Bolt's default path) with the `commands`
  scope. One scope covers both; adding the second command needs no re-verification.
- `chat:write`, which the recap already needs.

The reply is ephemeral, so only the person who ran it sees the link. Links last
ten minutes and work once, and a player may hold five at a time — running
`/login` again does **not** strand a link they were about to click. The sixth
evicts the oldest.

**`/login` is also how somebody joins, but only before a season is dealt.** The
objection to self-service was always that `season-init` sizes and deals the board
from the roster, so a faction added afterwards owns nothing, permanently — which
says nothing about the state before the deal. So `/login` branches on
`store.season(RR_SEASON_ID)`:

| Roster | Season | What happens |
|---|---|---|
| on it | either | a link, as always |
| not on it | dealt | the reply carries the exact `roster:add` command with their Slack id filled in, for an operator to run deliberately |
| not on it | not dealt | they are added and get their link in the same reply |
| not on it | not dealt, **not in the channel** | refused, told to join the channel first |

The channel check is not decoration. A slash command is workspace-wide, so
without it anybody who can see `/login` could claim a seat, and every phantom
seat shrinks everyone's share of the board at `season-init`. It costs one
`conversations.members` call, the same one `roster:sync` makes — and if that call
fails (missing scope, bot not in the channel, an outage) the reply degrades to
the operator message rather than raising.

**This is why the bot now needs `RR_SEASON_ID`**, which it did not before.

`/name <new name>` changes a display name and has **no season gate** — every page
resolves names from the roster when it renders, so a change lands on the board,
the standings and tonight's recap immediately, including replays of days already
played. The faction id never moves: it is in every saved state and log line, and
following the name would detach a player from their own history. The same thing
is available from the board itself, by pressing your name in the rail.

Because players own their names now, **`roster:sync` no longer adopts one from
Slack for anybody already on the roster** — it reports the difference and writes
nothing. Adopting it would silently revert every self-chosen name each time an
operator ran a sync.

### Routes

| Route | What it is |
|---|---|
| `/` | The player board. Signed out, the landing page: what the game is, how to get in, and an example board dealt from a fixed seed. Reads no season. |
| `/day/N` | The night replayed |
| `/rules` | Every rule and why it is that rule — no session, no season |
| `/map` | The debug board — no session needed, no player data |
| `POST /api/plan` | Autosave the day's deploys, moves and attacks |
| `POST /api/wager` | Place or change one wager |
| `POST /api/name` | Change your display name. Faction from the session cookie, never the body |
| `/api/day` | Which day has resolved, so an open board can reload itself after the tick |
| `/vendor/leaflet.{js,css}` | Leaflet, served from an explicit two-entry allow-list |

Today's slate is a sheet on the board, not a page. `/wagers` was removed in
`adfcb05`: a wager and a deploy draw on the same reserve, and only the board was
counting both.


## Live prices

`riskety-poll-prices.timer` runs every 30 minutes at `*:15/30`, offset from the
settlement poller at `*:00/30` so the two do not contend for the write lock,
and clear of the 00:05:30 tick.

It exists because the published slate is frozen. `publishSlate` refuses a second
write so a rerun cannot re-snapshot the day's prices — and that freeze is what
made late betting free money: a wager placed at 20:59 on a market whose outcome
was nearly public still paid at the morning's odds, worth roughly +94% EV.

Prices now move in their own table and a wager records the price it was
**placed** at. The published slate is still frozen; only the odds move.

If the poller stops, prices go stale and wagers fall back to the last recorded
price — the old behaviour, and no worse than it was.
