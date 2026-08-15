# app-agentiz-mobile-api

Machine-facing JSON API for the Agentiz mobile client. It does two things: exchange an Adminizer
admin login (`UserAP`) for a JWT bearer token, and serve the projects that token's user owns.

It owns one model — `MobileDevice`, the push tokens of installed apps — and no admin pages;
everything else it serves is `UserAP` (app-adminizer) and `AgentProject` (app-agentiz). Like the Worker API, it is mounted on the **root** Express app, outside Adminizer's
`/dashboard` prefix, because mobile clients authenticate with their own bearer token, not admin
session cookies.

## Base path

```
/api/agentiz/mobile/v1
```

## Endpoints

| Method | Path             | Auth        | Purpose                                             |
| ------ | ---------------- | ----------- | --------------------------------------------------- |
| GET    | `/healthz`       | none        | Liveness probe.                                     |
| POST   | `/auth/login`    | none        | `{ login, password }` → `{ token, expiresAt, user }`. |
| GET    | `/auth/me`       | Bearer JWT  | The current user.                                   |
| GET    | `/projects`      | Bearer JWT  | Projects owned by the current user (secrets masked).|
| GET    | `/projects/:id`  | Bearer JWT  | One owned project, or 404.                           |
| GET    | `/runs`          | Bearer JWT  | Runs in flight across all owned projects, plus recent ones. |
| GET    | `/tasks/:id/runs` | Bearer JWT | Compact history of a task's pipeline runs.            |
| GET    | `/tasks/:taskId/runs/:runId` | Bearer JWT | Full result, stages and log of one run.       |
| POST   | `/tasks/:taskId/runs/:runId/cancel` | Bearer JWT | Requests cancellation of a run.             |
| GET    | `/interactions`  | Bearer JWT  | Questions agents are waiting on, across all owned projects. |
| GET    | `/interactions/:id` | Bearer JWT | One question by id — what a tapped notification opens. |
| POST   | `/interactions/:id/answer` | Bearer JWT | `{ action, content }` — answers one question.   |
| POST   | `/devices`       | Bearer JWT  | Registers this install's push token (idempotent).   |
| DELETE | `/devices[/:token]` | Bearer JWT | Forgets a push token — what signing out calls.    |
| POST   | `/assistant/webview-session` | Bearer JWT | Creates a one-use URL for the embedded Assistant WebView. |

`login` accepts whatever identifier the UserAP model stores (`login`, `email`, or `username`).
Project scope mirrors the admin panel's `userAccessRelation: 'owner'`: a user sees only the projects
whose `ownerId` is theirs. A project with no owner set is visible to nobody through this API.

## Human input (agent questions)

A pipeline stage can stop and ask the person a question — ACP form elicitation, brokered by
`app-agentiz/services/AgentRunInteractionService`. While one is unanswered the run and its stage sit
in `waiting_input` and the task reports `waiting_input` too, so the client must treat that status as
"still in flight" and keep polling.

The question carries a JSON Schema (`requestedSchema`, always `type: "object"` with `properties`)
that describes the form to render. `POST /interactions/:id/answer` takes:

- `{ "action": "accept", "content": { … } }` — the filled-in form, validated against that schema
  server-side; a mismatch comes back as 400 with the failing fields.
- `{ "action": "decline" }` / `{ "action": "cancel" }` — no content; the agent continues without
  an answer.

Answering does **not** resume the run by itself: the worker long-polls for the answer and only its
acknowledgement moves run, stage and task out of `waiting_input`, so a client keeps polling after
submitting instead of assuming the pause is over. A second answer to the same question fails with
409 (`Interaction is already answered`). Questions also
appear inline: `GET /tasks/:id` returns `pendingInteractions`, and a run returns its own
`interactions` (answered ones included, as the history of what was asked).

Sensitive fields are rejected when the question is *created*, not when it is answered: the core
service refuses schemas asking for passwords, API keys or card numbers, so nothing of that kind can
reach the app.

## Push notifications

A question nobody sees is a run that stays parked, so a new interaction is pushed to the project
owner's phones as it is created. The core layer owns the event and knows nothing about devices: it
emits through the `interactionNotifiers` app-manager collection
(`app-agentiz/lib/interactionNotifiers.ts`) and this layer contributes `MobilePushService`. Delivery
is fire-and-forget — a push that fails must never fail the agent's request.

The phone is not the only listener: app-agentiz sends the same event to Adminizer's notification
bell (`app-agentiz/lib/notifications/`), so the question is visible to somebody watching the
dashboard with no app installed. The two channels are independent — one being off changes nothing
about the other.

### Providers

*How* a message travels is a configuration choice, made once at start-up and invisible above it.
`MobilePushService` builds one message and hands it to a `PushProvider` (`lib/push/index.ts`); no
sending code anywhere asks which provider is installed.

```
                          ┌── FirebasePushProvider ──→ FCM
MobilePushService ──→ PushProvider
                          └── GatewayPushProvider ──→ Push Gateway ──→ FCM
```

| `PUSH_PROVIDER` | Sends via | Needs |
| --- | --- | --- |
| `firebase` (default) | FCM HTTP v1, signed here | `AGENTIZ_FCM_SERVICE_ACCOUNT` |
| `gateway` | `POST {PUSH_GATEWAY_URL}/v1/messages:send` | `PUSH_GATEWAY_URL`, `PUSH_GATEWAY_API_KEY` — **no Firebase credentials at all** |

