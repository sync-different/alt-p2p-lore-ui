#!/bin/bash
# DMG from the signed .app. The DMG is notarized SEPARATELY from the app and then stapled —
# verify with `stapler validate`, not `spctl --assess --type install` (alt-p2p-ui lesson).
set -euo pipefail
PROFILE="notary-profile1"
DMG="alt-lore-desktop_0.1.0_aarch64.dmg"

echo "=== Creating DMG from signed .app ==="
rm -f "$DMG"
hdiutil create -volname "alt-lore Desktop" -srcfolder "alt-lore Desktop.app" -ov -format UDZO "$DMG"

echo "=== Notarizing DMG (waits) ==="
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait

echo "=== Stapling ==="
xcrun stapler staple "$DMG"

echo "=== Validating ==="
stapler validate "$DMG"
echo "Done: $DMG"
