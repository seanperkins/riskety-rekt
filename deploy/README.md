# Deployment — market jobs

Two timers, both on a single DigitalOcean droplet alongside the SQLite file.

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

Kalshi's public market-data endpoints need no credentials, so these jobs hold
no secrets. That changes in Plan 3, which adds the Slack signing secret.

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
