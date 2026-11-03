#!/bin/sh
# Installs or updates the Tucano server on a Linux VPS (or any Linux box), under your own user, with no root:
#
#   curl -fsSL https://github.com/eduwxyz/tucano/releases/latest/download/install-server.sh | sh
#
# It puts the server in ~/.local/share/tucano-server (with a Node 24 of its own if the system has none), keeps it
# running as a systemd user service, adds the `tucano-server` command (pair, devices, revoke) to ~/.local/bin, and
# prints a one-time code to pair your computer with it. Run it again to update: the data in ~/.tucano-server stays.
#
#   sh -s -- --label "My Mac"        a name for the device the first code is for
#   sh -s -- --host vps.example.com  the address your computer reaches this machine at (SSH), for the app's link
#   sh -s -- --uninstall [--purge]   remove the service and the program; --purge also deletes the data
#
# Options: --label NAME, --host ADDRESS / --url ADDRESS, --port N, --pair / --no-pair (a code is made on a first install, not on an update),
# --no-service (install only, start nothing), --uninstall, --purge.
#
# For testing a build before it is released: TUCANO_TARBALL (a URL or a local file, with its .sha256 beside it),
# TUCANO_SHA256, TUCANO_NODE (a Node 24+ to use), TUCANO_HOME (where the program goes), TUCANO_DATA, TUCANO_PORT
# and TUCANO_BIN (where the tucano-server command goes).
set -eu
umask 077

# sudo -u/-H can retain the caller's XDG paths and session bus. Never write another
# user's unit or talk to their service manager after switching users.
if [ -n "${SUDO_UID:-}" ] && [ "$SUDO_UID" != "$(id -u)" ]; then
  unset XDG_CONFIG_HOME XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
fi

REPO=eduwxyz/tucano
LATEST="https://github.com/$REPO/releases/latest/download"
TARBALL="${TUCANO_TARBALL:-$LATEST/tucano-server.tar.gz}"
APP="${TUCANO_HOME:-$HOME/.local/share/tucano-server}"
DATA="${TUCANO_DATA:-$HOME/.tucano-server}"
PORT="${TUCANO_PORT:-7337}"
PORT_GIVEN="${TUCANO_PORT:-}"
BIN="${TUCANO_BIN:-$HOME/.local/bin}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/tucano.service"
LABEL="My computer"
HOST_GIVEN=
URL_GIVEN=
SERVICE=1
DESKTOP=auto
PAIR=auto
UNINSTALL=
PURGE=

# Messages in Portuguese on a system set to Portuguese, in English otherwise.
case "${LANG:-}" in pt*) PT=1 ;; *) PT= ;; esac
say() { if [ -n "$PT" ]; then echo "$1"; else echo "$2"; fi; }
fail() { say "$1" "$2" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sh install-server.sh [options]

  --label NAME     a name for the device the first pairing code is for (default: My computer)
  --host ADDRESS   the address your computer reaches this machine at over SSH (host, or host:port); default: the
                   address you are logged in at now, when this runs over SSH
  --url ADDRESS    HTTPS or Tailscale URL for direct pairing (instead of --host); does not configure a proxy
  --port N         the port the server listens on, on this machine only (default: 7337)
  --pair           make a pairing code even on an update
  --no-pair        don't make one on a first install
  --desktop        enable the optional Linux virtual desktop (requires preinstalled desktop tools)
  --no-desktop     disable the virtual desktop; default on first install is headless
  --no-service     install only: no systemd service, nothing started
  --uninstall      remove the service, the program and the tucano-server command; the data stays
  --purge          with --uninstall: delete the data too (conversations, memory, keys)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --label | --port | --host | --url)
      [ $# -ge 2 ] || fail "Falta o valor de $1." "$1 needs a value."
      case "$1" in --label) LABEL=$2 ;; --host) HOST_GIVEN=$2 ;; --url) URL_GIVEN=$2 ;; *) PORT=$2 PORT_GIVEN=$2 ;; esac
      shift
      ;;
    --label=*) LABEL=${1#--label=} ;;
    --host=*) HOST_GIVEN=${1#--host=} ;;
    --url=*) URL_GIVEN=${1#--url=} ;;
    --port=*) PORT=${1#--port=} PORT_GIVEN=${1#--port=} ;;
    --pair) PAIR=1 ;;
    --no-pair) PAIR= ;;
    --no-service) SERVICE= ;;
    --desktop) DESKTOP=1 ;;
    --no-desktop) DESKTOP=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "Opção desconhecida: $1 (veja --help)" "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

