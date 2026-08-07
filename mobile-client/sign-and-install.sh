#!/bin/bash
# Signs an unsigned .app built on the remote CI machine and installs it on the
# USB-connected iPhone.
#
# The remote CI Mac has the iOS 18 SDK but no signing certificate; this machine
# has the certificate but only the iOS 16.2 SDK. So we build there and sign here.
#
# Usage: ./sign-and-install.sh <path-to-unsigned.app>

set -euo pipefail

APP_PATH="${1:?usage: $0 <path-to-unsigned.app>}"
# Two certs share this common name, so identify by SHA-1 hash to stay unambiguous.
IDENTITY="60A1A9412EB076F2B4121E0685A1F45142C5CA9D"
PROFILE="$HOME/Library/MobileDevice/Provisioning Profiles/873421ea-9150-4e0f-ad92-f7f6fa00dc6c.mobileprovision"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

APP_NAME=$(basename "$APP_PATH")
cp -R "$APP_PATH" "$WORK_DIR/$APP_NAME"
TARGET="$WORK_DIR/$APP_NAME"

# The provisioning profile must travel inside the bundle as embedded.mobileprovision.
cp "$PROFILE" "$TARGET/embedded.mobileprovision"

# Entitlements must be derived from the profile so they match what Apple authorized.
security cms -D -i "$PROFILE" > "$WORK_DIR/profile.plist"
/usr/libexec/PlistBuddy -x -c 'Print :Entitlements' "$WORK_DIR/profile.plist" \
  > "$WORK_DIR/entitlements.plist"

# Nested code (frameworks, dylibs) must be signed before the outer bundle.
if [ -d "$TARGET/Frameworks" ]; then
  find "$TARGET/Frameworks" -maxdepth 1 \( -name '*.framework' -o -name '*.dylib' \) | while read -r item; do
    codesign --force --sign "$IDENTITY" --timestamp=none "$item"
  done
fi

codesign --force --sign "$IDENTITY" \
  --entitlements "$WORK_DIR/entitlements.plist" \
  --timestamp=none \
  "$TARGET"

codesign --verify --verbose=2 "$TARGET"

ideviceinstaller install "$TARGET"
