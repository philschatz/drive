#!/usr/bin/env bash
# Manage the Drive CLI continuous-sync loop (`npm run cli -- sync`) as a
# systemd *user* service. Imperative on purpose: it only touches
# ~/.config/systemd/user/, so no root and no nixos-rebuild is needed.
set -euo pipefail

UNIT_NAME=drive-sync.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
REPO_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") <command>

Commands:
  install    Write $UNIT_FILE, reload systemd, enable the service
  uninstall  Stop, disable, and remove the service
  start      Start the service
  stop       Stop the service
  restart    Restart the service
  status     Show service status (exit code reflects active state)
  logs       Follow the service journal

The service runs \`npm run cli -- sync --forever\` in $REPO_ROOT and only runs
while you are logged in. \`sync\` now requires a run mode: --forever (used here)
or --duration <seconds>. Override CLI tunables (DRIVE_RELAY_URL, DRIVE_SYNC_SECONDS,
DRIVE_KEEP_OPEN, DRIVE_RECENT_DAYS, AUTOMERGE_DATA_DIR, DRIVE_ICE_SERVERS, and the
mode selectors DRIVE_SYNC_FOREVER / DRIVE_SYNC_DURATION) by adding Environment=
lines to the unit and re-running install... or just edit the unit.
EOF
  exit 1
}

install() {
  local npm_bin
  npm_bin="$(command -v npm)" || {
    echo "error: npm not found on PATH" >&2
    exit 1
  }
  [ -d "$REPO_ROOT/node_modules" ] || {
    echo "error: $REPO_ROOT/node_modules missing — run 'npm install' first" >&2
    exit 1
  }

  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Drive CLI continuous sync (headless peer)

[Service]
WorkingDirectory=$REPO_ROOT
Environment=PATH=$(dirname "$npm_bin"):/run/wrappers/bin:/usr/bin:/bin
ExecStart=$npm_bin run cli -- sync --forever
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "$UNIT_NAME"
  echo "installed and enabled $UNIT_NAME; start it with: $(basename "$0") start"
}

uninstall() {
  systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
  systemctl --user disable "$UNIT_NAME" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "removed $UNIT_NAME"
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  start | stop | restart) systemctl --user "$1" "$UNIT_NAME" ;;
  status) systemctl --user status "$UNIT_NAME" --no-pager ;;
  logs) journalctl --user -u "$UNIT_NAME" -f ;;
  *) usage ;;
esac
