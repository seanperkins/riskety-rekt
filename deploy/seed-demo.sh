#!/usr/bin/env bash
#
# Build the demo board: ten invented players, dealt from a fixed seed.
#
# Run ON the droplet, as root:
#   bash /srv/riskety-rekt/deploy/seed-demo.sh
#
# SAFETY: this writes ONLY to data/demo.db. It never opens the production
# database, and it refuses to run if RR_DB_PATH points anywhere else.
#
# The separation is a database FILE, not a season id, and that is deliberate:
# `roster` is keyed by slack_user_id with no season column, so ten fake players
# in the production database would be dealt into the real season by
# season:init -- which then refuses to be re-run, permanently.
set -euo pipefail

APP=/srv/riskety-rekt
export TZ=America/New_York
export RR_DB_PATH=$APP/data/demo.db
export RR_SEASON_ID=demo

case "$RR_DB_PATH" in
  */demo.db) ;;
  *) echo "refusing: RR_DB_PATH is not the demo database" >&2; exit 1 ;;
esac

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "resetting $RR_DB_PATH"
rm -f "$RR_DB_PATH" "$RR_DB_PATH-wal" "$RR_DB_PATH-shm"
install -d -o riskety -g riskety "$(dirname "$RR_DB_PATH")"

# Invented players. Obviously fictional on purpose -- a demo board that looks
# like it holds real people's standings is a demo somebody screenshots.
say "seeding a ten-player roster"
add() { sudo -u riskety --preserve-env=TZ,RR_DB_PATH,RR_SEASON_ID \
          npm --prefix "$APP" run --silent roster:add -- "$1" "$2" "$3" >/dev/null; }

add UDEMO0001 vanguard   "Vanguard"
add UDEMO0002 kestrel    "Kestrel"
add UDEMO0003 meridian   "Meridian"
add UDEMO0004 lodestar   "Lodestar"
add UDEMO0005 ironwood   "Ironwood"
add UDEMO0006 halcyon    "Halcyon"
add UDEMO0007 saltflat   "Saltflat"
add UDEMO0008 brightwork "Brightwork"
add UDEMO0009 nightjar   "Nightjar"
add UDEMO0010 quarry     "Quarry"

say "roster"
sudo -u riskety --preserve-env=TZ,RR_DB_PATH,RR_SEASON_ID \
  npm --prefix "$APP" run --silent roster:list -- 2>&1 | tail -12

# Day 0 is dealt two days BACK by default, which leaves day 1 resolvable: a
# demo whose board has never ticked cannot show the replay, and the replay is
# most of what there is to show. Pass a date to override, or `today` for the
# original still photograph.
#
# No timer points at this database either way, so the demo never drifts on its
# own -- days are resolved deliberately, by seed-demo-night.sh.
START=${1:-$(date -d '2 days ago' +%F 2>/dev/null || date -v-2d +%F)}
if [ "$START" = "today" ]; then START=$(date +%F); fi
say "dealing day 0 for $START"
sudo -u riskety --preserve-env=TZ,RR_DB_PATH,RR_SEASON_ID \
  npm --prefix "$APP" run --silent season:init -- "$START" --seed 4711 2>&1 | tail -8

chown -R riskety:riskety "$(dirname "$RR_DB_PATH")"
say "done"