[ -z "$URL_GIVEN" ] || [ -z "$HOST_GIVEN" ] || fail "Use --host ou --url, não ambos." "Use --host or --url, not both."
[ -z "$PURGE" ] || [ -n "$UNINSTALL" ] || fail "--purge exige --uninstall." "--purge requires --uninstall."

# Preserve explicit desktop opt-in across updates; an older/headless install defaults off.
if [ "$DESKTOP" = auto ]; then
  DESKTOP=0
  if [ -f "$BIN/tucano-server" ] && grep -q '^# TUCANO_SERVER_DESKTOP=1$' "$BIN/tucano-server"; then DESKTOP=1; fi
fi

# An update keeps the port chosen the first time, unless told another (--port, TUCANO_PORT).
if [ -z "$PORT_GIVEN" ] && [ -f "$BIN/tucano-server" ]; then
  KEPT=$(sed -n "s/.*TUCANO_PORT='\\([0-9][0-9]*\\)'.*/\\1/p" "$BIN/tucano-server" | head -1)
  if [ -n "$KEPT" ]; then PORT=$KEPT; fi
fi
case "$PORT" in '' | *[!0-9]*) fail "A porta tem que ser um número." "The port has to be a number." ;; esac
{ [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ]; } || fail "Use uma porta entre 1024 e 65535." "Use a port between 1024 and 65535."

[ "$(id -u)" != 0 ] || fail \
  "Rode como o usuário que vai ser dono do Tucano, não como root: os agentes executam comandos como esse usuário. Para criar um: adduser tucano && loginctl enable-linger tucano, e entre por SSH como ele." \
  "Run this as the user that will own Tucano, not as root: the agents run commands as that user. To make one: adduser tucano && loginctl enable-linger tucano, then log in over SSH as it."

