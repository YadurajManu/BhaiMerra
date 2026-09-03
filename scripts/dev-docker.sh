#!/usr/bin/env bash
#
# Start Docker for local development without letting this machine serve
# production traffic.
#
# The laptop and the AWS control plane were built from the same compose file and
# therefore share one Cloudflare tunnel id. Cloudflare treats two connections to
# the same tunnel as high-availability replicas and round-robins between them —
# so a local `cloudflared` does not fail, and it does not warn. It quietly takes
# half of production and answers it from whatever stale containers this machine
# happens to have.
#
# Three things stop that, and this script is the third:
#
#   1. the local tunnel credential is renamed to .local-disabled
#   2. deploy/.env points TUNNEL_CREDENTIALS at a path that does not exist
#   3. this script refuses to hand back a shell until nothing fleet-related is
#      running locally
#
# Usage:  ./scripts/dev-docker.sh          start Docker, verify, report
#         ./scripts/dev-docker.sh --test   the above, then bring up test DBs
set -uo pipefail

say() { printf '  %s\n' "$*"; }

# ── 1. the daemon ──────────────────────────────────────────────────────
if docker info >/dev/null 2>&1; then
  say "docker already running"
else
  say "starting Docker Desktop..."
  open -a Docker 2>/dev/null || { echo "could not launch Docker Desktop"; exit 1; }
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    printf '.'; sleep 3
  done
  echo
  docker info >/dev/null 2>&1 || { echo "docker did not come up"; exit 1; }
  say "docker up"
fi

# ── 2. nothing local may serve production ──────────────────────────────
# `restart: unless-stopped` should keep a manually stopped container down, but
# "should" is not a guarantee worth betting production traffic on.
RUNNING=$(docker ps --filter 'name=fleet-' --format '{{.Names}}' | grep -v '^fleet-test-' || true)
if [ -n "$RUNNING" ]; then
  say "these auto-started and are being stopped:"
  echo "$RUNNING" | sed 's/^/    /'
  # shellcheck disable=SC2086
  docker stop $RUNNING >/dev/null
  say "stopped"
else
  say "no fleet containers auto-started"
fi

# The tunnel is the only container that can steal traffic. Removed outright, so
# even an accidental `docker compose --profile tunnel up` has to recreate it.
if docker ps -a --filter 'name=fleet-tunnel' --format '{{.Names}}' | grep -q fleet-tunnel; then
  docker rm -f fleet-tunnel >/dev/null 2>&1 && say "removed the local fleet-tunnel container"
fi

# ── 3. prove it ────────────────────────────────────────────────────────
CRED="$HOME/.cloudflared/12b87f0b-6409-4ecb-9946-53bc1bef50a7.json"
if [ -f "$CRED" ]; then
  say "WARNING: the production tunnel credential is present at $CRED"
  say "         rename it to .local-disabled before running the stack here"
else
  say "tunnel credential is disabled locally"
fi

say "production check:"
for h in fleet.plastikworld.xyz fleetapi.plastikworld.xyz/healthz; do
  printf '    %-40s HTTP %s\n' "$h" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$h")"
done

# ── 4. optional: databases for the test suite ──────────────────────────
# Deliberately standalone `docker run` on non-default ports rather than part of
# the fleet-os compose project, so they share no network, no volumes and no
# names with anything that serves traffic.
if [ "${1:-}" = "--test" ]; then
  docker rm -f fleet-test-pg fleet-test-redis >/dev/null 2>&1
  docker run -d --name fleet-test-pg -p 55432:5432 \
    -e POSTGRES_PASSWORD=test -e POSTGRES_USER=fleetos -e POSTGRES_DB=fleetos_test \
    postgres:16-alpine >/dev/null
  docker run -d --name fleet-test-redis -p 56379:6379 redis:7-alpine >/dev/null
  for _ in $(seq 1 30); do
    docker exec fleet-test-pg pg_isready -U fleetos >/dev/null 2>&1 && break
    sleep 2
  done
  say "test databases up on :55432 and :56379"
fi
