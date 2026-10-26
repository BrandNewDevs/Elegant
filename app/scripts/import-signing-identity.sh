#!/bin/zsh
# For CI: imports the signing identity into a keychain of its own and prints its SHA-1 hash, which `codesign --sign`
# accepts. The app's designated requirement pins the certificate, so CI must sign with the same one as a local build or
# every update loses the microphone and system-audio permissions.
#
# usage: SIGNING_IDENTITY_P12=<base64 .p12> SIGNING_IDENTITY_PASSWORD=<its password> scripts/import-signing-identity.sh <keychain path>
# Delete the keychain afterwards with: security delete-keychain <keychain path>
set -euo pipefail

KEYCHAIN="${1:?usage: scripts/import-signing-identity.sh <keychain path>}"
: "${SIGNING_IDENTITY_P12:?set SIGNING_IDENTITY_P12 to the base64 of the .p12}"
: "${SIGNING_IDENTITY_PASSWORD:?set SIGNING_IDENTITY_PASSWORD to the .p12 password}"

P12=$(mktemp)
trap 'rm -f "$P12"' EXIT
print -rn -- "$SIGNING_IDENTITY_P12" | base64 --decode > "$P12"

# A random password: the keychain only lives for this job, and nobody needs to unlock it again.
KEYCHAIN_PASSWORD=$(openssl rand -hex 24)
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN" # stays unlocked for 6 hours instead of locking after 5 minutes
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$P12" -f pkcs12 -k "$KEYCHAIN" -P "$SIGNING_IDENTITY_PASSWORD" -T /usr/bin/codesign >/dev/null
# Lets codesign use the key without a dialog, which would hang a headless runner.
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
# codesign finds identities only in keychains on the search list.
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

# The certificate is self-signed, so it is not "valid" to macOS; codesign signs with it anyway when given its hash.
HASH=$(security find-identity -p codesigning "$KEYCHAIN" | awk '/^ *1\)/ { print $2; exit }')
[ -n "$HASH" ] || { echo "no code-signing identity in the .p12" >&2; exit 1; }
echo "$HASH"
