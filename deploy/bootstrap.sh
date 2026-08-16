#!/usr/bin/env bash
#
# Second-stage deploy, run ON the droplet after cloud-init finishes.
#
# Split from cloud-init deliberately: cloud-init builds a machine, this builds a
# deployment. Rerunning it is safe and is also the upgrade path -- it pulls,
# reinstalls, reloads units and restarts services, and never touches the
# database or /etc/riskety-rekt/env.
#
#   ssh root@<ip> 'bash -s' < deploy/bootstrap.sh
#
set -euo pipefail

REPO="${RR_REPO:-}"
APP=/srv/riskety-rekt
DATA=$APP/data

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---- guard rails -------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  echo "Node 24+ required (node:sqlite). cloud-init may still be running." >&2
  exit 1
fi

# ---- code --------------------------------------------------------------------
say "syncing code"
# The tree is owned by `riskety` and git runs here as root, which git treats as
# a dubious-ownership error and refuses outright. This is that check's intended
# escape hatch: the directory is one we just created on a single-tenant box.
git config --global --add safe.directory "$APP"

if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --all --prune
  git -C "$APP" reset --hard origin/main
elif [ -n "$REPO" ]; then
  # Clone the git metadata beside the tree and adopt it, rather than cloning
  # over the tree. $APP already holds data/ with the live database in it, and a
  # clone into a non-empty directory is exactly the operation that would take
  # a season with it.
  rm -rf "$APP.tmp"
  git clone --no-checkout "$REPO" "$APP.tmp"
  mv "$APP.tmp/.git" "$APP/.git"
  rm -rf "$APP.tmp"
  git -C "$APP" reset --hard origin/main
else
  echo "No checkout at $APP and RR_REPO unset." >&2
  echo "Either set RR_REPO=<clone url>, or rsync the tree up first." >&2
  exit 1
fi

say "installing dependencies"
# --omit=dev keeps world-atlas and the test toolchain off the box. Nothing is
# compiled or bundled: tsx runs the TypeScript directly, so there is no build.
( cd "$APP" && npm ci --omit=dev )

install -d -o riskety -g riskety "$DATA"
chown -R riskety:riskety "$APP"

# ---- units -------------------------------------------------------------------
say "installing systemd units"
cp "$APP"/deploy/*.service "$APP"/deploy/*.timer /etc/systemd/system/
systemctl daemon-reload

# ---- caddy -------------------------------------------------------------------
say "installing Caddy config"
cp "$APP/deploy/Caddyfile" /etc/caddy/Caddyfile
install -d -o caddy -g caddy /var/log/caddy

# Validate before reloading: a bad Caddyfile on reload leaves the OLD config
# serving, which is quiet enough to miss entirely.
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# `caddy validate` PROVISIONS the config rather than merely parsing it -- it
# opens log writers and starts certificate maintenance, then tears it down. Run
# as root, that leaves /var/log/caddy/riskety.log owned root:root 0600, and the
# service runs as `caddy` and dies on "permission denied" opening its own log.
# Hand the whole directory back after validating, not before.
chown -R caddy:caddy /var/log/caddy

systemctl reload caddy || systemctl restart caddy

# ---- nightly database backup -------------------------------------------------
# `.backup` is safe against a live WAL database; copying the file is not.
say "installing nightly backup"
cat > /etc/systemd/system/riskety-backup.service <<'UNIT'
[Unit]
Description=Riskety Rekt — nightly SQLite backup

[Service]
Type=oneshot
User=riskety
EnvironmentFile=/etc/riskety-rekt/env
ExecStart=/bin/sh -c 'sqlite3 "$RR_DB_PATH" ".backup /var/backups/riskety/riskety-$(date +%%F).db" && find /var/backups/riskety -name "riskety-*.db" -mtime +14 -delete'
UNIT
cat > /etc/systemd/system/riskety-backup.timer <<'UNIT'
[Unit]
Description=Riskety Rekt — nightly SQLite backup

[Timer]
# 00:35, half an hour after the 00:05:30 tick: the day is resolved and the recap
# posted, so the snapshot is of a settled state rather than mid-season-night.
#
# This MUST move with the tick. At 21:30 under a midnight boundary it ran 2.5
# hours BEFORE the day resolved, so it captured exactly the mid-night state the
# comment says it avoids -- a full day of unresolved orders, wagers and
# approvals stacked on the previous game day -- and a restore would have lost
# the whole day's play instead of none of it.
OnCalendar=*-*-* 00:35:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload

# ---- enable ------------------------------------------------------------------
say "enabling timers and services"
systemctl enable --now \
  riskety-publish-slate.timer \
  riskety-publish-rules.timer \
  riskety-poll-settlements.timer \
  riskety-poll-prices.timer \
  riskety-tick.timer \
  riskety-backup.timer

# The long-running services need the env file filled in first. Starting them
# with SLACK_* blank would exit 1 in a restart loop, so check before enabling.
#
# `restart`, not `enable --now`: on a service that is ALREADY running, --now is
# a no-op. This script is the upgrade path, so that silently left the old code
# serving after a successful-looking deploy -- the pull worked, the units
# reloaded, and nothing picked up the new code.
start_or_restart() {
  systemctl enable "$1" >/dev/null 2>&1
  systemctl restart "$1"
}

if grep -q '^SLACK_SIGNING_SECRET=.\+' /etc/riskety-rekt/env; then
  start_or_restart riskety-slack.service
else
  say "SLACK_* not set in /etc/riskety-rekt/env — leaving riskety-slack stopped"
fi

if grep -q '^RR_WEB_URL=.\+' /etc/riskety-rekt/env; then
  start_or_restart riskety-web.service
else
  say "RR_WEB_URL not set in /etc/riskety-rekt/env — leaving riskety-web stopped"
fi

# The demo board, if this box runs one. It carries its whole environment inline
# in the unit, so there is nothing to check first -- but it is restarted ONLY
# when already enabled, so a deploy never conscripts a box into serving a demo
# it was never given.
#
# It was missing here for five deploys, and the effect is the one the comment
# above describes: same tree, same pull, but tsx reads the code once at start,
# so demo.riskety.com kept serving a build from the previous day while every
# deploy reported success.
if systemctl is-enabled riskety-demo-web.service >/dev/null 2>&1; then
  systemctl restart riskety-demo-web.service
else
  say "riskety-demo-web is not enabled — skipping the demo board"
fi

# Fail loudly rather than reporting a green deploy that is not serving.
sleep 3
for unit in riskety-web riskety-slack riskety-demo-web; do
  if systemctl is-enabled "$unit" >/dev/null 2>&1 && ! systemctl is-active --quiet "$unit"; then
    echo "ERROR: $unit is enabled but not active after deploy" >&2
    journalctl -u "$unit" -n 15 --no-pager >&2
    exit 1
  fi
done
say "deployed $(git -C "$APP" rev-parse --short HEAD)"

say "done"
systemctl list-timers 'riskety-*' --no-pager || true
