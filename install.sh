#!/bin/sh
# Installs or updates Tucano:
#   curl -fsSL https://github.com/eduwxyz/tucano/releases/latest/download/install.sh | sh
#
# On a Mac: the app (signed and notarized by Apple) goes into Applications; the
# "from the internet" mark is cleared all the same. Before its public release
# Tucano was called agent-desk: an old agent-desk.app is closed and replaced, and
# its data comes along the first time Tucano opens.
# On Linux: the .deb with apt (Ubuntu, Debian and their family), else the AppImage
# in ~/.local/bin with an entry in the applications menu.
#
# For testing a build before it is released (then the app doesn't open):
# TUCANO_ZIP (Mac), TUCANO_DEB or TUCANO_APPIMAGE (Linux; a URL or a local file)
# and TUCANO_DEST, another folder. TUCANO_APPIMAGE=1 picks the AppImage over the .deb.
set -e
REPO=eduwxyz/tucano
LATEST="https://github.com/$REPO/releases/latest/download"

# Messages in Portuguese on a system set to Portuguese, in English otherwise.
case "${LANG:-}" in pt*) PT=1 ;; *) PT= ;; esac
say() { if [ -n "$PT" ]; then echo "$1"; else echo "$2"; fi; }
fail() { say "$1" "$2" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fetch() { # fetch <url or file> <to>
  case "$1" in
    http*) curl -fL --progress-bar -o "$2" "$1" ;;
    *) cp "$1" "$2" ;;
  esac
}

install_mac() {
  [ "$(uname -m)" = arm64 ] || fail "Por enquanto o Tucano é só pra Macs com chip Apple (M1 em diante)." "For now Tucano needs a Mac with Apple silicon (M1 or later)."
  ZIP="${TUCANO_ZIP:-$LATEST/tucano-mac-arm64.zip}"
  DEST="${TUCANO_DEST:-/Applications}"
  [ -w "$DEST" ] || [ -n "$TUCANO_DEST" ] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  APP="$DEST/Tucano.app"
  OLD="$DEST/agent-desk.app"

  say "Baixando o Tucano…" "Downloading Tucano…"
  fetch "$ZIP" "$TMP/tucano.zip"
  ditto -x -k "$TMP/tucano.zip" "$TMP/app"
  [ -d "$TMP/app/Tucano.app" ] || fail "O arquivo baixado não tem o Tucano.app." "The download doesn't contain Tucano.app."

  # Copying over a running app leaves it unable to quit normally: close it first.
  running() { pgrep -f "$APP/Contents/MacOS/Tucano\$" >/dev/null || pgrep -f "$OLD/Contents/MacOS/agent-desk\$" >/dev/null; }
  if running; then
    say "Fechando o app aberto…" "Closing the running app…"
    for name in Tucano agent-desk; do
      osascript -e 'with timeout of 20 seconds' -e "tell application \"$name\" to quit" -e 'end timeout' >/dev/null 2>&1 || true
    done
    for _ in $(seq 1 30); do running || break; sleep 1; done
    running && fail "O app não fechou. Feche com ⌘Q e rode de novo." "The app didn't close. Quit it with ⌘Q and run this again."
  fi

  rm -rf "$APP"
  ditto "$TMP/app/Tucano.app" "$APP"
  xattr -r -d com.apple.quarantine "$APP" >/dev/null 2>&1 || true
  if [ -d "$OLD" ] && [ -z "$TUCANO_DEST" ]; then
    rm -rf "$OLD"
    osascript -e 'tell application "System Events" to delete login item "agent-desk"' >/dev/null 2>&1 || true
  fi
  say "Instalado em $APP" "Installed in $APP"
  [ -n "$TUCANO_DEST" ] || open "$APP"
}

