#!/bin/bash
# Validates an App Store provisioning profile and writes it into .env as
# IOS_PROVISIONING_PROFILE_BASE64.
#
# Usage: ./add-profile.sh <path-to.mobileprovision>

set -euo pipefail

PROFILE="${1:?usage: $0 <path-to.mobileprovision>}"
ENV_FILE="$(dirname "$0")/.env"
EXPECTED_BUNDLE="cx.m42.agentoz"

security cms -D -i "$PROFILE" > /tmp/_pp.plist 2>/dev/null
NAME=$(/usr/libexec/PlistBuddy -c 'Print :Name' /tmp/_pp.plist)
APP_ID=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' /tmp/_pp.plist)

# App Store profiles have no device list. A Development/Ad Hoc profile does, and
# App Store Connect rejects those on upload.
if /usr/libexec/PlistBuddy -c 'Print :ProvisionedDevices' /tmp/_pp.plist >/dev/null 2>&1; then
  echo "FAIL: '$NAME' lists specific devices — that is Development or Ad Hoc."
  echo "      Create an App Store profile instead."
  exit 1
fi

case "$APP_ID" in
  *"$EXPECTED_BUNDLE") ;;
  *) echo "FAIL: profile is for '$APP_ID', expected *.$EXPECTED_BUNDLE"; exit 1 ;;
esac

# Confirm it was signed with the distribution cert we already have in .env.
CERT_CN=$(openssl x509 -in "$(dirname "$0")/apple-signing/distribution.pem" -noout -subject 2>/dev/null | grep -o 'Apple Distribution: [^,/]*' || true)

B64=$(base64 -i "$PROFILE" | tr -d '\n')
python3 - "$ENV_FILE" "$B64" <<'PYEOF'
import re, sys
path, b64 = sys.argv[1], sys.argv[2]
t = open(path).read()
t = re.sub(r"^IOS_PROVISIONING_PROFILE_BASE64=.*$",
           f"IOS_PROVISIONING_PROFILE_BASE64={b64}", t, flags=re.M)
open(path, "w").write(t)
PYEOF
chmod 600 "$ENV_FILE"
rm -f /tmp/_pp.plist

echo "OK  profile : $NAME"
echo "OK  app id  : $APP_ID"
[ -n "$CERT_CN" ] && echo "note      : signed for team cert '$CERT_CN'"
echo
echo "Wrote IOS_PROVISIONING_PROFILE_BASE64 to .env."
