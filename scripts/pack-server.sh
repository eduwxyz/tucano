#!/bin/sh
# Packs the built server for install-server.sh: the built core and screens (out/main, out/renderer), the
# production dependencies and a VERSION file, in one .tar.gz that has no native code in it, so the same file
# serves x64 and ARM64. Run `npm run build` first.
#
#   sh scripts/pack-server.sh [folder]     (default: dist-server)
#
# Leaves tucano-server.tar.gz and tucano-server.tar.gz.sha256 in the folder. The release attaches both
# (.github/workflows/server.yml).
set -eu
cd "$(dirname "$0")/.."

if ! { [ -f out/main/server.js ] && [ -f out/main/core.js ] && [ -f out/renderer/index.html ]; }; then
  echo "Nothing built yet: run npm run build first." >&2
  exit 1
fi

OUT="${1:-dist-server}"
VERSION=$(node -p "require('./package.json').version")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/tucano-server"

mkdir -p "$PKG/out" "$OUT"
cp -R out/main out/renderer "$PKG/out/"
cp package.json package-lock.json "$PKG/"
# Only what the server runs on: the Electron app and the build tools stay out.
(cd "$PKG" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
echo "$VERSION" > "$PKG/VERSION"

# On a Mac, tar adds ._ files and extended attributes (COPYFILE_DISABLE, --no-xattrs), which GNU tar on the
# server would warn about on every unpack.
echo probe > "$STAGE/probe"
if tar --no-xattrs -cf /dev/null -C "$STAGE" probe 2>/dev/null; then
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUT/tucano-server.tar.gz" -C "$STAGE" tucano-server
else
  COPYFILE_DISABLE=1 tar -czf "$OUT/tucano-server.tar.gz" -C "$STAGE" tucano-server
fi

cd "$OUT"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum tucano-server.tar.gz > tucano-server.tar.gz.sha256
else
  shasum -a 256 tucano-server.tar.gz > tucano-server.tar.gz.sha256
fi
echo "Packed Tucano server $VERSION: $(pwd)/tucano-server.tar.gz ($(du -h tucano-server.tar.gz | cut -f1))"
cat tucano-server.tar.gz.sha256
