#!/bin/sh
# Builds the .dmg and .zip for Apple Silicon and publishes them as a GitHub
# release, tagged with package.json's version. Signed with the keychain's
# Developer ID Application certificate and notarized by Apple, so the .dmg
# opens with no warning. Notarization uses the credentials saved once with
#   xcrun notarytool store-credentials tucano --apple-id <email> --team-id <team>
# (TUCANO_NOTARY_PROFILE names another profile). --no-publish builds and
# stops, for testing.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
OUT="$HOME/Library/Caches/tucano/release"

if [ "$1" != "--no-publish" ]; then
  [ -z "$(git status --porcelain)" ] || { echo "There are uncommitted changes." >&2; exit 1; }
  gh release view "$TAG" >/dev/null 2>&1 && { echo "Release $TAG already exists: bump the version in package.json." >&2; exit 1; }
fi

IDENTITY="${TUCANO_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk '/Developer ID Application/ { print $2; exit }')}"
[ -n "$IDENTITY" ] || { echo "No Developer ID Application certificate in the keychain." >&2; exit 1; }
export APPLE_KEYCHAIN_PROFILE="${TUCANO_NOTARY_PROFILE:-tucano}"

npm run build
npx electron-builder --mac dmg zip --arm64 --publish never \
  --config.directories.output="$OUT" \
  --config.mac.identity="$IDENTITY" \
  --config.mac.notarize=true \
  --config.artifactName='tucano-mac-${arch}.${ext}'

# The app inside is notarized and stapled; the .dmg gets its own ticket too,
# so a browser download opens without asking.
DMG="$OUT/tucano-mac-arm64.dmg"
codesign --sign "$IDENTITY" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$DMG"

# latest-mac.yml tells the installed apps about this version (src/main/updates.ts); the
# .dmg was signed and stapled after it was written, so its entry gets the final hash.
node -e '
const fs = require("fs"), crypto = require("crypto")
const [yml, dmg] = process.argv.slice(1)
const data = fs.readFileSync(dmg)
const sha512 = crypto.createHash("sha512").update(data).digest("base64")
const text = fs.readFileSync(yml, "utf8").replace(/(- url: tucano-mac-arm64\.dmg\n\s+sha512: )\S+(\n\s+size: )\d+/, (_, a, b) => a + sha512 + b + data.length)
fs.writeFileSync(yml, text)
' "$OUT/latest-mac.yml" "$DMG"

codesign --verify --deep --strict "$OUT/mac-arm64/Tucano.app"
spctl --assess --type execute "$OUT/mac-arm64/Tucano.app"
spctl --assess --type open --context context:primary-signature "$DMG"
echo "Signed and notarized. Files in $OUT:"
ls -lh "$OUT"/tucano-mac-arm64.*

[ "$1" = "--no-publish" ] && exit 0
git push origin HEAD
gh release create "$TAG" "$OUT/tucano-mac-arm64.dmg" "$OUT/tucano-mac-arm64.zip" "$OUT/tucano-mac-arm64.zip.blockmap" "$OUT/latest-mac.yml" install.sh \
  --target "$(git rev-parse HEAD)" --title "Tucano $VERSION" --notes-file docs/release-notes.md
