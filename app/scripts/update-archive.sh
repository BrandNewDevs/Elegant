#!/bin/zsh
# Zips the signed out/<display name>.app (already built by scripts/package.sh) into out/<display name>-<version>-arm64.zip
# and writes out/latest-mac.yml next to it, the two files the in-app updater (electron-updater) reads from a release: the
# feed names the zip and carries its size and sha512, which the updater checks before it installs anything. Apple silicon
# only, like the app. `scripts/release.sh` runs this after the .dmg is built.
#
# usage: scripts/update-archive.sh
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=$(node --input-type=module -e 'import { DISPLAY_NAME } from "./dist/config.js"; console.log(DISPLAY_NAME)')
VERSION=$(node -p 'require("./package.json").version')
APP="out/$NAME.app"
[ -d "$APP" ] || { echo "$APP is not built; run scripts/package.sh first" >&2; exit 1; }

# GitHub turns a space in an asset name into a dot, which would break the feed's file name, so there is none.
ZIP="${NAME// /-}-$VERSION-arm64.zip"
rm -f "out/$ZIP"
ditto -c -k --keepParent "$APP" "out/$ZIP"

SIZE=$(stat -f %z "out/$ZIP")
SHA512=$(openssl dgst -sha512 -binary "out/$ZIP" | base64)
cat > out/latest-mac.yml <<EOF
version: $VERSION
files:
  - url: $ZIP
    sha512: $SHA512
    size: $SIZE
path: $ZIP
sha512: $SHA512
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
EOF
echo "built $(pwd)/out/$ZIP and out/latest-mac.yml"
