#!/usr/bin/env bash
set -euo pipefail

root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ss14-gui.XXXXXXXX")
driver_pid=''
cleanup() {
  if [[ -n "$driver_pid" ]]; then
    kill "$driver_pid" 2>/dev/null || true
    wait "$driver_pid" 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
export HOME="$root/home" XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$root/project/Resources/Prototypes" "$root/project/Resources/Textures" "$root/project/Resources/Locale"
export SMOKE_PROJECT="$root/project"
printf '%s\n' '[{type: entity, id: SmokeOriginal}]' > "$SMOKE_PROJECT/Resources/Prototypes/smoke.yml"
tauri-driver > "$root/driver.log" 2>&1 &
driver_pid=$!
if ! node tests/gui-smoke.mjs; then
  cat "$root/driver.log" >&2
  exit 1
fi
