#!/usr/bin/env bash
# Installs Masthead for the current user: the app under ~/.local/lib/masthead, a `masthead`
# command, a background service that starts at login, and a launcher entry.
# Nothing here needs root. Run it again to update.
# Usage: scripts/install.sh [--force]   (--force restarts even while agents are working)
set -euo pipefail

force=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/path.sh
. "$here/scripts/path.sh"
lib="${HOME}/.local/lib/masthead"
bin="${HOME}/.local/bin"
# Always where `systemctl --user` reads units: its own XDG_CONFIG_HOME may differ from this shell's.
unit_dir="$HOME/.config/systemd/user"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then echo "Node.js 22 or newer is required." >&2; exit 1; fi
node_major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then echo "Node.js 22 or newer is required (found $("$node_bin" -v))." >&2; exit 1; fi

claude_bin="$(command -v claude || true)"
if [ -z "$claude_bin" ]; then
  for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "$HOME/.npm-global/bin/claude" "$HOME/.bun/bin/claude"; do
    if [ -x "$c" ]; then claude_bin="$c"; break; fi
  done
fi
if [ -z "$claude_bin" ]; then
  echo "Note: Claude Code was not found on PATH. Install it and sign in with \`claude\` before using Masthead." >&2
fi

echo "Building…"
cd "$here"
# npm keeps node_modules/.package-lock.json up to date; a lock file newer than it (a pull, a checkout)
# means the dependencies changed.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund
fi
npm run --silent build

# The service's port: MASTHEAD_PORT if set, else the one an installed unit already uses (a service installed
# with `masthead service install --port N` keeps N), else the default 7717.
port="${MASTHEAD_PORT:-}"
if [ -z "$port" ] && [ -f "$unit_dir/masthead.service" ]; then
  port="$(grep -o 'MASTHEAD_PORT=[0-9]*' "$unit_dir/masthead.service" | head -n 1 | cut -d= -f2 || true)"
fi
port="${port:-7717}"
case "$port" in ''|*[!0-9]*) echo "MASTHEAD_PORT must be a port number (found $port)." >&2; exit 2 ;; esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then echo "MASTHEAD_PORT must be between 1 and 65535 (found $port)." >&2; exit 2; fi

# Restarting stops every agent that is working. Ask the running copy first (on the service's port).
busy="$(MASTHEAD_PORT="$port" "$node_bin" -e '
fetch(`http://127.0.0.1:${process.env.MASTHEAD_PORT}/api/health`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.json())
  .then((b) => console.log(b.name !== "masthead" ? 0 : typeof b.busy === "number" ? b.busy : "unknown"))
  .catch(() => console.log(0));
')"
if [ "$busy" != "0" ] && [ "$force" -ne 1 ]; then
  if [ "$busy" = "unknown" ]; then
    msg="Masthead is running and cannot say whether agents are working (it is an older version)."
  else
    msg="Masthead has agents working in $busy conversation(s)."
  fi
  if [ -t 0 ]; then
    read -r -p "$msg Updating restarts it and stops them. Continue? [y/N] " answer
    case "$answer" in [yY]*) ;; *) echo "Nothing was changed."; exit 1 ;; esac
  else
    echo "$msg Nothing was changed. Run again when they have finished, or with --force." >&2
    exit 1
  fi
fi

echo "Installing to $lib"
mkdir -p "$(dirname "$lib")" "$bin" "$unit_dir" "$apps" "$icons"
# Build the new copy beside the old one and swap them, so the running server never loses its files
# halfway through. Installed dependencies are reused (hard links) when the lock file is unchanged.
stage="$lib.new"
rm -rf "${stage:?}"
mkdir -p "$stage"
cp -r "$here/dist" "$stage/dist"
cp "$here/package.json" "$here/package-lock.json" "$stage/"
if [ -d "$lib/node_modules" ] && cmp -s "$here/package-lock.json" "$lib/package-lock.json"; then
  cp -al "$lib/node_modules" "$stage/node_modules" 2>/dev/null || cp -a "$lib/node_modules" "$stage/node_modules"
else
  # The optional package holds a private copy of Claude Code. Masthead runs the one you installed.
  (cd "$stage" && npm ci --omit=dev --omit=optional --no-audit --no-fund --silent)
