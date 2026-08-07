# Filling in the CI signing secrets

Values live in `.env` (gitignored). Two of the eight are already set; the rest
need things that do not exist yet in this account/keychain.

App: `cx.m42.agentoz`, team `5K5GDFV386` (AVTOTREID, OOO).

## Already set

`IOS_DEVELOPMENT_TEAM` is the team ID, read off the signing certificate.
`KEYCHAIN_PASSWORD` is a random 32-character string — it only protects the
temporary keychain the workflow creates, so any random value works.

## Distribution certificate

The keychain currently holds only *Apple Development* certificates. App Store
uploads require an *Apple Distribution* one, which does not exist yet.

Easiest path is Xcode on a machine signed into the account: Settings → Accounts
→ select the team → Manage Certificates → **+** → Apple Distribution. Or create
a CSR and upload it at developer.apple.com/account/resources/certificates.

Then export it **with its private key** — this is the part that matters, a
certificate alone cannot sign:

1. Keychain Access → My Certificates
2. Right-click the *Apple Distribution* entry → Export
3. Save as `.p12`, set a password (this becomes
   `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`)

    base64 -i cert.p12 | tr -d '\n'      # -> IOS_DISTRIBUTION_CERTIFICATE_BASE64

Verify the export actually contains a key before trusting it:

    openssl pkcs12 -in cert.p12 -nokeys -info 2>/dev/null | grep subject
    openssl pkcs12 -in cert.p12 -nocerts -info 2>/dev/null | grep -c "PRIVATE KEY"

## App Store provisioning profile

The one local profile (`iOS Team Provisioning Profile: *`) is Development —
`get-task-allow` is 1, which App Store Connect rejects. A new profile is needed:

developer.apple.com/account/resources/profiles → **+** → **App Store** →
App ID `cx.m42.agentoz` → the distribution certificate above → download.

    base64 -i profile.mobileprovision | tr -d '\n'   # -> IOS_PROVISIONING_PROFILE_BASE64

Confirm you grabbed the right kind — App Store profiles have no
`ProvisionedDevices` list and no `get-task-allow`:

    security cms -D -i profile.mobileprovision | plutil -p - | grep -E "Name|get-task-allow"

## App Store Connect API key

App Store Connect → Users and Access → Integrations → App Store Connect API →
**+**. Role **App Manager** (Developer cannot upload builds).

The page shows **Issuer ID** (`APP_STORE_CONNECT_ISSUER_ID`, a UUID, same for
every key in the account) and the row shows **Key ID**
(`APP_STORE_CONNECT_API_KEY_ID`, 10 characters).

**The .p8 downloads once and only once.** Apple will not re-issue it; losing it
means revoking the key and starting over. Save the original outside this repo,
for example `~/.appstoreconnect/private_keys/`, before encoding it.

    base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n'   # -> APP_STORE_CONNECT_API_KEY_BASE64

## Pushing to GitHub

Repo is `agentiz-oss/mobile-client`. `gh` is not installed here, so either
install it (`brew install gh`) or paste the values at
https://github.com/agentiz-oss/mobile-client/settings/secrets/actions

With `gh`, once `.env` is complete:

    set -a; . ./.env; set +a
    for k in IOS_DEVELOPMENT_TEAM IOS_DISTRIBUTION_CERTIFICATE_BASE64 \
             IOS_DISTRIBUTION_CERTIFICATE_PASSWORD IOS_PROVISIONING_PROFILE_BASE64 \
             APP_STORE_CONNECT_API_KEY_ID APP_STORE_CONNECT_ISSUER_ID \
             APP_STORE_CONNECT_API_KEY_BASE64 KEYCHAIN_PASSWORD; do
      printf '%s' "${(P)k}" | gh secret set "$k" --repo agentiz-oss/mobile-client
    done

That loop uses zsh's `${(P)k}` indirect expansion; in bash use `${!k}`.
`printf` rather than `echo` keeps a trailing newline out of the base64 blobs,
which otherwise breaks decoding in the runner.

## Note on the bundle ID

`Config.xcconfig` now says `cx.m42.agentoz`. The app currently installed on the
test iPhone was built as `com.example.app.iosApp`, so after this change a new
build installs alongside it rather than replacing it. Delete the old one from
the phone when it stops being useful.
