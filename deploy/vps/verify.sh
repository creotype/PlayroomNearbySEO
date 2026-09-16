#!/bin/sh
set -eu

CONTAINER_NAME="playroom-seo-bot"
ATTEMPTS=36

while [ "$ATTEMPTS" -gt 0 ]; do
  STATUS=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER_NAME")
  if [ "$STATUS" = "healthy" ]; then
    docker inspect --format 'container={{.Name}} status={{.State.Status}} health={{.State.Health.Status}} image={{.Config.Image}}' "$CONTAINER_NAME"
    exit 0
  fi
  if [ "$STATUS" = "unhealthy" ]; then
    docker logs --tail 80 "$CONTAINER_NAME" >&2
    exit 1
  fi
  ATTEMPTS=$((ATTEMPTS - 1))
  sleep 5
done

docker logs --tail 80 "$CONTAINER_NAME" >&2
echo "Timed out waiting for a healthy container" >&2
exit 1
