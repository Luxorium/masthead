#!/usr/bin/env bash
# Removes what scripts/install.sh installed. Your conversations and settings are kept; their
# locations are printed at the end.
set -euo pipefail

lib="${HOME}/.local/lib/masthead"
unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/masthead.service"
data="${XDG_DATA_HOME:-$HOME/.local/share}"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now masthead.service >/dev/null 2>&1 || true
fi
rm -f "$unit" "${HOME}/.local/bin/masthead" "$data/applications/masthead.desktop" "$data/icons/hicolor/scalable/apps/masthead.svg"
if [ -d "$lib" ]; then rm -rf "${lib:?}"; fi
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 || true

echo "Masthead was removed."
echo "Kept: conversations in $data/masthead and settings in ${XDG_CONFIG_HOME:-$HOME/.config}/masthead"
