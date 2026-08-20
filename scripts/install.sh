#!/bin/sh
# Fleet OS agent installer (PRD FR-1).
#
#   curl -fsSL fleet-os.dev/install | sh -s -- --token flp_...
#
# POSIX sh on purpose: a Raspberry Pi OS Lite image and an Alpine VPS do not
# both have bash, and an installer is a bad place to discover that.
set -eu

CONTROL_PLANE="${FLEET_CONTROL_PLANE:-https://api.fleet-os.dev}"
DOWNLOAD_BASE="${FLEET_DOWNLOAD_BASE:-https://dl.fleet-os.dev}"
VERSION="${FLEET_VERSION:-latest}"
TOKEN="${FLEET_PAIRING_TOKEN:-}"
BIN_DIR="${FLEET_BIN_DIR:-/usr/local/bin}"
STATE_DIR="${FLEET_STATE_DIR:-/var/lib/fleet-os}"

while [ $# -gt 0 ]; do
  case "$1" in
    --token)         TOKEN="$2"; shift 2 ;;
    --control-plane) CONTROL_PLANE="$2"; shift 2 ;;
    --version)       VERSION="$2"; shift 2 ;;
    --help|-h)
      echo "usage: install.sh --token <pairing-token> [--control-plane URL] [--version V]"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "fleet-os: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ -n "$TOKEN" ] || die "a pairing token is required: generate one in the dashboard, then pass --token"

# ── platform ────────────────────────────────────────────────────────
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux|darwin) ;;
  *) die "unsupported operating system: $os" ;;
esac

case "$(uname -m)" in
  aarch64|arm64)  arch=arm64 ;;
  armv7l|armv6l)  arch=armv7 ;;
  x86_64|amd64)   arch=amd64 ;;
  *) die "unsupported architecture: $(uname -m) (arm64, armv7 and amd64 are supported)" ;;
esac

# ── preflight ───────────────────────────────────────────────────────
# Check before downloading anything, so a machine that cannot run the agent
# fails in two seconds rather than after a install.
if [ "$os" = linux ] && ! have docker; then
  echo "fleet-os: warning — docker was not found on PATH."
  echo "          the agent will register and report health, but cannot run"
  echo "          workloads until a container runtime is installed."
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  have sudo || die "not running as root and sudo is unavailable; re-run as root"
  SUDO="sudo"
fi

if have curl; then fetch="curl -fsSL"
elif have wget; then fetch="wget -qO-"
else die "neither curl nor wget is available"
fi

asset="fleet-agent-${os}-${arch}"
url="${DOWNLOAD_BASE}/${VERSION}/${asset}"

echo "fleet-os: installing agent (${os}/${arch}, ${VERSION})"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

$fetch "$url" > "$tmp/fleet-agent" || die "download failed: $url"
[ -s "$tmp/fleet-agent" ] || die "downloaded file is empty: $url"

# Verify against the published checksums when they are reachable. A failed
# checksum aborts; an unreachable checksum file only warns, so a temporary
# CDN problem does not block an install.
if $fetch "${DOWNLOAD_BASE}/${VERSION}/SHA256SUMS" > "$tmp/SHA256SUMS" 2>/dev/null; then
  expected=$(grep " ${asset}\$" "$tmp/SHA256SUMS" | awk '{print $1}')
  if [ -n "$expected" ]; then
    if have sha256sum; then actual=$(sha256sum "$tmp/fleet-agent" | awk '{print $1}')
    elif have shasum;    then actual=$(shasum -a 256 "$tmp/fleet-agent" | awk '{print $1}')
    else actual=""
    fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      die "checksum mismatch — refusing to install (expected $expected, got $actual)"
    fi
    [ -n "$actual" ] && echo "fleet-os: checksum verified"
  fi
else
  echo "fleet-os: warning — could not fetch SHA256SUMS, skipping verification"
fi

chmod +x "$tmp/fleet-agent"
$SUDO mkdir -p "$BIN_DIR" "$STATE_DIR"
$SUDO chmod 700 "$STATE_DIR"
$SUDO mv "$tmp/fleet-agent" "$BIN_DIR/fleet-agent"

echo "fleet-os: detected capability:"
"$BIN_DIR/fleet-agent" -capabilities | sed 's/^/          /'

# ── service ─────────────────────────────────────────────────────────
if [ "$os" = linux ] && have systemctl; then
  $SUDO tee /etc/systemd/system/fleet-agent.service >/dev/null <<UNIT
[Unit]
Description=Fleet OS agent
Documentation=https://fleet-os.dev/#/docs
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BIN_DIR}/fleet-agent --control-plane ${CONTROL_PLANE}
Environment=FLEET_STATE_DIR=${STATE_DIR}
Restart=always
RestartSec=5
# The agent talks to the Docker socket and writes only its own state dir.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${STATE_DIR}

[Install]
WantedBy=multi-user.target
UNIT

  # Register once, in the foreground, so a bad token is an error the user
  # sees now rather than a restart loop they have to go find in journalctl.
  echo "fleet-os: pairing with ${CONTROL_PLANE}"
  $SUDO env FLEET_STATE_DIR="$STATE_DIR" "$BIN_DIR/fleet-agent" \
    --control-plane "$CONTROL_PLANE" --token "$TOKEN" --register-only \
    || die "pairing failed — the token may be expired or already used"

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now fleet-agent
  echo "fleet-os: agent installed and running (systemctl status fleet-agent)"
else
  echo "fleet-os: no systemd on this host — start the agent yourself:"
  echo "          FLEET_STATE_DIR=$STATE_DIR $BIN_DIR/fleet-agent \\"
  echo "            --control-plane $CONTROL_PLANE --token $TOKEN"
fi
