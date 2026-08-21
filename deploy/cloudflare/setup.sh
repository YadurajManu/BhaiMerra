#!/bin/bash
# Create the Fleet OS tunnel and route its hostnames.
#
#   ORIGINCERT=~/.cloudflared/plastikworld-cert.pem ./deploy/cloudflare/setup.sh
#
# Idempotent: re-running reuses an existing tunnel of the same name rather
# than stacking duplicates, which is easy to do by accident and tedious to
# clean up afterwards.
set -euo pipefail

# HOSTS is the exact set to route. Derived names (app.$ZONE) push hostnames a
# level deeper than a free wildcard certificate covers, so they are listed
# explicitly instead.
ZONE="${ZONE:-plastikworld.xyz}"
APEX="$ZONE"
HOSTS="${HOSTS:-fleet.$ZONE fleetapp.$ZONE fleetapi.$ZONE *.$ZONE}"
NAME="${TUNNEL_NAME:-fleet-os}"
DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/fleet-os.yml"

# cloudflared's cert is scoped to ONE zone, chosen at login. Using a cert for
# the wrong zone does not fail — it silently treats the hostname as relative
# and appends its own zone, so "fleet.example.com" becomes
# "fleet.example.com.otherzone.com". Hence the explicit cert and the check.
# --origincert is a flag on `tunnel`, not a global one, so its position is
# easy to get wrong. The environment variable it maps to is unambiguous.
ORIGINCERT="${ORIGINCERT:-$HOME/.cloudflared/cert.pem}"
export TUNNEL_ORIGIN_CERT="$ORIGINCERT"

# ~/.cloudflared/config.yml is read by every `tunnel` subcommand, and if it
# names a tunnel, that tunnel wins over the one given on the command line.
# `route dns fleet-os host` then silently points the hostname at whichever
# tunnel that file names — the symptom is a tunnel that connects fine and a
# hostname that still returns error 1033. Isolate from it.
ISOLATED="$(mktemp -d)/isolated.yml"
printf 'no-autoupdate: true\n' > "$ISOLATED"
cf() { cloudflared tunnel --config "$ISOLATED" "$@"; }

command -v cloudflared >/dev/null || { echo "cloudflared is not installed"; exit 1; }
[ -f "$ORIGINCERT" ] || {
  echo "No certificate at $ORIGINCERT"
  echo "Authorise the zone first:"
  echo "  TUNNEL_ORIGIN_CERT=$ORIGINCERT cloudflared tunnel login"
  exit 1
}

# --- tunnel ---------------------------------------------------------
existing=$(cf list --output json 2>/dev/null \
  | python3 -c "import sys,json;print(next((t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'),''))" 2>/dev/null || true)

if [ -n "$existing" ]; then
  echo "reusing tunnel \"$NAME\" ($existing)"
  ID="$existing"
else
  echo "creating tunnel \"$NAME\""
  cf create "$NAME" >/dev/null
  ID=$(cf list --output json \
    | python3 -c "import sys,json;print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'))")
  echo "  created $ID"
fi

# REPLACE_ZONE is a placeholder, not a real domain. Substituting a literal
# hostname here once rewrote "fleet.plastikworld.xyz" to the bare apex and
# would have had the tunnel claim the zone's main site.
sed -e "s|REPLACE_WITH_TUNNEL_ID|$ID|g" \
    -e "s|/Users/REPLACE_ME|$HOME|g" \
    -e "s|REPLACE_ZONE|$ZONE|g" \
    "$DIR/fleet-os.yml.example" > "$CONFIG"

# The apex must never be routed here by accident.
if grep -qE "^\s+- hostname: $ZONE\s*$" "$CONFIG"; then
  echo "refusing to write a config that claims the apex $ZONE"
  exit 1
fi
echo "wrote $CONFIG"

# --- dns ------------------------------------------------------------
# Every result is printed. An earlier version reported "ok" from an exit code
# with stderr discarded, and four writes to the wrong zone all looked like
# successes. A check that cannot report failure is worse than no check.
failed=0
for host in $HOSTS; do
  printf "  %-34s " "$host"
  # --overwrite-dns repoints an existing record at this tunnel. Without it a
  # second run fails on every hostname, which is exactly what happens after a
  # first run pointed them somewhere wrong — the state you most need to fix.
  out=$(cf route dns --overwrite-dns "$NAME" "$host" 2>&1 | grep -vE "outdated|recommend upgrading" || true)

  # The tell-tale of a wrong-zone cert: the name comes back with the cert's
  # zone appended to the one we asked for.
  if echo "$out" | grep -q "$host\."; then
    echo "WRONG ZONE"
    echo "        cloudflared wrote $(echo "$out" | grep -oE "[A-Za-z0-9.*-]+\.[a-z]+ " | head -1)"
    echo "        $ORIGINCERT is not authorised for $APEX."
    echo "        Run: TUNNEL_ORIGIN_CERT=$ORIGINCERT cloudflared tunnel login"
    failed=1
  elif echo "$out" | grep -qiE "error|failed"; then
    echo "FAILED"
    echo "        $out"
    failed=1
  else
    echo "ok"
  fi
done

[ "$failed" = 0 ] || { echo; echo "DNS routing did not complete — not writing a broken setup."; exit 1; }

# --- certificate depth ----------------------------------------------
for host in $HOSTS; do
  # Levels BELOW the apex, not dots in the whole name. fleet.example.com is
  # one level and covered; app.fleet.example.com is two and is not.
  sub="${host%.$APEX}"
  [ "$sub" = "$host" ] && continue          # the apex itself
  levels=$(( $(echo "$sub" | tr -cd '.' | wc -c | tr -d ' ') + 1 ))
  if [ "$levels" -ge 2 ]; then
    echo
    echo "  NOTE  $host is more than one level below the apex."
    echo "        Universal SSL covers $APEX and *.$APEX only, so this needs"
    echo "        Advanced Certificate Manager (\$10/mo/zone) or it fails TLS."
  fi
done

echo
echo "Start everything with:  ./fleet-up.sh"
