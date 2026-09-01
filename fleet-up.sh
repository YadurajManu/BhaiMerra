#!/bin/bash
# fleet-up — start the whole of Fleet OS in one command.
#
#   ./fleet-up.sh          start everything and stay attached to the tunnel
#   ./fleet-up.sh --no-tunnel   local only, no public hostnames
#   ./fleet-up.sh down     stop everything
#   ./fleet-up.sh logs     follow the control plane
#   ./fleet-up.sh status   what is running, and where
#
# Brings up Postgres, Redis, the registry, the control plane and the
# dashboard as containers, then attaches the Cloudflare Tunnel that puts
# them on the internet. No port forwarding, nothing exposed on the router.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$ROOT/deploy"
CF_CONFIG="$DEPLOY/cloudflare/fleet-os.yml"

c()   { printf "\033[%sm%s\033[0m" "$1" "$2"; }
ok()  { echo "  $(c 32 ✓) $1"; }
bad() { echo "  $(c 31 ✗) $1"; }
step(){ echo; echo "$(c '1;36' "── $1 ──")"; }

compose() {
  local profiles=()
  [ "${WITH_TUNNEL:-1}" = 1 ] && profiles=(--profile tunnel)
  docker compose --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml" "${profiles[@]}" "$@"
}

# Read deploy/.env for our own settings too, not just compose's. Otherwise
# every invocation needs ORIGINCERT=... typed in front of it, which is the
# kind of thing that gets forgotten and then looks like a broken tunnel.
if [ -f "$DEPLOY/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$DEPLOY/.env"
  set +a
fi

case "${1:-up}" in
  down)
    step "stopping"
    WITH_TUNNEL=1 compose down && ok "everything stopped"
    echo; echo "Data is kept in docker volumes. 'docker compose down -v' to erase it."
    exit 0 ;;
  logs)
    shift || true
    WITH_TUNNEL=1 compose logs -f "${1:-control-plane}"; exit 0 ;;
  status)
    WITH_TUNNEL=1 compose ps
    exit 0 ;;
esac

WITH_TUNNEL=1
[ "${1:-}" = "--no-tunnel" ] && WITH_TUNNEL=0
export WITH_TUNNEL

# ── preflight ───────────────────────────────────────────────────────
# Check before starting anything, so a missing prerequisite fails in a
# second rather than halfway through bringing a database up.
step "preflight"

docker info >/dev/null 2>&1 || { bad "Docker is not running — start Docker Desktop"; exit 1; }
ok "docker"

[ -f "$DEPLOY/.env" ] || {
  bad "no deploy/.env — copy deploy/.env.example and fill in the secrets"
  exit 1
}
missing=$(grep -E '^(POSTGRES_PASSWORD|JWT_SECRET|SECRETS_MASTER_KEY|REGISTRY_URL)=$' "$DEPLOY/.env" | cut -d= -f1 || true)
[ -z "$missing" ] || { bad "deploy/.env is missing values: $(echo $missing | tr '\n' ' ')"; exit 1; }
ok "configuration"

if [ "$WITH_TUNNEL" = 1 ]; then
  command -v cloudflared >/dev/null || { bad "cloudflared not installed: brew install cloudflared"; exit 1; }
  [ -f "$CF_CONFIG" ] || {
    bad "no tunnel config — run: ./deploy/cloudflare/setup.sh"
    echo "     or start without one: ./fleet-up.sh --no-tunnel"
    exit 1
  }
  ok "cloudflared"
fi

# ── containers ──────────────────────────────────────────────────────
step "starting the stack"
compose up -d --remove-orphans

# Compose returns as soon as containers start; the control plane still has
# migrations to run. Wait for it to actually answer.
printf "  waiting for the control plane"
for i in $(seq 1 60); do
  if curl -fsS -m 2 "http://localhost:${API_PORT:-8080}/healthz" >/dev/null 2>&1; then
    echo; ok "control plane healthy"; break
  fi
  printf "."
  sleep 2
  [ "$i" = 60 ] && { echo; bad "control plane did not become healthy"; compose logs --tail 30 control-plane; exit 1; }
done

curl -fsS -m 4 "http://localhost:${WWW_PORT:-8083}/" >/dev/null 2>&1 \
  && ok "landing page serving" || bad "landing page not responding"
curl -fsS -m 4 "http://localhost:${DASHBOARD_PORT:-8082}/" >/dev/null 2>&1 \
  && ok "dashboard serving" || bad "dashboard not responding"
# 401 is the *healthy* answer from a registry with authentication turned on —
# it means the auth layer is in front of the API, which is the point. `curl -f`
# treats every 4xx as a failure, so it reported a working registry as down from
# the moment credentials were added. The compose healthcheck accepts both for
# the same reason; these two must agree or they disagree about the same
# container. The status code is reported on failure because "not responding"
# is not something anyone can act on.
registry_status=$(curl -s -o /dev/null -w '%{http_code}' -m 4 \
  "http://localhost:${REGISTRY_PORT:-5001}/v2/" 2>/dev/null || echo 000)
case "$registry_status" in
  200) ok "registry up" ;;
  401) ok "registry up (authenticated)" ;;
  000) bad "registry not responding (no answer on port ${REGISTRY_PORT:-5001})" ;;
  *)   bad "registry not responding (HTTP $registry_status)" ;;
esac

# ── tunnel ──────────────────────────────────────────────────────────
if [ "$WITH_TUNNEL" = 1 ]; then
  step "cloudflare tunnel"
  printf "  connecting"
  for i in $(seq 1 30); do
    if compose logs cloudflared 2>/dev/null | grep -aq "Registered tunnel connection"; then
      echo; ok "tunnel connected ($(compose logs cloudflared 2>/dev/null | grep -ao 'protocol=[a-z0-9]*' | tail -1))"
      break
    fi
    if compose logs cloudflared 2>/dev/null | grep -aq "failed to dial to edge with quic"; then
      echo; bad "the network is blocking QUIC (UDP/443); config should set 'protocol: http2'"
      break
    fi
    printf "."
    sleep 2
    [ "$i" = 30 ] && { echo; bad "tunnel did not connect — ./fleet-up.sh logs cloudflared"; }
  done

  echo
  labels=(landing dashboard api services)
  i=0
  while read -r host; do
    [ -z "$host" ] && continue
    case "$host" in
      \**) echo "  $(printf '%-11s' "${labels[$i]:-}")$(c 2 "$host")" ;;
      *)   echo "  $(printf '%-11s' "${labels[$i]:-}")$(c 36 "https://$host")" ;;
    esac
    i=$((i+1))
  done < <(grep -E '^\s+- hostname:' "$CF_CONFIG" | sed 's/.*hostname: *//' | tr -d '"')
fi

step "ready"
echo "  add a node:   fleet nodes pair"
echo "  follow logs:  ./fleet-up.sh logs"
echo "  stop:         ./fleet-up.sh down"

if [ "$WITH_TUNNEL" = 1 ]; then
  echo
  echo "  $(c 2 "The tunnel is a supervised container; it restarts itself. ./fleet-up.sh down to stop.")"
fi
