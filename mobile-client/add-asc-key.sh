#!/bin/bash
# Validates an App Store Connect API key and writes the three ASC values into .env.
#
# Usage: ./add-asc-key.sh <path-to-AuthKey_XXXXXXXXXX.p8> <key-id> <issuer-id>

set -euo pipefail

P8="${1:?path to AuthKey_XXXXXXXXXX.p8}"
KEY_ID="${2:?App Store Connect Key ID (10 chars, e.g. ABC123DEF4)}"
ISSUER_ID="${3:?App Store Connect Issuer ID (a UUID)}"
ENV_FILE="$(dirname "$0")/.env"

grep -q "BEGIN PRIVATE KEY" "$P8" || { echo "FAIL: $P8 is not a .p8 private key"; exit 1; }
openssl pkcs8 -nocrypt -in "$P8" -inform PEM >/dev/null 2>&1 \
  || { echo "FAIL: $P8 is not a valid PKCS#8 key"; exit 1; }

case "$ISSUER_ID" in
  *-*-*-*-*) ;;
  *) echo "FAIL: issuer id '$ISSUER_ID' does not look like a UUID"; exit 1 ;;
esac

# Apple names the file AuthKey_<KEYID>.p8; warn if the id given does not match it.
BASE=$(basename "$P8")
case "$BASE" in
  AuthKey_${KEY_ID}.p8) ;;
  AuthKey_*.p8) echo "warning: file is $BASE but key id given is $KEY_ID — double-check they match." ;;
esac

B64=$(base64 -i "$P8" | tr -d '\n')
python3 - "$ENV_FILE" "$KEY_ID" "$ISSUER_ID" "$B64" <<'PYEOF'
import re, sys
path, kid, iss, b64 = sys.argv[1:5]
vals = {
    "APP_STORE_CONNECT_API_KEY_ID": kid,
    "APP_STORE_CONNECT_ISSUER_ID": iss,
    "APP_STORE_CONNECT_API_KEY_BASE64": b64,
}
t = open(path).read()
for k, v in vals.items():
    t = re.sub(rf"^{k}=.*$", f"{k}={v}", t, flags=re.M)
open(path, "w").write(t)
PYEOF
chmod 600 "$ENV_FILE"

echo "OK  key id    : $KEY_ID"
echo "OK  issuer id : $ISSUER_ID"
echo "OK  .p8       : valid PKCS#8"
echo
echo "Wrote 3 ASC values to .env. Keep the original .p8 safe — Apple issues it once."
