#!/usr/bin/env bash
# Installs Masthead for the current user: the app under ~/.local/lib/masthead, a `masthead`
# command, a background service that starts at login, and a launcher entry.
# Nothing here needs root. Run it again to update.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lib="${HOME}/.local/lib/masthead"
bin="${HOME}/.local/bin"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then echo "Node.js 22 or newer is required." >&2; exit 1; fi
node_major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then echo "Node.js 22 or newer is required (found $("$node_bin" -v))." >&2; exit 1; fi

claude_bin="$(command -v claude || true)"
if [ -z "$claude_bin" ]; then
  echo "Note: Claude Code was not found on PATH. Install it and sign in with \`claude\` before using Masthead." >&2
fi

echo "Building…"
cd "$here"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run --silent build

echo "Installing to $lib"
mkdir -p "$lib" "$bin" "$unit_dir" "$apps" "$icons"
# Replace the previous build, keeping installed dependencies when they have not changed.
if [ -d "$lib/dist" ]; then rm -rf "${lib:?}/dist"; fi
cp -r "$here/dist" "$lib/dist"
if ! cmp -s "$here/package-lock.json" "$lib/package-lock.json" 2>/dev/null || [ ! -d "$lib/node_modules" ]; then
  cp "$here/package.json" "$here/package-lock.json" "$lib/"
  # The optional package holds a private copy of Claude Code. Masthead runs the one you installed.
  (cd "$lib" && npm ci --omit=dev --omit=optional --no-audit --no-fund --silent)
else
  cp "$here/package.json" "$lib/"
fi

cat > "$bin/masthead" <<LAUNCHER
#!/usr/bin/env bash
exec "$node_bin" --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED "$lib/dist/server/main.js" "\$@"
LAUNCHER
chmod +x "$bin/masthead"

cat > "$unit_dir/masthead.service" <<UNIT
[Unit]
Description=Masthead: a local app for a tiered team of Claude agents
After=network-online.target

[Service]
ExecStart=$node_bin --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED $lib/dist/server/main.js serve
Environment=PATH=$(dirname "$node_bin"):$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin
${claude_bin:+Environment=MASTHEAD_CLAUDE=$claude_bin}
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
UNIT

cp "$here/packaging/masthead.desktop" "$apps/masthead.desktop"
cp "$here/packaging/masthead.svg" "$icons/masthead.svg"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --quiet masthead.service
  systemctl --user restart masthead.service
  echo "Masthead is running as a user service and will start when you log in."
else
  echo "systemd user services are not available here; start it with: masthead"
fi

case ":$PATH:" in *":$bin:"*) ;; *) echo "Note: $bin is not on your PATH. Add it to run \`masthead\`." ;; esac
echo "Done. Open it with: masthead"
