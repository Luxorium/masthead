#!/usr/bin/env bash
# Removes what scripts/install.sh installed. Your conversations and settings are kept; their
# locations are printed at the end.
set -euo pipefail

lib="${HOME}/.local/lib/masthead"
unit="$HOME/.config/systemd/user/masthead.service"
# Older installs may have written it under a custom XDG_CONFIG_HOME.
old_unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/masthead.service"
data="${XDG_DATA_HOME:-$HOME/.local/share}"

# `masthead stop` stops the service and also a copy started without it (on 7717, or MASTHEAD_PORT).
if [ -x "${HOME}/.local/bin/masthead" ]; then
  # Turn off Masthead's own Tailscale entry if remote access was on (it prints the command if it cannot).
  "${HOME}/.local/bin/masthead" remote off || true
  "${HOME}/.local/bin/masthead" stop >/dev/null 2>&1 || true
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now masthead.service >/dev/null 2>&1 || true
fi
rm -f "$unit" "$old_unit" "${HOME}/.local/bin/masthead" "$data/applications/masthead.desktop" "$data/icons/hicolor/scalable/apps/masthead.svg"
rm -rf "${lib:?}" "${lib:?}.new" "${lib:?}.old"
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 || true

echo "Masthead was removed."
echo "Kept: conversations in $data/masthead and settings in ${XDG_CONFIG_HOME:-$HOME/.config}/masthead"
