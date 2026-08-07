# iOS → TestFlight (GitHub Actions + Fastlane)

`ios-testflight.yml` archives the Compose Multiplatform iOS app on a macOS runner,
signs it with a distribution certificate and an App Store provisioning profile, and
uploads it to TestFlight.

It runs on every push to `main` and can be started manually
(**Actions → Build and Deploy iOS to TestFlight → Run workflow**).

## What the build actually does

1. Installs JDK 17, the Android SDK (needed because `composeApp` applies the Android
   Gradle plugin — Gradle refuses to configure the project without it) and Fastlane.
2. Writes `TEAM_ID` / `BUNDLE_ID` into `iosApp/Configuration/Config.xcconfig`.
3. Imports the distribution certificate into a temporary keychain and installs the
   provisioning profile.
4. Runs `fastlane beta` (see `iosApp/fastlane/Fastfile`), which flips the project to
   manual signing, runs `gym` on the `iosApp` scheme — the Xcode build phase calls
   `./gradlew :composeApp:embedAndSignAppleFrameworkForXcode` to build the Kotlin
   framework — and then uploads the `.ipa` with `pilot`.

## Required repository secrets

| Secret | What it is |
| --- | --- |
| `IOS_DEVELOPMENT_TEAM` | 10-character Apple Developer Team ID |
| `IOS_DISTRIBUTION_CERTIFICATE_BASE64` | `base64 -i cert.p12` of an Apple Distribution certificate exported from Keychain Access |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12` |
| `IOS_PROVISIONING_PROFILE_BASE64` | `base64 -i profile.mobileprovision` of an **App Store** profile for the bundle id |
| `APP_STORE_CONNECT_API_KEY_ID` | Key ID of an App Store Connect API key (role: App Manager) |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID shown on the same App Store Connect page |
| `APP_STORE_CONNECT_API_KEY_BASE64` | `base64 -i AuthKey_XXXXXX.p8` |
| `KEYCHAIN_PASSWORD` | Optional. A random password is generated when unset |

On macOS use `base64 -i <file> | pbcopy` to produce the values (no line breaks).

## Optional repository variables

| Variable | Effect |
| --- | --- |
| `IOS_BUNDLE_ID` | Overrides `BUNDLE_ID` from `Config.xcconfig` (currently `com.example.app.iosApp`) |
| `IOS_TESTFLIGHT_GROUPS` | Comma-separated tester groups, e.g. `Dev`. Ignored when processing is skipped |
| `IOS_MARKETING_VERSION` | Overrides `MARKETING_VERSION`, e.g. `1.2.0` |
| `IOS_CODE_SIGN_IDENTITY` | Overrides the signing identity name (default `iPhone Distribution`); set to `Apple Distribution` if xcodebuild reports "no signing certificate found" |

## Version numbers

`Info.plist` takes its version from build settings, so the workflow can inject them:

* **Build number** — `max(latest TestFlight build + 1, github.run_number)`, so re-runs
  never collide with an existing upload.
* **Marketing version** — `MARKETING_VERSION` from the Xcode project (`1.0`) unless the
  `IOS_MARKETING_VERSION` variable is set.

## Before the first run

* The bundle id must exist in App Store Connect with an app record attached, otherwise
  the upload fails with "app not found".
* `com.example.app.iosApp` is the template default — set the `IOS_BUNDLE_ID` variable (or
  edit `Config.xcconfig`) to a bundle id your team actually owns.
* The provisioning profile must be of type **App Store** and reference the distribution
  certificate from `IOS_DISTRIBUTION_CERTIFICATE_BASE64`.

## Running it locally

```bash
cd iosApp
export IOS_DEVELOPMENT_TEAM=ABCDE12345
export IOS_BUNDLE_ID=com.example.app.iosApp
export IOS_PROVISIONING_PROFILE_UUID=<uuid of an installed profile>
export APP_STORE_CONNECT_API_KEY_ID=... APP_STORE_CONNECT_ISSUER_ID=...
export APP_STORE_CONNECT_API_KEY_BASE64="$(base64 -i AuthKey_XXXXXX.p8)"
fastlane beta
```

`fastlane beta` rewrites signing settings in `iosApp.xcodeproj/project.pbxproj`; run
`git checkout iosApp/iosApp.xcodeproj/project.pbxproj` afterwards to get automatic
signing back for local development.
