#!/bin/sh
# Fleet OS agent installer (PRD FR-1).
#
#   curl -fsSL fleet-os.dev/install | sh -s -- --token flp_...
#
# POSIX sh on purpose: a Raspberry Pi OS Lite image and an Alpine VPS do not
# both have bash, and an installer is a bad place to discover that.
set -eu

CONTROL_PLANE="${FLEET_CONTROL_PLANE:-https://api.fleet-os.dev}"   # rewritten by GET /install
DOWNLOAD_BASE="${FLEET_DOWNLOAD_BASE:-https://dl.fleet-os.dev}"   # rewritten by GET /install
VERSION="${FLEET_VERSION:-latest}"
TOKEN="${FLEET_PAIRING_TOKEN:-}"
BIN_DIR="${FLEET_BIN_DIR:-/usr/local/bin}"
STATE_DIR="${FLEET_STATE_DIR:-/var/lib/fleet-os}"
RESET=0
ADVERTISE_ADDR="${FLEET_ADVERTISE_ADDR:-}"
CONFIGURE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --token)         TOKEN="$2"; shift 2 ;;
    --control-plane) CONTROL_PLANE="$2"; shift 2 ;;
    --version)       VERSION="$2"; shift 2 ;;
    --advertise-addr) ADVERTISE_ADDR="$2"; shift 2 ;;
    --configure)     CONFIGURE=1; shift ;;
    --reset)         RESET=1; shift ;;
    --help|-h)
      echo "usage: install.sh --token <pairing-token> [--control-plane URL] [--version V] [--advertise-addr HOST] [--reset]"
      echo "       install.sh --configure --advertise-addr HOST"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "fleet-os: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

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

# A Mac agent is deliberately a per-user LaunchAgent, so its state belongs in
# that user's Library rather than under /var/lib. Resolve this before any work
# so a repeat of the one-line installer can return cleanly without sudo,
# downloads, or rewriting the service definition.
if [ "$os" = darwin ]; then
  STATE_DIR="${FLEET_STATE_DIR_DARWIN:-${FLEET_STATE_DIR:-$HOME/Library/Application Support/fleet-os}}"
fi

state_file="$STATE_DIR/agent.json"
if [ -f "$state_file" ] && [ "$RESET" != 1 ] && [ "$CONFIGURE" != 1 ]; then
  installed_version=""
  if [ -x "$BIN_DIR/fleet-agent" ]; then
    installed_version=$("$BIN_DIR/fleet-agent" --version 2>/dev/null || true)
  fi
  echo "fleet-os: agent already installed${installed_version:+ ($installed_version)}"
  echo "          state: $state_file"
  echo "          no changes made"
  echo "          to deliberately pair this machine again: add --reset with a fresh token"
  exit 0
fi

if [ "$CONFIGURE" != 1 ]; then
  [ -n "$TOKEN" ] || die "a pairing token is required: generate one in the dashboard, then pass --token"
fi

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
case "$DOWNLOAD_BASE" in
  */install) url="${DOWNLOAD_BASE}/${asset}" ;;      # self-hosted control plane
  *)         url="${DOWNLOAD_BASE}/${VERSION}/${asset}" ;;
esac

echo "fleet-os: installing agent (${os}/${arch}, ${VERSION})"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

$fetch "$url" > "$tmp/fleet-agent" || die "download failed: $url"
[ -s "$tmp/fleet-agent" ] || die "downloaded file is empty: $url"

# Verify against the published checksums when they are reachable. A failed
# checksum aborts; an unreachable checksum file only warns, so a temporary
# CDN problem does not block an install.
if $fetch "$(dirname "$url")/SHA256SUMS" > "$tmp/SHA256SUMS" 2>/dev/null; then
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
$SUDO mkdir -p "$BIN_DIR"
if [ "$os" = darwin ]; then
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
else
  $SUDO mkdir -p "$STATE_DIR"
  $SUDO chmod 700 "$STATE_DIR"
fi
$SUDO mv "$tmp/fleet-agent" "$BIN_DIR/fleet-agent"

