# Agentiz client

A Kotlin Multiplatform / Compose Multiplatform client for the Agentiz server. One `commonMain`
codebase renders the same UI on **web (Wasm)**, **desktop (JVM)**, **Android** and **iOS**.

What the app does: sign in against the Agentiz mobile API, browse your projects, open a project's
tasks, create a task, run or stop its pipeline, browse the history of all runs with their results
and execution logs, and read the discussion thread.

---

## Requirements

| | |
|---|---|
| JDK | 21 (the build targets JVM 11 bytecode, but Gradle itself runs on 21) |
| Gradle | none — use the bundled `./gradlew` |
| Node.js | none — Gradle downloads its own Node/Yarn for the Wasm target |
| Android | Android SDK, only for the Android target |
| iOS | Xcode on macOS, only for the iOS target |

An Agentiz server must be reachable — see [Connecting to a server](#connecting-to-a-server).

---

## Web (Wasm) — the quickest way to see it

```bash
./gradlew :composeApp:wasmJsBrowserDevelopmentRun
```

Then open **<http://localhost:8081/>**.

The port is set in [`composeApp/build.gradle.kts`](composeApp/build.gradle.kts); webpack's default
of 8080 collides with too much on a typical dev box.

The first run takes a few minutes — Gradle downloads the Kotlin/Wasm toolchain, provisions Node and
Yarn, and webpack bundles Skiko. Later runs start in seconds.

### The browser needs WebGL

Compose Multiplatform renders through Skiko, which requires a WebGL context. **A browser without
one shows a blank white page**, not an error: Skiko throws inside its startup coroutine and Compose
removes its canvas.

Check `chrome://gpu` (or `about:support` on Firefox) for WebGL. On a headless box, a VM or a
container with no GPU, launch Chromium with software rendering:

```bash
chromium --use-gl=angle --use-angle=swiftshader http://localhost:8081/
```

Both flags are required together. If you hit a white page, this is almost always why.

### Production bundle

```bash
./gradlew :composeApp:wasmJsBrowserDistribution
```

Output lands in `composeApp/build/dist/wasmJs/productionExecutable/` — static files, serve them with
any web server.

---

## Desktop (JVM)

```bash
./gradlew :composeApp:run
```

Opens a 480×640 window. No WebGL caveat here — the desktop target renders natively.

Native installers (`.deb`, `.msi`, `.dmg` for the host OS):

```bash
./gradlew :composeApp:packageDistributionForCurrentOS
```

---

## Android

```bash
./gradlew :composeApp:installDebug
```

Installs onto the running emulator or a connected device. Opening the repo root in Android Studio
and hitting Run works too.

---

## iOS

Open [`iosApp/iosApp.xcodeproj`](iosApp/) in Xcode and run. Gradle builds the shared framework as
part of the Xcode build; there is no separate command.

---

## Connecting to a server

The login screen's **Сервер** field is pre-filled with a per-platform default:

| Target | Default |
|---|---|
| Android | `http://10.0.2.2:17280` — the emulator's route to the host loopback |
| web, desktop, iOS | `http://localhost:17280` |

Override it in the field to point at any reachable instance. The app talks to
`/api/agentiz/mobile/v1` under whatever origin you give it.

Sign in with an Adminizer admin login and password. On a fresh server no administrator exists yet —
create the first one at `/dashboard/init_user`, then use those credentials here.

### Assistant

The **Агент** item opens the `agentiz-assistant` chat. The app first exchanges its mobile JWT at
`POST /assistant/webview-session`; the server returns a one-use link, which the WebView exchanges
for an HttpOnly dashboard-session cookie. The chat can therefore stream and send messages without
ever receiving the mobile JWT. The account needs the server permission
`ai-assistant-agentiz-assistant`.

The server must include the `workerResult` field in `GET /tasks/:taskId/runs/:runId` for the app to
render the complete persisted worker payload. The app automatically loads that detailed endpoint
for the newest run (and when a history entry is selected), then renders it as selectable formatted
JSON alongside the ordered execution log and result summary.

**Web builds need CORS on the server.** The page is served from `:8081` while the API lives on
another port, so every request is cross-origin. The Agentiz mobile API already enables a wildcard
origin (bearer tokens, no cookies), so this works out of the box against a stock server.

---

## Tests

```bash
./gradlew :composeApp:desktopTest
```

UI tests run on the desktop target via `compose.ui.test`.

---

## Layout

```
composeApp/src/
  commonMain/     the entire app — UI, navigation, API client, DTOs
    components/   AppButton, AppTextField
    data/         AgentizApi, DTOs, Session, per-platform server default
    screens/      Login, Projects, Tasks, TaskDetail
    theme/        AppTheme design tokens
  wasmJsMain/     ComposeViewport entrypoint + index.html
  desktopMain/    Window entrypoint
  androidMain/    MainActivity
  iosMain/        MainViewController
  desktopTest/    UI tests
```

Only the entrypoint and the default server URL are per-platform; every screen is shared.

---

## Troubleshooting

**Blank white page in the browser.** WebGL is unavailable — see
[The browser needs WebGL](#the-browser-needs-webgl).

**Edited Kotlin but the browser shows the old UI.** `compileKotlinWasmJs` alone does not update what
the dev server serves; webpack watches a later task's output. Restart
`wasmJsBrowserDevelopmentRun`, or start it with `--continuous` so edits rebuild automatically.

**`EADDRINUSE` on 8081.** Another process holds the port. Free it, or change `port` in
[`composeApp/build.gradle.kts`](composeApp/build.gradle.kts).

**"Не удалось подключиться к серверу".** The Agentiz server is not reachable at the URL in the
Сервер field. Confirm it directly:

```bash
curl http://localhost:17280/api/agentiz/mobile/v1/healthz
```

**Builds get killed on a memory-tight machine.** The Gradle daemon is configured for `-Xmx3g` in
[`gradle.properties`](gradle.properties) and stays resident between builds. Running a second Gradle
build alongside the dev server can push a 16 GB box into the OOM killer. Lower `org.gradle.jvmargs`
or avoid concurrent builds.
