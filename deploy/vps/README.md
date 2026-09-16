# VPS deployment

The production bot runs as exactly one isolated container under `/opt/playroom-seo-bot`.
It has no published port and no Caddy route. Cognify and Ellirium are outside its
network and lifecycle.

Required server-only files (never commit them):

- `/opt/playroom-seo-bot/secrets/runtime.env`
- `/opt/playroom-seo-bot/secrets/google-service-account.json`

Build while the previous instance is still serving, then stop the previous
instance before calling `start.sh`. Starting two copies with one Telegram token
causes conflicting long-poll consumers.

```sh
cd /opt/playroom-seo-bot/repo
./deploy/vps/build.sh <git-sha>
./deploy/vps/start.sh <git-sha>
./deploy/vps/verify.sh
./deploy/vps/install-watchdog.sh
```

The container is limited to 0.75 CPU, 768 MiB RAM and 128 PIDs, uses a read-only
root filesystem, stores only the paid image cache in `/opt/playroom-seo-bot/data`,
and rotates JSON logs. `start.sh` only replaces the exact `playroom-seo-bot`
container; never use a host-wide Docker prune or daemon restart for this service.
The dedicated systemd timer checks only this container. Docker's own health state
already requires repeated failures before the timer restarts it; the watchdog does
not inspect or restart Cognify, Ellirium, Caddy, or the Docker daemon.
