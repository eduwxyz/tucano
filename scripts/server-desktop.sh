#!/usr/bin/env bash
# Optional private Linux desktop. Installs nothing; never exposes X11/VNC ports.
set -euo pipefail
fail() { printf 'Tucano desktop: %s\n' "$*" >&2; exit 1; }
check() {
  [[ $(uname -s) == Linux ]] || fail 'Linux is required.'
  local command
  for command in bash Xvfb xvfb-run xauth dbus-run-session openbox setsid xdpyinfo agent-desktop; do
    command -v "$command" >/dev/null 2>&1 || fail "Missing $command. Install desktop prerequisites for the service user before enabling --desktop."
  done
}
if [[ ${1:-} == --check ]]; then check; exit 0; fi
if [[ ${1:-} == --session ]]; then
  shift
  [[ $(id -u) != 0 ]] || fail 'Run under a dedicated non-root service account, never root.'
  [[ $# -ge 2 ]] || fail 'Server command missing.'
  [[ -n ${DISPLAY:-} && -n ${DBUS_SESSION_BUS_ADDRESS:-} ]] || fail 'Private display or session bus missing.'
  xdpyinfo >/dev/null 2>&1 || fail 'Private Xvfb display did not become ready.'
  export TUCANO_SERVER=1 TUCANO_SERVER_DESKTOP=1
  export NO_AT_BRIDGE=0 GTK_MODULES=atk-bridge
  openbox >/dev/null 2>&1 &
  wm=$!
  cleanup_session() { kill "$wm" 2>/dev/null || true; wait "$wm" 2>/dev/null || true; }
  trap cleanup_session EXIT
  "$@" &
  server=$!
  trap 'kill "$server" "$wm" 2>/dev/null || true' TERM INT HUP
  set +e
  wait "$server"
  result=$?
  exit "$result"
fi
check
[[ $# -ge 2 ]] || fail 'Usage: server-desktop.sh /absolute/node /absolute/server.js [arguments...]'
[[ $(id -u) != 0 ]] || fail 'Run under a dedicated non-root service account, never root.'
[[ ${HOME:-} == /* && -d $HOME && -w $HOME ]] || fail 'A writable absolute HOME for the service account is required.'
[[ $1 == /* && -x $1 && $2 == /* && -f $2 ]] || fail 'Provide absolute paths to the Node executable and server entry file.'
umask 077
export XDG_RUNTIME_DIR="$HOME/.tucano-desktop-runtime"
export XDG_CONFIG_HOME="$HOME/.tucano-desktop-config" GSETTINGS_BACKEND=keyfile XDG_CURRENT_DESKTOP=GNOME
unset AT_SPI_BUS_ADDRESS GTK_A11Y
mkdir -p "$XDG_CONFIG_HOME/glib-2.0/settings"
# Accessibility setting is private to this desktop, never the host desktop.
printf '[org/gnome/desktop/interface]\ntoolkit-accessibility=true\n' > "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile"
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/tucano-workspace"
chmod 700 "$XDG_RUNTIME_DIR"
script=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")
cd "$HOME/tucano-workspace"
# Never inherit an existing personal desktop or session bus. xvfb-run creates
# an Xauthority cookie and finds a free display; X11 TCP is explicitly disabled.
unset DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS
# A separate process group lets the supervisor reap the server, apps, WM, Xvfb
# and session bus together on exit. systemd additionally uses KillMode=control-group.
setsid xvfb-run --auto-servernum --server-args='-screen 0 1440x900x24 -nolisten tcp' dbus-run-session -- bash "$script" --session "$@" &
child=$!
cleanup() {
  trap - EXIT TERM INT HUP
  kill -TERM -- "-$child" 2>/dev/null || true
  # Allow children to clean up their private Xauthority files, then stop stragglers.
  for ((i=0; i<30; i++)); do
    kill -0 -- "-$child" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL -- "-$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT
set +e
wait "$child"
result=$?
exit "$result"
