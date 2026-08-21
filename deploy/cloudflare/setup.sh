#!/bin/bash
# Create the Fleet OS tunnel and route its hostnames.
#
# Idempotent: re-running reuses an existing tunnel of the same name rather
# than stacking up duplicates, which is easy to do by accident and confusing
# to clean up afterwards.
set -euo pipefail

ZONE="${ZONE:-fleet.plastikworld.xyz}"
NAME="${TUNNEL_NAME:-fleet-os}"
DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/fleet-os.yml"

command -v cloudflared >/dev/null || { echo "cloudflared is not installed"; exit 1; }
[ -f "$HOME/.cloudflared/cert.pem" ] || { echo "Run: cloudflared tunnel login"; exit 1; }

existing=$(cloudflared tunnel list --output json 2>/dev/null \
  | python3 -c "import sys,json;print(next((t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'),''))")

if [ -n "$existing" ]; then
  echo "reusing tunnel \"$NAME\" ($existing)"
  ID="$existing"
else
  echo "creating tunnel \"$NAME\""
  cloudflared tunnel create "$NAME" >/dev/null
  ID=$(cloudflared tunnel list --output json \
    | python3 -c "import sys,json;print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'))")
  echo "  created $ID"
fi

sed -e "s|REPLACE_WITH_TUNNEL_ID|$ID|g" \
    -e "s|/Users/REPLACE_ME|$HOME|g" \
    -e "s|fleet\.plastikworld\.xyz|$ZONE|g" \
    "$DIR/fleet-os.yml.example" > "$CONFIG"
echo "wrote $CONFIG"

# A wildcard record covers every deployed service without a DNS write per
# deploy — which would otherwise be a rate-limited API call on the hot path.
for host in "$ZONE" "api.$ZONE" "*.$ZONE"; do
  printf "  routing %-32s " "$host"
  if cloudflared tunnel route dns "$NAME" "$host" >/dev/null 2>&1; then
    echo "ok"
  else
    echo "already routed (or needs doing in the dashboard)"
  fi
done

echo
echo "Start it with:"
echo "  cloudflared tunnel --config $CONFIG run"
