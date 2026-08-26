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

# ── colors ──────────────────────────────────────────────────────────
ESC=$(printf '\033')
if [ -t 1 ]; then
  GREEN="${ESC}[32m" CYAN="${ESC}[36m" DIM="${ESC}[2m" BOLD="${ESC}[1m"
  RED="${ESC}[31m" YELLOW="${ESC}[33m" RESET_C="${ESC}[0m"
else
  GREEN='' CYAN='' DIM='' BOLD='' RED='' YELLOW='' RESET_C=''
fi

info()  { printf "  %s✔%s  %s\n" "$GREEN" "$RESET_C" "$*"; }
warn()  { printf "  %s▲%s  %s\n" "$YELLOW" "$RESET_C" "$*"; }
fail()  { printf "  %s✖%s  %s\n" "$RED" "$RESET_C" "$*" >&2; exit 1; }
step()  { printf "\n%s── %s ─────────────────────────────────────────────%s\n" "$DIM" "$*" "$RESET_C"; }
kv()    { printf "     %s%-16s%s %s\n" "$DIM" "$1" "$RESET_C" "$2"; }

banner() {
  printf "\n"
  printf "  ${BOLD}${GREEN}    ○     ○     ○${RESET_C}\n"
  printf "  ${BOLD}${GREEN}     ╲    │    ╱       █▀▀ █   █▀▀ █▀▀ ▀█▀${RESET_C}\n"
  printf "  ${BOLD}${GREEN}  ○───────◉───────○    █▀  █   █▀  █▀   █${RESET_C}\n"
  printf "  ${BOLD}${GREEN}     ╱    │    ╲       ▀   ▀▀▀ ▀▀▀ ▀▀▀  ▀${RESET_C}\n"
  printf "  ${BOLD}${GREEN}    ○     ○     ○${RESET_C}      ${DIM}agent installer${RESET_C}\n"
  printf "\n"
}

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

die() { fail "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── platform ────────────────────────────────────────────────────────
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux|darwin) ;;
  mingw*|msys*|cygwin*|windows*) os=windows ;;
  *) die "unsupported operating system: $os" ;;
esac

case "$(uname -m)" in
  aarch64|arm64)  arch=arm64 ;;
  armv7l|armv6l)  arch=armv7 ;;
  x86_64|amd64)   arch=amd64 ;;
  *) die "unsupported architecture: $(uname -m) (arm64, armv7 and amd64 are supported)" ;;
esac

ext=""
if [ "$os" = windows ]; then
  ext=".exe"
  BIN_DIR="${FLEET_BIN_DIR:-$HOME/bin}"
  STATE_DIR="${FLEET_STATE_DIR_WINDOWS:-${FLEET_STATE_DIR:-$HOME/.fleet-os}}"
elif [ "$os" = darwin ]; then
  STATE_DIR="${FLEET_STATE_DIR_DARWIN:-${FLEET_STATE_DIR:-$HOME/Library/Application Support/fleet-os}}"
fi

bin_name="fleet-agent${ext}"
state_file="$STATE_DIR/agent.json"
if [ -f "$state_file" ] && [ "$RESET" != 1 ] && [ "$CONFIGURE" != 1 ]; then
  installed_version=""
  if [ -x "$BIN_DIR/$bin_name" ]; then
    installed_version=$("$BIN_DIR/$bin_name" --version 2>/dev/null || true)
  fi
  banner
  step "already installed"
  kv "version" "${installed_version:-unknown}"
  kv "state" "$state_file"
  printf "\n"
  info "no changes made"
  printf "     ${DIM}to re-pair: add ${CYAN}--reset${RESET_C}${DIM} with a fresh token${RESET_C}\n\n"
  exit 0
fi

if [ "$CONFIGURE" != 1 ]; then
  [ -n "$TOKEN" ] || die "a pairing token is required: generate one in the dashboard, then pass --token"
fi

banner

