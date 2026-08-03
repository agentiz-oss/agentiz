# app-agentiz-mobile-api

Machine-facing JSON API for the Agentiz mobile client. It does two things: exchange an Adminizer
admin login (`UserAP`) for a JWT bearer token, and serve the projects that token's user owns.

It owns no models and no admin pages — it reuses `UserAP` (app-adminizer) and `AgentProject`
(app-agentiz). Like the Worker API, it is mounted on the **root** Express app, outside Adminizer's
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
| GET    | `/tasks/:id/runs` | Bearer JWT | Compact history of a task's pipeline runs.            |
| GET    | `/tasks/:taskId/runs/:runId` | Bearer JWT | Full result, stages and log of one run.       |
| POST   | `/tasks/:taskId/runs/:runId/cancel` | Bearer JWT | Requests cancellation of a run.             |
| POST   | `/assistant/webview-session` | Bearer JWT | Creates a one-use URL for the embedded Assistant WebView. |

`login` accepts whatever identifier the UserAP model stores (`login`, `email`, or `username`).
Project scope mirrors the admin panel's `userAccessRelation: 'owner'`: a user sees only the projects
whose `ownerId` is theirs. A project with no owner set is visible to nobody through this API.

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
