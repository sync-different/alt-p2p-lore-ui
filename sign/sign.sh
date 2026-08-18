#!/bin/bash
# Sign alt-lore Desktop the way alt-p2p-ui is signed: inside-out under the hardened runtime.
#
# The JRE needs the JIT entitlements (jre.entitlements) or HotSpot dies with SIGTRAP the
# moment the tunnel starts — learned on alt-p2p-ui, kept identical here. Order matters:
# innermost Mach-O first, the .app seal last, or the outer signature is invalidated.
#
# Run from sign/:  ./sign.sh
# Produces: "alt-lore Desktop.app" (signed) and alt-lore-desktop.zip, then submits the zip
# for notarization (requires the keychain profile below to exist — see NOTARY.md).
set -euo pipefail

IDENTITY="Developer ID Application: Alterante LLC (TCT2QHH9TG)"
PROFILE="notary-profile1"
APP="alt-lore Desktop.app"
ZIP="alt-lore-desktop.zip"

echo "=== Copying .app bundle ==="
rm -rf "$APP"
cp -R "../src-tauri/target/release/bundle/macos/alt-lore Desktop.app" .

echo "=== Signing JRE dylibs ==="
find "$APP/Contents/Resources/jre" -type f -name "*.dylib" | while read -r lib; do
  echo "  $lib"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$lib"
done

echo "=== Signing JRE executables (JIT entitlements) ==="
for bin in "$APP/Contents/Resources/jre/bin/"* "$APP/Contents/Resources/jre/lib/jspawnhelper"; do
  if [ -f "$bin" ] && file "$bin" | grep -q "Mach-O"; then
    echo "  $bin"
    codesign --force --options runtime --timestamp \
      --entitlements jre.entitlements --sign "$IDENTITY" "$bin"
  fi
done

echo "=== Signing sidecars (lore, run-java) ==="
for bin in "$APP/Contents/MacOS/"*; do
  if [ -f "$bin" ] && [ "$(basename "$bin")" != "alt-p2p-lore-ui" ]; then
    echo "  $bin"
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$bin"
  fi
done

echo "=== Signing main binary ==="
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP/Contents/MacOS/alt-p2p-lore-ui"

echo "=== Sealing the .app ==="
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"

echo "=== Verifying ==="
codesign --verify --deep --strict --verbose=2 "$APP"

echo "=== Zipping for notarization ==="
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "=== Submitting for notarization (waits) ==="
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait

echo "=== Stapling the .app ==="
xcrun stapler staple "$APP"
echo "Done. Next: ./dmg.sh"
