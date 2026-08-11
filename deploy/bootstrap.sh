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
# 21:30, half an hour after the tick: the day is resolved and the recap posted,
# so the snapshot is of a settled state rather than mid-season-night.
OnCalendar=*-*-* 21:30:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload

# ---- enable ------------------------------------------------------------------
say "enabling timers and services"
systemctl enable --now \
  riskety-publish-slate.timer \
  riskety-poll-settlements.timer \
  riskety-poll-prices.timer \
  riskety-tick.timer \
  riskety-backup.timer

# The long-running services need the env file filled in first. Starting them
# with SLACK_* blank would exit 1 in a restart loop, so check before enabling.
if grep -q '^SLACK_SIGNING_SECRET=.\+' /etc/riskety-rekt/env; then
  systemctl enable --now riskety-slack.service
else
  say "SLACK_* not set in /etc/riskety-rekt/env — leaving riskety-slack stopped"
fi

if grep -q '^RR_WEB_URL=.\+' /etc/riskety-rekt/env; then
  systemctl enable --now riskety-web.service
else
  say "RR_WEB_URL not set in /etc/riskety-rekt/env — leaving riskety-web stopped"
fi

say "done"
systemctl list-timers 'riskety-*' --no-pager || true