install_linux() {
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) fail "O Tucano roda em Linux x64 ou ARM64, não em $(uname -m)." "Tucano runs on x64 or ARM64 Linux, not on $(uname -m)." ;;
  esac

  # Replacing a running app's files leaves it broken: close it first (it quits on SIGTERM).
  # Only the app itself: a command line that starts with its path.
  running() { pgrep -f '^/opt/Tucano/tucano( |$)' >/dev/null || pgrep -f '^[^ ]*/Tucano\.AppImage( |$)' >/dev/null; }
  if running && [ -z "$TUCANO_DEST" ]; then
    say "Fechando o app aberto…" "Closing the running app…"
    pkill -TERM -f '^/opt/Tucano/tucano( |$)' 2>/dev/null || true
    pkill -TERM -f '^[^ ]*/Tucano\.AppImage( |$)' 2>/dev/null || true
    for _ in $(seq 1 30); do running || break; sleep 1; done
    running && fail "O app não fechou. Encerre o Tucano (ícone na bandeja › Encerrar) e rode de novo." "The app didn't close. Quit Tucano (tray icon › Quit) and run this again."
  fi

  if [ -z "${TUCANO_APPIMAGE:-}" ] && command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
    say "Baixando o Tucano (.deb)…" "Downloading Tucano (.deb)…"
    fetch "${TUCANO_DEB:-$LATEST/tucano-linux-$ARCH.deb}" "$TMP/tucano.deb"
    chmod 644 "$TMP/tucano.deb"
    chmod 755 "$TMP"
    SUDO=
    if [ "$(id -u)" != 0 ]; then
      command -v sudo >/dev/null 2>&1 || fail "Precisa de sudo pra instalar o .deb. Rode como root, ou use TUCANO_APPIMAGE=1." "Installing the .deb needs sudo. Run as root, or use TUCANO_APPIMAGE=1."
      SUDO=sudo
      say "Instalando (o sistema pede a sua senha)…" "Installing (the system asks for your password)…"
    fi
    $SUDO apt-get install -y "$TMP/tucano.deb"
    APP=/opt/Tucano/tucano
  else
    DEST="${TUCANO_DEST:-$HOME/.local/bin}"
    mkdir -p "$DEST"
    APP="$DEST/Tucano.AppImage"
    case "${TUCANO_APPIMAGE:-}" in "" | 1) SRC="$LATEST/tucano-linux-$ARCH.AppImage" ;; *) SRC="$TUCANO_APPIMAGE" ;; esac
    say "Baixando o Tucano (AppImage)…" "Downloading Tucano (AppImage)…"
    fetch "$SRC" "$TMP/Tucano.AppImage"
    chmod +x "$TMP/Tucano.AppImage"
    mv -f "$TMP/Tucano.AppImage" "$APP"
    if [ -z "$TUCANO_DEST" ]; then
      # In the applications menu, with the toucan (the AppImage's own icon, by its path).
      ICON="$HOME/.local/share/icons/tucano.png"
      mkdir -p "$(dirname "$ICON")" "$HOME/.local/share/applications"
      PNG=usr/share/icons/hicolor/1024x1024/apps/tucano.png
      (cd "$TMP" && env -u APPIMAGE_EXTRACT_AND_RUN "$APP" --appimage-extract "$PNG" >/dev/null 2>&1 && cp "squashfs-root/$PNG" "$ICON") || ICON=tucano
      cat > "$HOME/.local/share/applications/tucano.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Tucano
Comment=A team of AI agents on your computer
Exec="$APP" %U
Icon=$ICON
Terminal=false
Categories=Utility;
StartupWMClass=Tucano
EOF
      command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
    fi
  fi
  say "Instalado: $APP" "Installed: $APP"
  if [ -z "$TUCANO_DEST" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    nohup "$APP" >/dev/null 2>&1 &
  fi
}

case "$(uname -s)" in
  Darwin) install_mac ;;
  Linux) install_linux ;;
  *) fail "O Tucano roda no macOS e no Linux. No Windows, ainda não." "Tucano runs on macOS and Linux. Not on Windows yet." ;;
esac