SUDO=""
if [ "$os" != windows ] && [ "$(id -u)" -ne 0 ]; then
  have sudo || die "not running as root and sudo is unavailable; re-run as root"
  SUDO="sudo"
fi

if have curl; then fetch="curl -fsSL"
elif have wget; then fetch="wget -qO-"
else die "neither curl nor wget is available"
fi

# ── preflight & runtime setup ───────────────────────────────────────
if [ "$os" = linux ]; then
  # Check if running in WSL or Windows Git Bash
  if [ -n "${WSL_DISTRO_NAME:-}" ] || echo "$PATH" | grep -q "/mnt/c"; then
    if ! have docker || ! docker info >/dev/null 2>&1; then
      if [ -f "/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe" ]; then
        step "runtime setup"
        info "launching Docker Desktop on Windows..."
        cmd.exe /c "start \"\" \"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe\"" 2>/dev/null || true
        sleep 3
      fi
    fi
  elif ! have docker; then
    step "runtime setup"
    info "docker was not found — installing Docker automatically..."
    if [ -n "$fetch" ]; then
      $fetch https://get.docker.com | $SUDO sh 2>/dev/null || {
        if have apt-get; then
          $SUDO apt-get update -y && $SUDO apt-get install -y docker.io
        elif have yum; then
          $SUDO yum install -y docker
        elif have dnf; then
          $SUDO dnf install -y docker
        fi
      }
    fi
  fi

  if have systemctl; then
    if ! systemctl is-active --quiet docker 2>/dev/null; then
      $SUDO systemctl enable --now docker 2>/dev/null || true
    fi
  elif have service; then
    $SUDO service docker start 2>/dev/null || true
  fi

  if have docker; then
    info "docker container runtime is active"
  else
    warn "docker not found on PATH — workloads will wait until docker is installed"
  fi
elif [ "$os" = windows ]; then
  if ! have docker || ! docker info >/dev/null 2>&1; then
    step "runtime setup"
    if [ -f "/c/Program Files/Docker/Docker/Docker Desktop.exe" ]; then
      info "launching Docker Desktop on Windows..."
      cmd.exe /c "start \"\" \"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe\"" 2>/dev/null || true
      sleep 3
    elif [ -f "/c/Program Files/Docker/Docker Desktop.exe" ]; then
      info "launching Docker Desktop on Windows..."
      cmd.exe /c "start \"\" \"C:\\Program Files\\Docker\\Docker Desktop.exe\"" 2>/dev/null || true
      sleep 3
    elif have winget.exe; then
      info "docker not found — installing Docker Desktop via winget..."
      winget.exe install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements --silent 2>/dev/null || true
    else
      warn "docker not found — install Docker Desktop from https://docker.com to run workloads on this node"
    fi
  fi
elif [ "$os" = darwin ]; then
  if ! docker info >/dev/null 2>&1; then
    info "launching Docker Desktop on macOS..."
    open -a Docker 2>/dev/null || true
  fi
fi

asset="fleet-agent-${os}-${arch}${ext}"
case "$DOWNLOAD_BASE" in
  */install) url="${DOWNLOAD_BASE}/${asset}?v=0.1.0" ;;
  *)         url="${DOWNLOAD_BASE}/${VERSION}/${asset}?v=0.1.0" ;;
esac

step "download"
kv "platform" "${os}/${arch}"
kv "version" "${VERSION}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

$fetch "$url" > "$tmp/$bin_name" || die "download failed: $url"
[ -s "$tmp/$bin_name" ] || die "downloaded file is empty: $url"

if $fetch "$(dirname "$url")/SHA256SUMS" > "$tmp/SHA256SUMS" 2>/dev/null; then
  expected=$(grep " ${asset}\$" "$tmp/SHA256SUMS" | awk '{print $1}')
  if [ -n "$expected" ]; then
    if have sha256sum; then actual=$(sha256sum "$tmp/$bin_name" | awk '{print $1}')
    elif have shasum;    then actual=$(shasum -a 256 "$tmp/$bin_name" | awk '{print $1}')
    else actual=""
    fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      die "checksum mismatch — refusing to install (expected $expected, got $actual)"
    fi
    [ -n "$actual" ] && info "checksum verified"
  fi
