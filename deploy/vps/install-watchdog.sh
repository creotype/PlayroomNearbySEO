#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root" >&2
  exit 77
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -m 0644 "$SCRIPT_DIR/playroom-seo-watchdog.service" /etc/systemd/system/playroom-seo-watchdog.service
install -m 0644 "$SCRIPT_DIR/playroom-seo-watchdog.timer" /etc/systemd/system/playroom-seo-watchdog.timer
systemctl daemon-reload
systemctl enable --now playroom-seo-watchdog.timer
systemctl is-active --quiet playroom-seo-watchdog.timer
