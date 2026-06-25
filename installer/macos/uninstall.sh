#!/bin/bash
# Clean uninstall for the GoNails PAX Agent. Run with sudo.
#
#   sudo bash /usr/local/share/pax-agent/uninstall.sh
#
# Removes: LaunchDaemon, binary, config (with confirmation), logs (with confirmation).
set -e

if [ "$EUID" -ne 0 ]; then
  echo "Please run with sudo:  sudo bash $0"
  exit 1
fi

PLIST="/Library/LaunchDaemons/com.gonails.paxagent.plist"
BIN="/usr/local/bin/pax-agent"
CONFIG_DIR="/Library/Application Support/GoNails/PaxAgent"
LOG_DIR="/Library/Logs/GoNails/PaxAgent"
PKG_RECEIPT="com.gonails.paxagent"

echo "Stopping service..."
[ -f "$PLIST" ] && /bin/launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

echo "Removing binary + .app..."
rm -f "$BIN"
rm -rf "/Applications/GoNails PAX Agent.app"

read -p "Remove config (token + device settings) at $CONFIG_DIR? [y/N] " ans
if [[ "$ans" =~ ^[Yy]$ ]]; then
  rm -rf "$CONFIG_DIR"
fi

read -p "Remove logs at $LOG_DIR? [y/N] " ans
if [[ "$ans" =~ ^[Yy]$ ]]; then
  rm -rf "$LOG_DIR"
fi

# Forget the package receipt so reinstall is treated as fresh.
pkgutil --forget "$PKG_RECEIPT" 2>/dev/null || true

# Self-cleanup of helper dir.
rm -rf "/usr/local/share/pax-agent"

echo "✓ Uninstalled."
