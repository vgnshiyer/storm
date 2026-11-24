#!/bin/sh
# Build a signed, notarized dist/Storm-<version>.dmg for a GitHub release.
#
#   scripts/release.sh                 the version is package.json's
#
# Needs a "Developer ID Application" certificate in the keychain, and a notarytool keychain
# profile, made once with:
#   xcrun notarytool store-credentials storm-notary \
#       --apple-id <apple id> --team-id <team id> --password <app-specific password>
#
#   STORM_NOTARY_PROFILE   another profile name (default storm-notary)
#   STORM_SIGN_IDENTITY    which certificate, if the keychain holds several
#   STORM_ARCH             arm64 (default), x64 or universal
#   STORM_SKIP_NOTARIZE=1  stop after signing, to try the build here; other Macs will not
#                          open it without a warning
#   STORM_RESUME=1         carry on from the app already built and signed in dist/release,
#                          after a run that Apple's servers cut short
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
VERSION=$(node -p "require('./package.json').version")
ARCH=${STORM_ARCH:-arm64}
PROFILE=${STORM_NOTARY_PROFILE:-storm-notary}
OUT="$ROOT/dist/release"
APP="$OUT/Storm-darwin-$ARCH/Storm.app"
DMG="$ROOT/dist/Storm-$VERSION.dmg"
[ "$ARCH" = universal ] || DMG="$ROOT/dist/Storm-$VERSION-$ARCH.dmg"

IDENTITY=${STORM_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p' | head -1)}
[ -n "$IDENTITY" ] || { echo "error: no Developer ID Application certificate in the keychain" >&2; exit 1; }
if [ -z "${STORM_SKIP_NOTARIZE:-}" ]; then
    xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null || {
        echo "error: Apple's notary service did not accept the profile '$PROFILE' (its message is above); see the top of $0" >&2; exit 1; }
fi

if [ -n "${STORM_RESUME:-}" ] && codesign --verify --deep --strict "$APP" 2>/dev/null; then
echo "carrying on with the signed app in $OUT"
else
# 1. The app, with only what it runs on: no site, no design files, no scripts.
rm -rf "$OUT"
npx --no-install electron-packager . Storm --platform=darwin --arch="$ARCH" --icon=assets/icon.icns \
    --app-bundle-id=me.vgnshiyer.storm --app-version="$VERSION" --out="$OUT" --overwrite \
    --ignore='^/design' --ignore='^/dist' --ignore='^/docs' --ignore='^/scripts' --ignore='^/assets' \
    --ignore='^/README\.md$' --ignore='^/\.gitignore$'

# 2. Signed with the Developer ID, hardened runtime on. Every file is stamped with the time by
#    Apple's server, which now and then turns a request away: signing is tried three times.
for attempt in 1 2 3; do
    node scripts/sign.mjs "$APP" "$IDENTITY" && break
    [ "$attempt" = 3 ] && { echo "error: signing failed three times" >&2; exit 1; }
    sleep 8
done
codesign --verify --deep --strict "$APP"
fi

# Submit a file to Apple's notary service and wait; fail with Apple's log when it is not
# accepted. A request that does not get through (the upload is large) is tried three times.
notarize() {
    for attempt in 1 2 3; do
        out=$(xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait --output-format json) && break
        [ "$attempt" = 3 ] && { echo "error: Apple's notary service could not be reached three times" >&2; exit 1; }
        echo "the notary request did not get through; trying again" >&2
        sleep 20
    done
    status=$(printf '%s' "$out" | /usr/bin/python3 -I -c 'import json, sys; print(json.load(sys.stdin).get("status", ""))')
    if [ "$status" != "Accepted" ]; then
        id=$(printf '%s' "$out" | /usr/bin/python3 -I -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))')
        echo "error: notarization of $1 returned '$status'" >&2
        [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2
        exit 1
    fi
    echo "notarized $(basename "$1")"
}

WORK="$OUT/work"
rm -rf "$WORK" && mkdir -p "$WORK/dmg"

# 3. The app is notarized by itself first, so its ticket travels with it once it is dragged
#    out of the disk image.
if [ -z "${STORM_SKIP_NOTARIZE:-}" ]; then
    ditto -c -k --keepParent "$APP" "$WORK/Storm.zip"
    notarize "$WORK/Storm.zip"
    xcrun stapler staple "$APP"
fi

# 4. A drag-to-Applications disk image round it.
ditto "$APP" "$WORK/dmg/Storm.app"
ln -s /Applications "$WORK/dmg/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname "Storm $VERSION" -srcfolder "$WORK/dmg" -fs HFS+ -format UDZO "$DMG"
for attempt in 1 2 3; do
    codesign --force --timestamp --sign "$IDENTITY" "$DMG" && break
    [ "$attempt" = 3 ] && { echo "error: signing the disk image failed three times" >&2; exit 1; }
    sleep 8
done
rm -rf "$WORK"

if [ -n "${STORM_SKIP_NOTARIZE:-}" ]; then
    echo "built $DMG (signed, NOT notarized)"
    exit 0
fi
notarize "$DMG"
xcrun stapler staple "$DMG"

# 5. What a downloader's Mac will check.
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
spctl --assess --type execute --verbose=2 "$APP"
echo "built $DMG"
shasum -a 256 "$DMG"
