#!/bin/zsh
# Builds out/<display name>-<version>.dmg (scripts/dmg.sh) and attaches it to a draft GitHub release v<version> at the
# current commit. Publish the draft on GitHub once it has been checked. The Release workflow runs this for a pushed
# v<version> tag; run it by hand only when CI cannot.
#
# usage: pnpm run release <signing identity>
# The identity is required: an ad-hoc app would lose its permissions on every update.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${1:-${SIGN_IDENTITY:-}}"
[ -n "$IDENTITY" ] && [ "$IDENTITY" != "-" ] || { echo "usage: pnpm run release <signing identity>" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or set aside your changes first; the release is tagged at HEAD" >&2; exit 1; }

scripts/dmg.sh "$IDENTITY"

NAME=$(node --input-type=module -e 'import { DISPLAY_NAME } from "./dist/config.js"; console.log(DISPLAY_NAME)')
VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"
DMG="out/$NAME-$VERSION.dmg"

NOTES=$(mktemp)
cat > "$NOTES" <<EOF
## Install

1. Open \`$NAME-$VERSION.dmg\` and drag **$NAME** to Applications.
2. Open $NAME. macOS blocks it the first time, because it is signed with a personal certificate rather than an Apple Developer ID. Go to **System Settings → Privacy & Security** and choose **Open Anyway** next to $NAME. This is needed once.
3. $NAME lives in the menu bar. Onboarding asks for microphone and system-audio access.

Summaries need [Ollama](https://ollama.com) running locally with a model pulled; Settings shows whether it is ready. The speech and speaker models download on first use. Nothing leaves the Mac.

Requires macOS 14.2 or later on Apple silicon.
EOF

# In the Release workflow the commit is already on GitHub, checked out at its tag.
[ -n "${GITHUB_ACTIONS:-}" ] || git push -q origin HEAD
gh release create "$TAG" "$DMG" --draft --target "$(git rev-parse HEAD)" --title "$NAME $VERSION" --notes-file "$NOTES"
rm -f "$NOTES"
