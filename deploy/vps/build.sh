#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <immutable-image-tag>" >&2
  exit 64
fi

IMAGE_TAG="$1"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

docker build --tag "playroom-seo-bot:$IMAGE_TAG" "$REPO_DIR"
