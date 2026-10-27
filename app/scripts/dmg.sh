#!/bin/zsh
# Builds the signed app and wraps it in out/<display name>-<version>.dmg: an installer window with the app on the left,
# an arrow and the /Applications link on the right, so installing is one drag. The window comes from dmgbuild
# (scripts/dmg-settings.py, assets/dmg-background*.png): it writes the layout itself rather than scripting Finder, so it
# runs on a headless CI runner. `pnpm run release` and the Release workflow both use it.
#
# usage: scripts/dmg.sh <signing identity>
# The identity is required: an ad-hoc app would lose its permissions on every update.
# dmgbuild must be on PATH: `python3 -m venv ~/.dmgbuild && ~/.dmgbuild/bin/pip install dmgbuild`, then add its bin
# to PATH (the Release workflow does the same).
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${1:-${SIGN_IDENTITY:-}}"
[ -n "$IDENTITY" ] && [ "$IDENTITY" != "-" ] || { echo "usage: scripts/dmg.sh <signing identity>" >&2; exit 1; }
command -v dmgbuild >/dev/null || { echo "dmgbuild is not installed; see the comment at the top of scripts/dmg.sh" >&2; exit 1; }

scripts/package.sh "$IDENTITY"

NAME=$(node --input-type=module -e 'import { DISPLAY_NAME } from "./dist/config.js"; console.log(DISPLAY_NAME)')
VERSION=$(node -p 'require("./package.json").version')
DMG="out/$NAME-$VERSION.dmg"

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
# One .tiff holding both resolutions, so the background is sharp on Retina displays.
tiffutil -cathidpicheck assets/dmg-background.png assets/dmg-background@2x.png -out "$STAGING/background.tiff" 2>/dev/null
rm -f "$DMG"
dmgbuild -s scripts/dmg-settings.py -D app="out/$NAME.app" -D background="$STAGING/background.tiff" "$NAME" "$DMG"
codesign --force --sign "$IDENTITY" --timestamp=none "$DMG"
echo "built $(pwd)/$DMG"
