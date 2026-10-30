#!/bin/zsh
# Builds out/<display name>.app: Electron's bundle with the permanent bundle id, the built app in Contents/Resources/app
# and the Swift engine in Contents/Helpers/engine, signed inside-out.
#
# usage: pnpm run package [signing identity]
# The identity can also come from SIGN_IDENTITY. macOS keeps microphone and system-audio permission only while the
# identity stays the same, so use a real one; "-" (ad-hoc, the default) re-prompts after every rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${1:-${SIGN_IDENTITY:--}}"

pnpm run build
pnpm run build:engine

NAME=$(node --input-type=module -e 'import { DISPLAY_NAME } from "./dist/config.js"; console.log(DISPLAY_NAME)')
BUNDLE_ID=$(node --input-type=module -e 'import { BUNDLE_ID } from "./dist/config.js"; console.log(BUNDLE_ID)')
VERSION=$(node -p 'require("./package.json").version')
ELECTRON_APP=node_modules/electron/dist/Electron.app
[ -d "$ELECTRON_APP" ] || { echo "Electron is not downloaded; run: node node_modules/electron/install.js" >&2; exit 1; }

APP="out/$NAME.app"
rm -rf "$APP"
mkdir -p out
ditto "$ELECTRON_APP" "$APP"

PLIST="$APP/Contents/Info.plist"
plist_set() { # key type value [plist]: sets the key, adding it when Electron's plist does not have it
  local file="${4:-$PLIST}"
  /usr/libexec/PlistBuddy -c "Set :$1 $3" "$file" >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$file"
}
plist_set CFBundleIdentifier string "$BUNDLE_ID"
plist_set CFBundleName string "$NAME"
plist_set CFBundleDisplayName string "$NAME"
# Electron counts as packaged only when its executable is not called Electron, and it finds its helpers by that name.
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$NAME"
plist_set CFBundleExecutable string "'$NAME'"
for helper in "$APP"/Contents/Frameworks/Electron\ Helper*.app; do
  suffix="${${helper:t:r}#Electron Helper}" # "", " (GPU)", " (Plugin)" or " (Renderer)"
  renamed="$APP/Contents/Frameworks/$NAME Helper$suffix.app"
  mv "$helper/Contents/MacOS/Electron Helper$suffix" "$helper/Contents/MacOS/$NAME Helper$suffix"
  plist_set CFBundleExecutable string "'$NAME Helper$suffix'" "$helper/Contents/Info.plist"
  plist_set CFBundleName string "'$NAME Helper$suffix'" "$helper/Contents/Info.plist"
  kind="${${suffix//[ ()]/}:l}" # "", "gpu", "plugin" or "renderer"
  plist_set CFBundleIdentifier string "$BUNDLE_ID.helper${kind:+.$kind}" "$helper/Contents/Info.plist"
  mv "$helper" "$renamed"
done
plist_set CFBundleShortVersionString string "$VERSION"
plist_set CFBundleVersion string "$VERSION"
plist_set LSUIElement bool true # a menu-bar app: no Dock icon while it starts; "Show in Dock" adds one at runtime
plist_set NSMicrophoneUsageDescription string "'$NAME records your side of a call when you choose Record.'"
plist_set NSAudioCaptureUsageDescription string "'$NAME records the other side of a call when you choose Record.'"

# The app's own icon in place of Electron's, and the menu-bar item's icons, which the main process reads from Resources.
rm -f "$APP/Contents/Resources/electron.icns"
cp assets/icon.icns "$APP/Contents/Resources/icon.icns"
plist_set CFBundleIconFile string icon
mkdir -p "$APP/Contents/Resources/tray"
cp assets/tray/iconTemplate.png "assets/tray/iconTemplate@2x.png" "$APP/Contents/Resources/tray/"

# Electron runs Resources/app when it exists; its own default app is not needed.
rm -f "$APP/Contents/Resources/default_app.asar"
mkdir -p "$APP/Contents/Resources/app"
cp package.json "$APP/Contents/Resources/app/"
rsync -a --exclude evaluation dist "$APP/Contents/Resources/app/"

# The main process's runtime dependencies (electron-updater and what it needs), installed from the lockfile as plain
# folders: everything else is bundled by Vite, so it is a devDependency and stays out of the app.
DEPS=$(mktemp -d)
trap 'rm -rf "$DEPS"' EXIT
cp package.json pnpm-lock.yaml "$DEPS/"
(cd "$DEPS" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted >/dev/null)
rsync -a --exclude '/.*' "$DEPS/node_modules" "$APP/Contents/Resources/app/"

# Where electron-updater looks for updates: the releases of RELEASES_REPO, whose latest-mac.yml names the .zip.
REPO=$(node --input-type=module -e 'import { RELEASES_REPO } from "./dist/config.js"; console.log(RELEASES_REPO)')
cat > "$APP/Contents/Resources/app-update.yml" <<EOF
provider: github
owner: ${REPO%%/*}
repo: ${REPO##*/}
updaterCacheDirName: $BUNDLE_ID-updater
EOF

mkdir -p "$APP/Contents/Helpers"
cp ../engine/.build/release/engine "$APP/Contents/Helpers/engine"

# Inside-out: nested code first, the app last, so each signature covers the finished contents.
for f in "$APP"/Contents/Frameworks/*.framework "$APP"/Contents/Frameworks/*.app; do
  codesign --force --sign "$IDENTITY" --timestamp=none "$f"
done
codesign --force --sign "$IDENTITY" --timestamp=none --identifier "$BUNDLE_ID.engine" "$APP/Contents/Helpers/engine"
codesign --force --sign "$IDENTITY" --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"

codesign -d -r- "$APP" 2>&1 | grep designated
[ "$IDENTITY" = "-" ] && echo "warning: ad-hoc signed; macOS will ask for permissions again after every rebuild" >&2
echo "built $(pwd)/$APP"
