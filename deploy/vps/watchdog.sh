#!/bin/sh
set -eu

CONTAINER_NAME="playroom-seo-bot"

STATUS=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)
if [ "$STATUS" != "unhealthy" ]; then
  exit 0
fi

logger -t playroom-seo-watchdog "Restarting persistently unhealthy $CONTAINER_NAME container"
docker restart --time 300 "$CONTAINER_NAME" >/dev/null
