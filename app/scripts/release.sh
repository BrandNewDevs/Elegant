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

# The draft's body: this template (install steps, permissions), then the "What's Changed" list that GitHub generates
# from the pull requests merged since the previous release (everything so far, for the first release). The list comes
# from GitHub, so the checkout needs no tag history.
NOTES=$(mktemp)
cat > "$NOTES" <<EOF
## Install

1. Open \`$NAME-$VERSION.dmg\` and drag **$NAME** to Applications.
2. Open $NAME. macOS blocks it the first time, because it is signed with a personal certificate rather than an Apple Developer ID, so it is not notarized. Choose **Done** (not Move to Trash).
3. On macOS 15 and later, open **System Settings → Privacy & Security**, scroll to the **Security** section and click **Open Anyway** next to $NAME. The button appears only after the first blocked launch, and macOS may ask for your password or Touch ID. On macOS 14, **Open Anyway** should be in the same place, and Control-click → **Open** also works. This is needed once per install.
4. $NAME lives in the menu bar. Onboarding asks for your name and then for access.

If you get stuck, or would rather never see the dialog, this optional command removes the quarantine flag macOS puts on downloaded files, so Gatekeeper stops prompting for $NAME:

\`\`\`sh
xattr -dr com.apple.quarantine /Applications/$NAME.app
\`\`\`

## Permissions

$NAME needs the **microphone** and **system audio capture**. It asks only when you press the button for each in onboarding or Settings, never on its own. macOS ties these grants to the signing identity, and every release is signed with the same one, so updating does not ask again.

## Requirements

macOS 14.2 or later on Apple silicon. Summaries need [Ollama](https://ollama.com) running locally with a model pulled; Settings shows whether it is ready. The speech and speaker models download on first use. Nothing leaves the Mac.
EOF

# In the Release workflow the commit is already on GitHub, checked out at its tag.
[ -n "${GITHUB_ACTIONS:-}" ] || git push -q origin HEAD
gh release create "$TAG" "$DMG" --draft --target "$(git rev-parse HEAD)" --title "$NAME $VERSION" --notes-file "$NOTES" --generate-notes
rm -f "$NOTES"