# These paths end up in a unit file and in a shell script: nothing that either would read as syntax.
case "$APP$DATA$BIN$HOME$UNIT_DIR${TUCANO_NODE:-}" in
  *[[:cntrl:]]*) fail "Caminho com caractere de controle." "Paths must not contain control characters." ;;
  *[\"\'\`\$%\\]*) fail "Os caminhos não podem ter aspas, \$, %, crase nem barra invertida." "The paths can't contain quotes, \$, %, backticks or backslashes." ;;
esac
for dir in "$APP" "$DATA" "$BIN" "$UNIT_DIR"; do
  case "$dir" in /*) ;; *) fail "Use caminhos absolutos." "Use absolute paths." ;; esac
  case "$dir/" in */../* | */./* | *//*) fail "Caminho não normalizado: $dir" "Path must be normalized: $dir" ;; esac
  case "$dir" in "" | / | "$HOME" | "$HOME/") fail "Pasta inválida: '$dir'." "Not a usable folder: '$dir'." ;; esac
done

# Program/data must be separate. This also keeps uninstall away from parent folders.
case "$DATA/" in "$APP/"*) fail "Dados dentro do programa." "Data must not be inside the program directory." ;; esac
case "$APP/" in "$DATA/"* | "$BIN/"*) fail "Pastas sobrepostas." "Program, data and command directories must not overlap." ;; esac
case "$BIN/" in "$APP/"* | "$DATA/"*) fail "Pastas sobrepostas." "Program, data and command directories must not overlap." ;; esac

# Do not install into or remove an unrelated tree, even when a path override has a typo.
# The current server check also recognizes installations made by older installers.
if [ -L "$APP" ]; then fail "Programa não pode ser um link." "The program directory must not be a symlink."; fi
if [ -d "$APP" ] && [ ! -f "$APP/.tucano-install" ] && [ ! -f "$APP/current/out/main/server.js" ]; then
  for existing in "$APP"/* "$APP"/.[!.]* "$APP"/..?*; do
    if [ -e "$existing" ] || [ -L "$existing" ]; then
      fail "Pasta não reconhecida: $APP" "Refusing to use an unrecognized nonempty program directory: $APP"
    fi
  done
fi
if [ -e "$APP/current" ] && [ ! -L "$APP/current" ]; then
  fail "current deve ser um link." "The current release must be a symlink."
fi

OS=$(uname -s)
case "$OS" in
  Linux | Darwin) ;;
  *) fail "O servidor do Tucano roda em Linux (e, sem serviço, no macOS)." "The Tucano server runs on Linux (and, without a service, on macOS)." ;;
esac

# systemd user services: a session bus for this user, which a plain `su` or `sudo -u` doesn't give.
systemd_user() {
  [ "$OS" = Linux ] && command -v systemctl >/dev/null 2>&1 || return 1
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export XDG_RUNTIME_DIR
  fi
  systemctl --user show-environment >/dev/null 2>&1
}

# Only a folder that holds Tucano's data is deleted as such.
looks_like_data() { [ -f "$1/server-id" ] || [ -f "$1/tucano.db" ] || [ -f "$1/server.key" ] || [ -f "$1/pairing.json" ]; }

# Serialize installs, updates and uninstalls for this program directory. Keep the lock
# beside APP so uninstall cannot remove it while another installer is starting.
LOCK="$APP.install-lock"
mkdir -p "$(dirname "$APP")"
mkdir "$LOCK" 2>/dev/null || fail "Outra instalação está em andamento: $LOCK" "Another installer may be running. If it crashed, verify no installer is active before removing $LOCK."
printf '%s\n' "$$" > "$LOCK/pid"
release_lock() { rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null || true; }
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "$UNINSTALL" ]; then
  if [ -f "$UNIT" ]; then
    systemd_user || fail "Não consigo parar o serviço. Entre por SSH como o dono antes de remover." "Cannot stop the service. Log in over SSH as its owner before uninstalling."
    systemctl --user disable --now tucano.service || fail "Não consegui parar o serviço; nada foi removido." "Could not stop the service; nothing was removed."
  fi
  rm -f "$UNIT" "$BIN/tucano-server"
  if systemd_user; then systemctl --user daemon-reload || true; fi
  rm -rf "$APP"
  say "Tucano removido (serviço, programa e o comando tucano-server)." "Tucano removed (the service, the program and the tucano-server command)."
  if [ -n "$PURGE" ]; then
    if looks_like_data "$DATA"; then
      rm -rf "$DATA"
      say "Dados apagados: $DATA" "Data deleted: $DATA"
    else
      say "Não apaguei $DATA: não parece uma pasta de dados do Tucano." "Not deleting $DATA: it doesn't look like Tucano's data."
    fi
  else
    say "Os dados continuam em $DATA (apague com --uninstall --purge)." "The data is still in $DATA (delete it with --uninstall --purge)."
  fi
  exit 0
fi

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || fail "Falta o $tool: instale-o primeiro (apt install $tool)." "$tool is missing: install it first (apt install $tool)."
done
if ! { command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; }; then
  fail "Falta sha256sum (ou shasum) para conferir os downloads." "sha256sum (or shasum) is needed to check the downloads."
fi
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Fail before changing a working install if no service manager is available.
if [ -n "$SERVICE" ]; then
  systemd_user || fail \
    "Não há sessão systemd de usuário. Entre por SSH ou use --no-service." \
    "There is no systemd user session. Log in over SSH, or use --no-service."
fi

TMP=$(mktemp -d)
ACTIVATED=
COMMITTED=
BEFORE_TARGET=
cleanup() {
  result=$?
  trap - EXIT
  set +e
  if [ "$result" != 0 ] && [ -n "$ACTIVATED" ] && [ -z "$COMMITTED" ] && [ -n "$BEFORE_TARGET" ]; then
    ROLLBACK_OK=1
    ln -sfn "$BEFORE_TARGET" "$APP/current" || ROLLBACK_OK=
    if [ -f "$TMP/command.before" ]; then cp "$TMP/command.before" "$BIN/tucano-server" || ROLLBACK_OK=; fi
    if [ -f "$TMP/unit.before" ]; then cp "$TMP/unit.before" "$UNIT" || ROLLBACK_OK=; fi
    if [ -n "$SERVICE" ]; then
      systemctl --user daemon-reload || ROLLBACK_OK=
      systemctl --user restart tucano.service || ROLLBACK_OK=
    fi
    if [ -n "$ROLLBACK_OK" ]; then
      say "A atualização falhou; restaurei a versão anterior. Confira o serviço." "Update failed; restored the previous version. Check the service." >&2
    else
      say "A atualização e a restauração falharam. Confira o serviço e a versão anterior." "Update and rollback failed. Check the service and the retained previous release." >&2
    fi
  fi
  rm -rf "$TMP"
  release_lock
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { # fetch <https url or file> <to>
  case "$1" in
    https://*)
      if [ -t 2 ]; then PROGRESS=--progress-bar; else PROGRESS=-sS; fi
      curl -fL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 "$PROGRESS" -o "$2" "$1"
      ;;
    http://*) fail "Só https: $1" "https only: $1" ;;
    *) cp "$1" "$2" ;;
  esac
}

# --- Node 24 or newer (the database is Node's own SQLite). The system's, if it is in /usr; else one of ours.
node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; }
NODE=
if [ -n "${TUCANO_NODE:-}" ]; then
  case "$TUCANO_NODE" in /*) ;; *) fail "TUCANO_NODE precisa ser absoluto." "TUCANO_NODE must be absolute." ;; esac
fi
for candidate in "${TUCANO_NODE:-}" /usr/bin/node /usr/local/bin/node "$APP/node/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && node_ok "$candidate"; then
    NODE=$candidate
    break
  fi
done
if [ -z "$NODE" ]; then
  case "$OS" in Linux) NODE_OS=linux ;; *) NODE_OS=darwin ;; esac
  case "$(uname -m)" in
    x86_64 | amd64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    *) fail "O Tucano roda em x64 ou ARM64, não em $(uname -m)." "Tucano runs on x64 or ARM64, not on $(uname -m)." ;;
  esac
  if [ "$OS" = Linux ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    fail "Esta distribuição usa musl (Alpine): instale você mesmo o Node 24 e rode de novo com TUCANO_NODE=/caminho/do/node." "This distribution uses musl (Alpine): install Node 24 yourself and run this again with TUCANO_NODE=/path/to/node."
  fi
  NODE_BASE=https://nodejs.org/dist/latest-v24.x
  fetch "$NODE_BASE/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  NODE_FILE=$(awk -v p="-$NODE_OS-$NODE_ARCH.tar.gz" '$2 ~ /^node-v24\./ && index($2, p) { print $2; exit }' "$TMP/SHASUMS256.txt")
  NODE_SUM=$(awk -v f="$NODE_FILE" '$2 == f { print $1; exit }' "$TMP/SHASUMS256.txt")
  { [ -n "$NODE_FILE" ] && [ -n "$NODE_SUM" ]; } || fail "Não achei o Node 24 para $NODE_OS-$NODE_ARCH em nodejs.org." "Couldn't find Node 24 for $NODE_OS-$NODE_ARCH on nodejs.org."
  say "Baixando o Node.js (${NODE_FILE%.tar.gz}): o servidor precisa do Node 24 ou mais novo…" "Downloading Node.js (${NODE_FILE%.tar.gz}): the server needs Node 24 or newer…"
  fetch "$NODE_BASE/$NODE_FILE" "$TMP/node.tar.gz"
  [ "$(sha "$TMP/node.tar.gz")" = "$NODE_SUM" ] || fail "O Node baixado não bate com a soma de verificação de nodejs.org." "The downloaded Node doesn't match the checksum on nodejs.org."
  mkdir -p "$APP/node.new"
  touch "$APP/.tucano-install"
  tar -xzf "$TMP/node.tar.gz" -C "$APP/node.new" --strip-components=1
  rm -rf "$APP/node"
  mv "$APP/node.new" "$APP/node"
  NODE="$APP/node/bin/node"
  node_ok "$NODE" || fail "O Node baixado não roda neste sistema." "The downloaded Node doesn't run on this system."
fi

# --- The server itself: checked against its checksum, unpacked beside the others, then made the current one.
say "Baixando o servidor do Tucano…" "Downloading the Tucano server…"
fetch "$TARBALL" "$TMP/server.tar.gz"
if [ -n "${TUCANO_SHA256:-}" ]; then
  WANT=$TUCANO_SHA256
else
  fetch "$TARBALL.sha256" "$TMP/server.sha256" || fail "Não consegui baixar $TARBALL.sha256." "Couldn't get $TARBALL.sha256."
  WANT=$(cut -d' ' -f1 <"$TMP/server.sha256")
fi
[ "$(sha "$TMP/server.tar.gz")" = "$WANT" ] || fail "O download não bate com a soma de verificação: não instalei nada." "The download doesn't match its checksum: nothing was installed."

# Packages contain only ordinary files/directories. Reject traversal and links before extraction.
tar -tzf "$TMP/server.tar.gz" > "$TMP/entries"
awk '
  $0 !~ /^tucano-server(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ { bad=1 }
  END { exit bad }
' "$TMP/entries" || fail "Caminho inseguro no pacote." "Unsafe path in package."
tar -tvzf "$TMP/server.tar.gz" > "$TMP/types"
if grep -q '^[^-d]' "$TMP/types"; then
  fail "O pacote contém links ou arquivos especiais." "Package contains links or special files."
fi
mkdir -p "$TMP/unpacked"
tar -xzf "$TMP/server.tar.gz" -C "$TMP/unpacked"
SRC="$TMP/unpacked/tucano-server"
{ [ -f "$SRC/out/main/server.js" ] && [ -f "$SRC/VERSION" ]; } || fail "O pacote não tem o servidor do Tucano." "The package doesn't hold the Tucano server."
VERSION=$(cat "$SRC/VERSION")
case "$VERSION" in '' | . | .. | *[!0-9A-Za-z._-]*) fail "Versão inválida no pacote." "Invalid version in the package." ;; esac

# Validate desktop tools with exactly the PATH the user service will have. This is
# read-only and happens before switching releases or touching a working service.
# Env-based CLI shebangs (including agent-desktop) must use the same supported Node.
SERVICE_PATH="$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
if [ "$DESKTOP" = 1 ]; then
  [ "$OS" = Linux ] || fail "Desktop de servidor exige Linux." "Server desktop mode requires Linux."
  [ -x "$SRC/scripts/server-desktop.sh" ] || fail "Pacote sem launcher de desktop." "This package has no executable desktop launcher."
  if ! PATH="$SERVICE_PATH" "$SRC/scripts/server-desktop.sh" --check; then
    fail \
      "Desktop indisponível; não alterei o serviço. Veja docs/vps-desktop.md para instalar os pré-requisitos ou use --no-desktop." \
      "Desktop prerequisites are missing; the service was not changed. See docs/vps-desktop.md for setup, or use --no-desktop."
  fi
fi

BEFORE=
if [ -L "$APP/current" ]; then
  BEFORE_TARGET=$(readlink "$APP/current")
  BEFORE=$(cat "$APP/current/VERSION" 2>/dev/null || basename "$BEFORE_TARGET")
fi
if [ -f "$BIN/tucano-server" ]; then cp -p "$BIN/tucano-server" "$TMP/command.before"; fi
if [ -f "$UNIT" ]; then cp -p "$UNIT" "$TMP/unit.before"; fi
mkdir -p "$APP/versions"
touch "$APP/.tucano-install"
# Reinstalling the same release must not delete code still used by the running process.
SLOT=$VERSION
if [ -e "$APP/versions/$SLOT" ]; then SLOT="$VERSION-$(date +%s)-$$"; fi
mv "$SRC" "$APP/versions/$SLOT"
touch "$APP/versions/$SLOT"
ln -s "versions/$SLOT" "$APP/current.new.$$"
# mv -T is GNU-only. Node's rename is atomic on both Linux and macOS.
"$NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$APP/current.new.$$" "$APP/current"
ACTIVATED=1

# --- The command for this machine: tucano-server pair | devices | revoke, or with no word, the server itself.
mkdir -p "$BIN"
cat >"$BIN/tucano-server" <<EOF
#!/bin/sh
# Made by install-server.sh: Tucano's server commands on this machine (pair, devices, revoke; none: run the server).
# TUCANO_SERVER_DESKTOP=$DESKTOP
if [ '$DESKTOP' = 1 ] && [ "\$#" = 0 ]; then
  PATH='$SERVICE_PATH' TUCANO_DATA='$DATA' TUCANO_PORT='$PORT' TUCANO_SERVER_DESKTOP=1 exec '$APP/current/scripts/server-desktop.sh' '$NODE' '$APP/current/out/main/server.js'
fi
TUCANO_DATA='$DATA' TUCANO_PORT='$PORT' exec '$NODE' '$APP/current/out/main/server.js' "\$@"
EOF
chmod +x "$BIN/tucano-server"
SERVER="$BIN/tucano-server"

# --- The service.
RUNNING=
if [ -n "$SERVICE" ]; then
  systemd_user || fail \
    "Instalei, mas não há uma sessão systemd de usuário para manter o servidor rodando. Em Debian/Ubuntu: sudo apt install dbus-user-session, entre de novo por SSH e rode isto outra vez. Para rodar sem serviço: tucano-server (ou use --no-service)." \
    "Installed, but there is no systemd user session to keep the server running. On Debian/Ubuntu: sudo apt install dbus-user-session, log in again over SSH and run this again. To run without a service: tucano-server (or use --no-service)."
  mkdir -p "$UNIT_DIR"
  EXEC_START="\"$NODE\" \"$APP/current/out/main/server.js\""
  if [ "$DESKTOP" = 1 ]; then
    EXEC_START="\"$APP/current/scripts/server-desktop.sh\" \"$NODE\" \"$APP/current/out/main/server.js\""
  fi
  cat >"$UNIT" <<EOF
[Unit]
Description=Tucano server

[Service]
ExecStart=$EXEC_START
WorkingDirectory=$APP/current
Environment="TUCANO_DATA=$DATA"
Environment="TUCANO_PORT=$PORT"
Environment="PATH=$SERVICE_PATH"
Environment="TUCANO_SERVER_DESKTOP=$DESKTOP"
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=15
UMask=0077
# First-device pairing codes should not persist in the journal. Errors still go there.
StandardOutput=null

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable tucano.service >/dev/null 2>&1
  systemctl --user restart tucano.service
  RUNNING=1

  # Without lingering the user's services stop at logout and don't start at boot: not what a server is for.
  if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
    loginctl enable-linger "$(id -un)" 2>/dev/null || LINGER_HINT=1
  fi

  # Honor a persistent TUCANO_HOST service override (e.g. a private Tailscale bind).
  HEALTH_HOST=$(systemctl --user show tucano.service --property=Environment --value | tr ' ' '\n' | sed -n 's/^TUCANO_HOST=//p' | tail -1)
  case "$HEALTH_HOST" in '' | 0.0.0.0 | ::) HEALTH_HOST=127.0.0.1 ;; *:*) HEALTH_HOST="[$HEALTH_HOST]" ;; esac
  UP=
  for _ in $(seq 1 60); do
    CODE=$(curl --connect-timeout 2 --max-time 3 -s -o /dev/null -w '%{http_code}' "http://$HEALTH_HOST:$PORT/" 2>/dev/null || true)
    if [ "$CODE" = 401 ] && systemctl --user is-active --quiet tucano.service; then
      UP=1
      break
    fi
    sleep 1
  done
  if [ -z "$UP" ]; then
    echo "journalctl --user -u tucano -n 30 --no-pager:" >&2
    journalctl --user -u tucano -n 30 --no-pager >&2 || true
    fail "O servidor não ficou pronto após 60 verificações (o log está acima)." "The server didn't answer after 60 checks (its log is above)."
  fi
fi

COMMITTED=1
# Keep this release and its immediate predecessor. Prune only after a successful restart.
for old in "$APP"/versions/*; do
  [ -d "$old" ] || continue
  case "$old" in "$APP/versions/$SLOT" | "$APP/$BEFORE_TARGET") continue ;; esac
  rm -rf "$old"
done

if [ -n "$BEFORE" ] && [ "$BEFORE" != "$VERSION" ]; then
  say "Tucano atualizado: $BEFORE → $VERSION." "Tucano updated: $BEFORE → $VERSION."
elif [ -n "$BEFORE" ]; then
  say "Tucano $VERSION reinstalado." "Tucano $VERSION reinstalled."
else
  say "Tucano $VERSION instalado." "Tucano $VERSION installed."
  if [ "$PAIR" = auto ]; then PAIR=1; fi
fi
# An update doesn't make a code unless asked to: the devices already paired keep working.
if [ "$PAIR" = auto ]; then PAIR=; fi

if [ -n "$RUNNING" ]; then
  say "O servidor está rodando ($HEALTH_HOST:$PORT)." "The server is running ($HEALTH_HOST:$PORT)."
elif [ -z "$SERVICE" ]; then
  say "Nada foi iniciado (--no-service). Para rodar: $SERVER" "Nothing was started (--no-service). To run it: $SERVER"
fi
if [ "$DESKTOP" = 1 ]; then
  say "Desktop virtual habilitado apenas neste servidor; veja docs/vps-desktop.md." "Virtual desktop enabled for this server only; see docs/vps-desktop.md."
fi
case ":$PATH:" in *":$BIN:"*) ;; *) say "Obs.: $BIN não está no seu PATH; use o caminho inteiro: $SERVER" "Note: $BIN isn't in your PATH; use the whole path: $SERVER" ;; esac
if [ -n "${LINGER_HINT:-}" ]; then
  say "Atenção: para o servidor continuar rodando depois que você sair do SSH e voltar após um reboot, rode: sudo loginctl enable-linger $(id -un)" "Note: for the server to keep running after you log out, and to come back after a reboot, run: sudo loginctl enable-linger $(id -un)"
fi

if [ -n "$PAIR" ]; then
  # How the computer reaches this machine over SSH: what was given, else the address of this very login.
  REACH=$HOST_GIVEN
  if [ -z "$REACH" ] && [ -z "$URL_GIVEN" ] && [ -n "${SSH_CONNECTION:-}" ]; then
    # "client-ip client-port server-ip server-port": the last two are where this login came in.
    SSH_IP=$(printf '%s' "$SSH_CONNECTION" | awk '{ print $3 }')
    SSH_PORT=$(printf '%s' "$SSH_CONNECTION" | awk '{ print $4 }')
    if [ -n "$SSH_IP" ] && [ -n "$SSH_PORT" ]; then
      case "$SSH_IP" in *:*) REACH="[$SSH_IP]:$SSH_PORT" ;; *) REACH="$SSH_IP:$SSH_PORT" ;; esac
    fi
  fi
  case "$REACH" in
    '' | *@*) ;;
    *) REACH="$(id -un)@$REACH" ;;
  esac
  if [ -n "$URL_GIVEN" ]; then
    OUT=$("$SERVER" pair --label "$LABEL" --url "$URL_GIVEN") || { printf '%s\n' "$OUT" >&2; exit 1; }
  elif [ -n "$REACH" ]; then
    OUT=$("$SERVER" pair --label "$LABEL" --ssh "$REACH") || { printf '%s\n' "$OUT" >&2; exit 1; }
  else
    OUT=$("$SERVER" pair --label "$LABEL")
  fi
  CODE=$(printf '%s\n' "$OUT" | sed -n 's/^Pairing code: //p')
  APPLINK=$(printf '%s\n' "$OUT" | sed -n 's/^For the Mac app: //p')
  echo
  say "Código de pareamento (vale uma vez, para um dispositivo, por 5 minutos):" "Pairing code (works once, for one device, for 5 minutes):"
  echo
  echo "  $CODE"
  echo
  if [ -n "$APPLINK" ]; then
    say "No app do Tucano no Mac: Configurações → Servidores → Adicionar, e cole este link:" "In the Tucano app on your Mac: Settings → Servers → Add, and paste this link:"
    echo
    echo "  $APPLINK"
    echo
    if [ -z "$URL_GIVEN" ]; then
    say "(o app abre o túnel SSH sozinho; o ssh do seu Mac tem que entrar nesta máquina como $(id -un).)" "(the app opens the SSH tunnel itself; your Mac's ssh has to be able to log in to this machine as $(id -un).)"
    fi
    echo
  fi
  if [ -n "$URL_GIVEN" ]; then
    say "No navegador:" "In a browser:"
    echo "  ${URL_GIVEN%/}/?pair=$CODE"
    say "Configure HTTPS/proxy ou Tailscale separadamente; o serviço continua em 127.0.0.1." "Configure HTTPS/proxy or Tailscale separately; the service still listens on 127.0.0.1."
  else
  say "Ou, sem o app, em um navegador: abra um túnel SSH até este servidor e abra o link:" "Or, without the app, in a browser: open an SSH tunnel to this server, then open the link:"
  echo
  if [ -n "$REACH" ]; then
    # user@host[:port] or user@[v6]:port, as ssh wants it: -p for the port, no brackets around an IPv6 address.
    TO=${REACH#*@}
    case "$TO" in
      \[*) TO_HOST=${TO#\[}; TO_HOST=${TO_HOST%%\]*}; TO_PORT=${TO##*\]:}; [ "$TO_PORT" != "$TO" ] || TO_PORT= ;;
      *:*) TO_HOST=${TO%%:*}; TO_PORT=${TO#*:} ;;
      *) TO_HOST=$TO; TO_PORT= ;;
    esac
    echo "  ssh -N -L 17337:127.0.0.1:$PORT${TO_PORT:+ -p $TO_PORT} ${REACH%%@*}@$TO_HOST"
  else
    echo "  ssh -N -L 17337:127.0.0.1:$PORT $(id -un)@$(say "ENDERECO-OU-IP-DO-SERVIDOR" "YOUR-SERVER-ADDRESS")"
  fi
  echo "  http://127.0.0.1:17337/?pair=$CODE"
  fi
  echo
  say "Outro código: tucano-server pair --label \"Nome\" --ssh $(id -un)@endereco. Quem está pareado: tucano-server devices. Tirar o acesso: tucano-server revoke <id>." "Another code: tucano-server pair --label \"Name\" --ssh $(id -un)@address. Who is paired: tucano-server devices. Take access away: tucano-server revoke <id>."
fi