The gateway itself is a separate service (`push-gateway/` here is a local symlink, not tracked —
the code lives in `/prj/push-gateway`, its own README explains the contract it implements).

The gateway request body is the FCM HTTP v1 body, unchanged: the gateway forwards it, so the
`android` and `apns` blocks reach FCM exactly as they would have from here. Switching provider is a
setting and a restart, nothing else.

Devices are addressed by the transport they registered with, which is a separate axis from the
setting above:

| Device registers | Goes to |
| --- | --- |
| an FCM registration token (Android; iOS built on the Firebase SDK) | whichever provider `PUSH_PROVIDER` names |
| a raw APNs device token (the current iOS app) | `ApnsPushProvider`, always — only Apple can accept that token |

iOS goes to Apple directly rather than through FCM so the app registers its raw APNs token and needs
no Firebase dependency of its own; the message's `apns` block is what that provider sends, and it is
the same block FCM would have applied on the other route.

### Failures

Every provider answers with the same `PushResult`: `{ success: true, messageId }`, or
`{ success: false, reason }` with `reason` one of `invalid-token`, `rate-limited`,
`temporary-error`, `unknown`. Only `invalid-token` is acted on — that row is deleted. The two
retryable reasons are logged as such and *not* retried here: delivery runs inside the worker's
`requestHumanInput` call, so waiting out a rate limit would delay the agent for a notification, and
the next question notifies again. `unknown` covers bad credentials and malformed messages, which a
retry could only repeat.

The payload's job is to be *openable*: `data.type = "interaction"` plus `interactionId`, with
`runId`/`projectId`/`projectName`/`taskId` alongside as context. The app routes on those two keys and
ignores anything else, so adding a second kind of notification later cannot misroute this one.
Notifications of one run share a collapse key, so a chatty stage replaces its own card instead of
stacking.

Device rows are disposable. A provider that reports a token as gone (FCM `UNREGISTERED`, APNs 410)
has that row deleted, and the app registers a fresh token on its next launch. Registering a token
that already exists **moves** it to the registering user — that is what makes signing out on a
shared phone stop the previous user's notifications.

**Push is optional.** With no credentials configured the providers report themselves off, nothing
is sent, and `/devices` still records tokens (answering `pushEnabled: false`), so turning push on
later needs no new app release.

## Embedded Assistant WebView

The mobile application first calls `POST /assistant/webview-session` with its existing bearer token,
then navigates the WebView to the returned `url`. The URL contains a random one-use launch code that
expires after 60 seconds; it is exchanged for an HttpOnly Adminizer cookie and immediately removed
by a redirect. The page renders Adminizer's existing `agent.es.js` UI in fullscreen mode, pointed at
`agentiz-assistant`, so the same streaming transport, history, commands and registered agent skills
are used as in the dashboard.

The user must have the Adminizer permission `ai-assistant-agentiz-assistant`. The mobile JWT, the
Adminizer cookie and the OpenHarness API key are never exposed to page JavaScript.

## Configuration

| Variable                        | Default              | Meaning                                             |
| ------------------------------- | -------------------- | --------------------------------------------------- |
| `AGENTIZ_MOBILE_JWT_SECRET`     | `process.env.SECRET` | HS256 signing secret for mobile tokens.             |
| `AGENTIZ_MOBILE_TOKEN_TTL_SEC`  | `2592000` (30 days)  | Token lifetime in seconds.                          |
| `PUSH_PROVIDER`                 | `firebase`           | `firebase` (send to FCM directly) or `gateway` (forward to a push gateway). |
| `AGENTIZ_FCM_SERVICE_ACCOUNT`   | —                    | Firebase service-account JSON, inline or a path. Enables FCM push. Unused with `PUSH_PROVIDER=gateway`. |
| `PUSH_GATEWAY_URL`              | —                    | Base URL of the push gateway, e.g. `http://push-gateway:3000`. |
| `PUSH_GATEWAY_API_KEY`          | —                    | Bearer key for the gateway. Required with the URL, or the provider stays off. |
| `PUSH_GATEWAY_TIMEOUT_MS`       | `10000`              | Hard timeout on a gateway request — an unreachable gateway must not hold the caller. |
| `AGENTIZ_APNS_KEY`              | —                    | APNs `.p8` private key, inline or a path.           |
| `AGENTIZ_APNS_KEY_ID`           | —                    | Key ID of that `.p8`.                               |
| `AGENTIZ_APNS_TEAM_ID`          | —                    | Apple developer team id.                            |
| `AGENTIZ_APNS_BUNDLE_ID`        | —                    | The app's bundle id, sent as the APNs topic.        |
| `AGENTIZ_APNS_ENV`              | `production`         | `sandbox` for development builds of the app.        |

All four `AGENTIZ_APNS_*` values are required together; a half-configured set logs a warning and
leaves iOS push off rather than failing at send time.

## Example

```http
POST http://localhost:17280/api/agentiz/mobile/v1/auth/login
Content-Type: application/json

{ "login": "admin", "password": "secret" }
```

```http
GET http://localhost:17280/api/agentiz/mobile/v1/projects
Authorization: Bearer <token from /auth/login>
```
