# shellcheck shell=bash
# Sourced by install.sh. Kept in its own file so the tests can run it without running the installer.

# clean_path PATH: the same list without empty or relative entries (".", "bin", anything not starting
# with "/") and without repeats, in the original order. A relative entry in a service's PATH would be
# looked up from wherever the service happens to run.
clean_path() {
  local out="" dir parts
  IFS=: read -r -a parts <<< "$1"
  for dir in "${parts[@]}"; do
    case "$dir" in /*) ;; *) continue ;; esac
    case ":$out:" in *":$dir:"*) continue ;; esac
    out="${out:+$out:}$dir"
  done
  printf '%s' "$out"
}
