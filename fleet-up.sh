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
PIDFILE="$DEPLOY/.tunnel.pid"

c()   { printf "\033[%sm%s\033[0m" "$1" "$2"; }
ok()  { echo "  $(c 32 ✓) $1"; }
bad() { echo "  $(c 31 ✗) $1"; }
step(){ echo; echo "$(c '1;36' "── $1 ──")"; }

compose() { docker compose --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml" "$@"; }

# Read deploy/.env for our own settings too, not just compose's. Otherwise
# every invocation needs ORIGINCERT=... typed in front of it, which is the
# kind of thing that gets forgotten and then looks like a broken tunnel.
if [ -f "$DEPLOY/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$DEPLOY/.env"
  set +a
fi

stop_tunnel() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}

case "${1:-up}" in
  down)
    step "stopping"
    stop_tunnel && ok "tunnel stopped"
    compose down && ok "containers stopped"
    echo; echo "Data is kept in docker volumes. 'docker compose down -v' to erase it."
    exit 0 ;;
  logs)
    compose logs -f control-plane; exit 0 ;;
  status)
    compose ps
    echo
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
      then ok "tunnel running (pid $(cat "$PIDFILE"))"
      else bad "tunnel not running"
    fi
    exit 0 ;;
esac

WITH_TUNNEL=1
[ "${1:-}" = "--no-tunnel" ] && WITH_TUNNEL=0

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
curl -fsS -m 4 "http://localhost:${REGISTRY_PORT:-5001}/v2/" >/dev/null 2>&1 \
  && ok "registry up" || bad "registry not responding"

# ── tunnel ──────────────────────────────────────────────────────────
if [ "$WITH_TUNNEL" = 1 ]; then
  step "cloudflare tunnel"
  stop_tunnel
  [ -n "${ORIGINCERT:-}" ] && export TUNNEL_ORIGIN_CERT="$ORIGINCERT"
  cloudflared tunnel --config "$CF_CONFIG" run >"$DEPLOY/.tunnel.log" 2>&1 &
  echo $! > "$PIDFILE"

  printf "  connecting"
  for i in $(seq 1 20); do
    if grep -aq "Registered tunnel connection" "$DEPLOY/.tunnel.log" 2>/dev/null; then
      echo; ok "tunnel connected ($(grep -ao 'protocol=[a-z0-9]*' "$DEPLOY/.tunnel.log" | head -1))"
      break
    fi
    # QUIC is UDP/443 and a lot of home networks drop it silently. Say so
    # rather than let it look like a generic timeout.
    if grep -aq "failed to dial to edge with quic" "$DEPLOY/.tunnel.log" 2>/dev/null; then
      echo; bad "the network is blocking QUIC (UDP/443) to Cloudflare's edge"
      echo "     add 'protocol: http2' to $CF_CONFIG"
      break
    fi
    printf "."
    sleep 1
    [ "$i" = 20 ] && { echo; bad "tunnel did not connect — see deploy/.tunnel.log"; }
  done

  # Read the hostnames rather than deriving them; the shape has changed once
  # already and a derived URL that is subtly wrong is worse than none.
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
  echo "  $(c 2 "Tunnel is running in the background. Ctrl-C is safe; use ./fleet-up.sh down to stop.")"
fi