else
  warn "could not fetch SHA256SUMS, skipping verification"
fi

chmod +x "$tmp/$bin_name"
$SUDO mkdir -p "$BIN_DIR"
if [ "$os" = darwin ] || [ "$os" = windows ]; then
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
else
  $SUDO mkdir -p "$STATE_DIR"
  $SUDO chmod 700 "$STATE_DIR"
fi
$SUDO mv "$tmp/$bin_name" "$BIN_DIR/$bin_name"
info "binary installed to ${BIN_DIR}/$bin_name"

step "capability detection"
cap_json=$("$BIN_DIR/$bin_name" -capabilities 2>/dev/null || echo '{}')
cap_arch=$(echo "$cap_json" | grep '"arch"' | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
cap_os=$(echo "$cap_json" | grep '"os"' | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
cap_cpu=$(echo "$cap_json" | grep '"cpu_cores"' | head -1 | sed 's/.*: *\([0-9]*\).*/\1/')
cap_ram=$(echo "$cap_json" | grep '"ram_mb"' | head -1 | sed 's/.*: *\([0-9]*\).*/\1/')
cap_disk=$(echo "$cap_json" | grep '"disk_mb"' | head -1 | sed 's/.*: *\([0-9]*\).*/\1/')
cap_gpu=$(echo "$cap_json" | grep '"gpu"' | head -1 | sed 's/.*: *\([a-z]*\).*/\1/')
cap_host=$(echo "$cap_json" | grep '"hostname"' | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
cap_addr=$(echo "$cap_json" | grep '"advertise_addr"' | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')

if [ -n "$cap_ram" ] && [ "$cap_ram" -ge 1024 ] 2>/dev/null; then
  ram_display="$(echo "$cap_ram" | awk '{printf "%.1f GB", $1/1024}')"
else
  ram_display="${cap_ram:-?} MB"
fi
if [ -n "$cap_disk" ] && [ "$cap_disk" -ge 1024 ] 2>/dev/null; then
  disk_display="$(echo "$cap_disk" | awk '{printf "%.0f GB", $1/1024}')"
else
  disk_display="${cap_disk:-?} MB"
fi

kv "hostname" "${BOLD}${cap_host:-unknown}${RESET_C}"
kv "arch" "${cap_arch:-?}"
kv "os" "${cap_os:-?}"
kv "cpu" "${cap_cpu:-?} cores"
kv "ram" "$ram_display"
kv "disk" "$disk_display"
kv "gpu" "${cap_gpu:-false}"
kv "address" "${cap_addr:-not detected}"

# ── service ────────────────────────────────────────────────────────
register_now() {
  state_file="$STATE_DIR/agent.json"
  if [ "$CONFIGURE" = 1 ]; then
    [ -f "$state_file" ] || die "--configure needs an existing agent state at $state_file"
    info "updating agent configuration; keeping existing node identity"
    return
  fi
  if [ -f "$state_file" ]; then
    if [ "$RESET" != 1 ]; then
      die "already registered ($state_file). Rerun with --reset to pair again."
    fi
    backup="$STATE_DIR/agent.revoked-$(date +%Y%m%d-%H%M%S).json"
    mv "$state_file" "$backup"
    warn "saved previous state to $backup"
  fi

  step "pairing"
  kv "control plane" "$CONTROL_PLANE"
  if [ -n "$ADVERTISE_ADDR" ]; then
    $1 env FLEET_STATE_DIR="$STATE_DIR" FLEET_ADVERTISE_ADDR="$ADVERTISE_ADDR" "$BIN_DIR/$bin_name" \
      --control-plane "$CONTROL_PLANE" --token "$TOKEN" --register-only \
      || die "pairing failed — the token may be expired or already used"
  else
    $1 env FLEET_STATE_DIR="$STATE_DIR" "$BIN_DIR/$bin_name" \
      --control-plane "$CONTROL_PLANE" --token "$TOKEN" --register-only \
      || die "pairing failed — the token may be expired or already used"
  fi
  info "paired successfully"
}

if [ "$os" = linux ] && have systemctl; then
  $SUDO tee /etc/systemd/system/fleet-agent.service >/dev/null <<UNIT
[Unit]
Description=Fleet OS agent
Documentation=${CONTROL_PLANE}
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
ExecStart=${BIN_DIR}/$bin_name --control-plane ${CONTROL_PLANE}
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
  $SUDO systemctl enable --now docker 2>/dev/null || true
  $SUDO systemctl enable --now fleet-agent

  step "ready"
  info "agent installed and running"
  printf "\n"
  kv "status" "systemctl status fleet-agent"
  kv "logs" "journalctl -fu fleet-agent"
  kv "stop" "systemctl stop fleet-agent"
  printf "\n"

elif [ "$os" = darwin ]; then
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
    <string>${BIN_DIR}/$bin_name</string>
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

  step "ready"
  info "agent installed and running"
  printf "\n"
  kv "logs" "tail -f \"$STATE_DIR/agent.log\""
  kv "stop" "launchctl unload \"$PLIST\""
  kv "dashboard" "${CYAN}fleet status${RESET_C}"
  printf "\n"

elif [ "$os" = windows ]; then
  register_now ""

  # Launch as a persistent background process in Windows.
  # Git Bash (MSYS2/MinGW) uses POSIX paths internally; we must convert them
  # to Windows-native paths before handing off to PowerShell or cmd.exe.
  win_bin=$(cygpath -w "$BIN_DIR/$bin_name" 2>/dev/null || echo "$BIN_DIR/$bin_name")
  win_state_dir=$(cygpath -w "$STATE_DIR" 2>/dev/null || echo "$STATE_DIR")

  # Kill any existing agent so a --reset truly restarts clean.
  taskkill.exe /IM "$bin_name" /F >/dev/null 2>&1 || true
  sleep 1

  # The agent reads FLEET_STATE_DIR to find agent.json. Passing it as an
  # environment variable is more reliable than quoting a --state path through
  # three layers of shell escaping (sh → PowerShell → CreateProcess).
  if powershell.exe -NoProfile -NonInteractive -Command "
    \$env:FLEET_STATE_DIR = '$win_state_dir'
    Start-Process -FilePath '$win_bin' \`
      -ArgumentList '--control-plane','$CONTROL_PLANE' \`
      -WindowStyle Hidden \`
      -RedirectStandardOutput '$win_state_dir\\agent.log' \`
      -RedirectStandardError  '$win_state_dir\\agent.err.log'
  " 2>/dev/null; then
    info "agent launched via PowerShell"
  else
    # Fallback for environments where PowerShell is unavailable (rare).
    FLEET_STATE_DIR="$STATE_DIR" nohup "$BIN_DIR/$bin_name" \
      --control-plane "$CONTROL_PLANE" \
      > "$STATE_DIR/agent.log" 2>&1 &
    info "agent launched via nohup"
  fi

  step "ready"
  info "agent installed and running in background"
  printf "\n"
  kv "logs" "tail -f \"$STATE_DIR/agent.log\""
  kv "stop" "taskkill /IM $bin_name /F"
  kv "dashboard" "${CYAN}fleet status${RESET_C}"
  printf "\n"

else
  register_now "$SUDO"

  step "ready"
  warn "no service manager found — start the agent yourself:"
  printf "\n     ${DIM}FLEET_STATE_DIR=$STATE_DIR${ADVERTISE_ADDR:+ FLEET_ADVERTISE_ADDR=$ADVERTISE_ADDR} $BIN_DIR/$bin_name --control-plane $CONTROL_PLANE${RESET_C}\n\n"
fi
