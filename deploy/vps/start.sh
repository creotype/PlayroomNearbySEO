#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <immutable-image-tag>" >&2
  exit 64
fi

IMAGE_TAG="$1"
DEPLOY_ROOT="/opt/playroom-seo-bot"
RUNTIME_ENV="$DEPLOY_ROOT/secrets/runtime.env"
GOOGLE_CREDENTIALS="$DEPLOY_ROOT/secrets/google-service-account.json"
DATA_DIR="$DEPLOY_ROOT/data"
CONTAINER_NAME="playroom-seo-bot"
NETWORK_NAME="playroom-seo-net"
SECRETS_GROUP="playroom-seo-secrets"

test -f "$RUNTIME_ENV" || { echo "Missing $RUNTIME_ENV" >&2; exit 66; }
test -f "$GOOGLE_CREDENTIALS" || { echo "Missing $GOOGLE_CREDENTIALS" >&2; exit 66; }
docker image inspect "playroom-seo-bot:$IMAGE_TAG" >/dev/null

# Use a host group dedicated to this container instead of a shared system gid.
# The image still runs as its unprivileged `node` user and receives only this
# supplementary group for the one read-only credential mount.
if ! getent group "$SECRETS_GROUP" >/dev/null; then
  groupadd --system "$SECRETS_GROUP"
fi
SECRETS_GID=$(getent group "$SECRETS_GROUP" | cut -d: -f3)
test -n "$SECRETS_GID"
chown "root:$SECRETS_GID" "$GOOGLE_CREDENTIALS"
chmod 0440 "$GOOGLE_CREDENTIALS"
chown root:root "$RUNTIME_ENV"
chmod 0600 "$RUNTIME_ENV"

install -d -m 0750 -o 1000 -g 1000 "$DATA_DIR" "$DATA_DIR/hero-images"
docker network inspect "$NETWORK_NAME" >/dev/null 2>&1 || docker network create "$NETWORK_NAME" >/dev/null

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  docker stop --time 300 "$CONTAINER_NAME" >/dev/null
  docker rm "$CONTAINER_NAME" >/dev/null
fi

docker run --detach \
  --name "$CONTAINER_NAME" \
  --hostname "$CONTAINER_NAME" \
  --network "$NETWORK_NAME" \
  --restart unless-stopped \
  --stop-timeout 300 \
  --init \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --group-add "$SECRETS_GID" \
  --cpus .75 \
  --cpu-shares 128 \
  --memory 768m \
  --memory-swap 1g \
  --pids-limit 128 \
  --oom-score-adj 500 \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --env-file "$RUNTIME_ENV" \
  --env NODE_ENV=production \
  --env GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google-service-account.json \
  --env HERO_IMAGE_CACHE_DIR=/app/data/hero-images \
  --env EDITORIAL_AUTOMATION_ENABLED=true \
  --env EDITORIAL_TIME_ZONE=Europe/Belgrade \
  --env EDITORIAL_RUN_DAYS=1,5 \
  --env EDITORIAL_RUN_TIME=10:00 \
  --env AUTO_PUBLISH_AFTER_REVIEW=true \
  --env REVIEW_DEADLINE_HOURS=48 \
  --env PUBLICATION_TIME=10:00 \
  --env POLL_INTERVAL_MS=60000 \
  --env OPENAI_IMAGE_MODEL=gpt-image-2 \
  --env OPENAI_IMAGE_SIZE=1536x1024 \
  --env OPENAI_IMAGE_QUALITY=high \
  --env TRAY_MANAGED=0 \
  --mount "type=bind,src=$GOOGLE_CREDENTIALS,dst=/run/secrets/google-service-account.json,readonly" \
  --mount "type=bind,src=$DATA_DIR,dst=/app/data" \
  --health-cmd 'node -e "fetch(\"http://127.0.0.1:8080/readyz\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' \
  --health-interval 30s \
  --health-timeout 10s \
  --health-start-period 90s \
  --health-retries 3 \
  "playroom-seo-bot:$IMAGE_TAG" >/dev/null
