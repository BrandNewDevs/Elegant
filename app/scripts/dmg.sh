#!/bin/zsh
# Builds the signed app and wraps it in out/<display name>-<version>.dmg, with a link to /Applications so installing
# is one drag. `pnpm run release` and the Release workflow both use it.
#
# usage: scripts/dmg.sh <signing identity>
# The identity is required: an ad-hoc app would lose its permissions on every update.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${1:-${SIGN_IDENTITY:-}}"
[ -n "$IDENTITY" ] && [ "$IDENTITY" != "-" ] || { echo "usage: scripts/dmg.sh <signing identity>" >&2; exit 1; }

scripts/package.sh "$IDENTITY"

NAME=$(node --input-type=module -e 'import { DISPLAY_NAME } from "./dist/config.js"; console.log(DISPLAY_NAME)')
VERSION=$(node -p 'require("./package.json").version')
DMG="out/$NAME-$VERSION.dmg"

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
ditto "out/$NAME.app" "$STAGING/$NAME.app"
ln -s /Applications "$STAGING/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname "$NAME" -srcfolder "$STAGING" -fs HFS+ -format UDZO "$DMG"
codesign --force --sign "$IDENTITY" --timestamp=none "$DMG"
echo "built $(pwd)/$DMG"