echo "fleet-os: detected capability:"
"$BIN_DIR/fleet-agent" -capabilities | sed 's/^/          /'

# ── service ────────────────────────────────────────────────────────
register_now() {
  state_file="$STATE_DIR/agent.json"
  if [ "$CONFIGURE" = 1 ]; then
    [ -f "$state_file" ] || die "--configure needs an existing agent state at $state_file"
    echo "fleet-os: updating agent configuration; keeping the existing node identity"
    return
  fi
  if [ -f "$state_file" ]; then
    if [ "$RESET" != 1 ]; then
      die "this machine is already registered ($state_file); a pairing token would be ignored. If its credential was revoked, rerun with --reset to pair it again"
    fi
    backup="$STATE_DIR/agent.revoked-$(date +%Y%m%d-%H%M%S).json"
    mv "$state_file" "$backup"
    echo "fleet-os: saved previous agent state to $backup"
  fi

  # Pair in the foreground so a bad token is an error the user is still
  # watching, rather than a restart loop found later in a log.
  echo "fleet-os: pairing with ${CONTROL_PLANE}"
  if [ -n "$ADVERTISE_ADDR" ]; then
    $1 env FLEET_STATE_DIR="$STATE_DIR" FLEET_ADVERTISE_ADDR="$ADVERTISE_ADDR" "$BIN_DIR/fleet-agent" \
      --control-plane "$CONTROL_PLANE" --token "$TOKEN" --register-only \
      || die "pairing failed — the token may be expired or already used"
  else
    $1 env FLEET_STATE_DIR="$STATE_DIR" "$BIN_DIR/fleet-agent" \
      --control-plane "$CONTROL_PLANE" --token "$TOKEN" --register-only \
      || die "pairing failed — the token may be expired or already used"
  fi
}

if [ "$os" = linux ] && have systemctl; then
  $SUDO tee /etc/systemd/system/fleet-agent.service >/dev/null <<UNIT
[Unit]
Description=Fleet OS agent
Documentation=${CONTROL_PLANE}
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BIN_DIR}/fleet-agent --control-plane ${CONTROL_PLANE}
Environment=FLEET_STATE_DIR=${STATE_DIR}
${ADVERTISE_ADDR:+Environment=FLEET_ADVERTISE_ADDR=${ADVERTISE_ADDR}}
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${STATE_DIR}

[Install]
WantedBy=multi-user.target
UNIT

  register_now "$SUDO"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now fleet-agent
  echo "fleet-os: agent installed and running (systemctl status fleet-agent)"

elif [ "$os" = darwin ]; then
  # launchd, as a per-user LaunchAgent. A LaunchDaemon would need root and a
  # root-owned state directory; the agent only needs the Docker socket, which
  # Docker Desktop exposes to the logged-in user anyway.
  register_now ""

  PLIST="$HOME/Library/LaunchAgents/dev.fleet-os.agent.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.fleet-os.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN_DIR}/fleet-agent</string>
    <string>--control-plane</string>
    <string>${CONTROL_PLANE}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FLEET_STATE_DIR</key><string>${STATE_DIR}</string>
$(if [ -n "$ADVERTISE_ADDR" ]; then printf '    <key>FLEET_ADVERTISE_ADDR</key><string>%s</string>\n' "$ADVERTISE_ADDR"; fi)
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${STATE_DIR}/agent.log</string>
  <key>StandardErrorPath</key><string>${STATE_DIR}/agent.log</string>
</dict>
</plist>
PLISTEOF

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "fleet-os: agent installed and running"
  echo "          logs:  tail -f \"$STATE_DIR/agent.log\""
  echo "          stop:  launchctl unload \"$PLIST\""

else
  register_now "$SUDO"
  echo "fleet-os: no service manager found — start the agent yourself:"
  echo "          FLEET_STATE_DIR=$STATE_DIR${ADVERTISE_ADDR:+ FLEET_ADVERTISE_ADDR=$ADVERTISE_ADDR} $BIN_DIR/fleet-agent --control-plane $CONTROL_PLANE"
fi
