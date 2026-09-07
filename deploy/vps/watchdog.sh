#!/bin/sh
set -eu

CONTAINER_NAME="playroom-seo-bot"
DEPLOY_LOCK="/run/lock/playroom-seo-bot.lock"

command -v flock >/dev/null 2>&1 || exit 0
exec 9>"$DEPLOY_LOCK"
flock -n -x 9 || exit 0

STATE=$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)
set -- $STATE
RUNNING=${1:-false}
STATUS=${2:-missing}

if [ "$RUNNING" != "true" ] || [ "$STATUS" != "unhealthy" ]; then
  exit 0
fi

logger -t playroom-seo-watchdog "Restarting persistently unhealthy $CONTAINER_NAME container"
docker restart --time 300 "$CONTAINER_NAME" >/dev/null
