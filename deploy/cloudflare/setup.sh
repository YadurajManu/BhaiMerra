#!/bin/bash
# Create the Fleet OS tunnel and route its hostnames.
#
#   ORIGINCERT=~/.cloudflared/plastikworld-cert.pem ./deploy/cloudflare/setup.sh
#
# Idempotent: re-running reuses an existing tunnel of the same name rather
# than stacking duplicates, which is easy to do by accident and tedious to
# clean up afterwards.
set -euo pipefail

ZONE="${ZONE:-fleet.plastikworld.xyz}"
APEX="${ZONE#*.}"
NAME="${TUNNEL_NAME:-fleet-os}"
DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/fleet-os.yml"

# cloudflared's cert is scoped to ONE zone, chosen at login. Using a cert for
# the wrong zone does not fail — it silently treats the hostname as relative
# and appends its own zone, so "fleet.example.com" becomes
# "fleet.example.com.otherzone.com". Hence the explicit cert and the check.
ORIGINCERT="${ORIGINCERT:-$HOME/.cloudflared/cert.pem}"
CERT_ARGS=(--origincert "$ORIGINCERT")

command -v cloudflared >/dev/null || { echo "cloudflared is not installed"; exit 1; }
[ -f "$ORIGINCERT" ] || {
  echo "No certificate at $ORIGINCERT"
  echo "Authorise the zone first:"
  echo "  cloudflared tunnel login --origincert $ORIGINCERT"
  exit 1
}

# --- tunnel ---------------------------------------------------------
existing=$(cloudflared "${CERT_ARGS[@]}" tunnel list --output json 2>/dev/null \
  | python3 -c "import sys,json;print(next((t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'),''))" 2>/dev/null || true)

if [ -n "$existing" ]; then
  echo "reusing tunnel \"$NAME\" ($existing)"
  ID="$existing"
else
  echo "creating tunnel \"$NAME\""
  cloudflared "${CERT_ARGS[@]}" tunnel create "$NAME" >/dev/null
  ID=$(cloudflared "${CERT_ARGS[@]}" tunnel list --output json \
    | python3 -c "import sys,json;print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'))")
  echo "  created $ID"
fi

sed -e "s|REPLACE_WITH_TUNNEL_ID|$ID|g" \
    -e "s|/Users/REPLACE_ME|$HOME|g" \
    -e "s|fleet\.plastikworld\.xyz|$ZONE|g" \
    "$DIR/fleet-os.yml.example" > "$CONFIG"
echo "wrote $CONFIG"

# --- dns ------------------------------------------------------------
# Every result is printed. An earlier version reported "ok" from an exit code
# with stderr discarded, and four writes to the wrong zone all looked like
# successes. A check that cannot report failure is worse than no check.
failed=0
for host in "$ZONE" "app.$ZONE" "api.$ZONE" "*.$ZONE"; do
  printf "  %-34s " "$host"
  out=$(cloudflared "${CERT_ARGS[@]}" tunnel route dns "$NAME" "$host" 2>&1 | grep -vE "outdated|recommend upgrading" || true)

  # The tell-tale of a wrong-zone cert: the name comes back with the cert's
  # zone appended to the one we asked for.
  if echo "$out" | grep -q "$host\."; then
    echo "WRONG ZONE"
    echo "        cloudflared wrote $(echo "$out" | grep -oE "[A-Za-z0-9.*-]+\.[a-z]+ " | head -1)"
    echo "        $ORIGINCERT is not authorised for $APEX."
    echo "        Run: cloudflared tunnel login --origincert $ORIGINCERT"
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
depth=$(echo "$ZONE" | tr -cd '.' | wc -c | tr -d ' ')
if [ "$depth" -ge 2 ]; then
  echo
  echo "  NOTE  $ZONE is $depth levels deep."
  echo "        Universal SSL covers $APEX and *.$APEX only, so app.$ZONE"
  echo "        and *.$ZONE need Advanced Certificate Manager (\$10/mo/zone)."
  echo "        Otherwise use one level: fleet.$APEX, fleetapp.$APEX, fleetapi.$APEX"
fi

echo
echo "Start everything with:  ./fleet-up.sh"