fi
rm -rf "${lib:?}.old"
if [ -d "$lib" ]; then mv "$lib" "$lib.old"; fi
if ! mv "$stage" "$lib"; then
  # Put the previous copy back so the installed command and service keep working.
  if [ ! -d "$lib.old" ]; then
    echo "Could not move the new copy into $lib (there was no previous installation). The new copy is in $stage." >&2
  elif [ ! -e "$lib" ] && mv "$lib.old" "$lib"; then
    echo "Could not move the new copy into $lib. The previous installation is back in place; the new copy is in $stage." >&2
  else
    echo "Could not move the new copy into $lib, nor put the previous one back. The previous copy is in $lib.old and the new one in $stage." >&2
  fi
  exit 1
fi

# Quoting for the generated files, so paths with spaces or odd characters still work.
unit_quote() { # one systemd unit word: backslash and double quote escaped, % doubled; no line breaks
  case "$1" in *$'\n'*|*$'\r'*) echo "A value for the service contains a line break: $1" >&2; exit 1 ;; esac
  local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//%/%%}"; printf '"%s"' "$s"
}
exec_quote() { # a word on an Exec line also needs $ doubled
  local s="${1//\$/\$\$}"; unit_quote "$s"
}
desktop_quote() { # a desktop entry Exec argument (quoted, then escaped again as a string value)
  local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//\`/\\\`}"; s="${s//\$/\\\$}"
  s="\"$s\""; s="${s//\\/\\\\}"; s="${s//%/%%}"; printf '%s' "$s"
}

{
  echo '#!/usr/bin/env bash'
  printf 'exec %q --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED %q "$@"\n' "$node_bin" "$lib/dist/server/main.js"
} > "$bin/masthead"
chmod +x "$bin/masthead"

# The service gets the PATH this script runs with, so `claude` and the tools agents call are found
# wherever they are installed (~/.npm-global, ~/.bun, ...).
unit_path="$(dirname "$node_bin")"
[ -n "$claude_bin" ] && unit_path="$unit_path:$(dirname "$claude_bin")"
unit_path="$unit_path:$PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
unit_path="$(clean_path "$unit_path")"
unit_env="Environment=$(unit_quote "PATH=$unit_path")"
[ -n "$claude_bin" ] && unit_env="$unit_env"$'\n'"Environment=$(unit_quote "MASTHEAD_CLAUDE=$claude_bin")"
# Settings, conversations and the local secret must be where the `masthead` command looks for them.
[ "$port" != 7717 ] && unit_env="$unit_env"$'\n'"Environment=$(unit_quote "MASTHEAD_PORT=$port")"
[ -n "${XDG_CONFIG_HOME:-}" ] && unit_env="$unit_env"$'\n'"Environment=$(unit_quote "XDG_CONFIG_HOME=$XDG_CONFIG_HOME")"
[ -n "${XDG_DATA_HOME:-}" ] && unit_env="$unit_env"$'\n'"Environment=$(unit_quote "XDG_DATA_HOME=$XDG_DATA_HOME")"

cat > "$unit_dir/masthead.service" <<UNIT
[Unit]
Description=Masthead: a local app for a tiered team of Claude agents
After=network-online.target

[Service]
ExecStart=$(exec_quote "$node_bin") --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED $(exec_quote "$lib/dist/server/main.js") serve
$unit_env
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
UNIT

# The launcher entry runs the command by its full path; ~/.local/bin is often not on a desktop session's PATH.
desktop_exec="Exec=$(desktop_quote "$bin/masthead")"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    Exec=*) printf '%s\n' "$desktop_exec" ;;
    \#*) ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$here/packaging/masthead.desktop" > "$apps/masthead.desktop"
cp "$here/packaging/masthead.svg" "$icons/masthead.svg"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --quiet masthead.service
  systemctl --user restart masthead.service
  echo "Masthead is running as a user service and will start when you log in."
else
  echo "systemd user services are not available here; start it with: masthead"
fi
rm -rf "${lib:?}.old"

case ":$PATH:" in *":$bin:"*) ;; *) echo "Note: $bin is not on your PATH. Add it to run \`masthead\`." ;; esac
echo "Done. Open it with: masthead"
