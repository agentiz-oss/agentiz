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
| POST   | `/tasks/:taskId/runs/:runId/apply` | Bearer JWT | Applies a diff `requireApproval` held back. |
| GET    | `/interactions`  | Bearer JWT  | Questions agents are waiting on, across all owned projects. |
| GET    | `/interactions/:id` | Bearer JWT | One question by id — what a tapped notification opens. |
| POST   | `/interactions/:id/answer` | Bearer JWT | `{ action, content }` — answers one question.   |
| GET    | `/tasks/:id/attachments` | Bearer JWT | Files attached to a task (metadata only).       |
| POST   | `/tasks/:id/attachments?fileName=` | Bearer JWT | Uploads one file as a **raw body**.   |
| GET    | `/tasks/:id/attachments/:attachmentId` | Bearer JWT | The bytes, streamed.          |
| DELETE | `/tasks/:id/attachments/:attachmentId` | Bearer JWT | Removes row and bytes.        |
| GET    | `/activities`    | Bearer JWT  | The journal, newest first, paged by an opaque `before` cursor. |
| POST   | `/activities/seen` | Bearer JWT | Moves the per-user "seen" mark the unseen badge counts against. |
| GET    | `/activities/summary` | Bearer JWT | Everything waiting on a person (`items`) plus the unseen counter. |
| GET    | `/proposals`     | Bearer JWT  | Workspace proposals of the caller's projects.        |
| POST   | `/proposals/:id/approve` | Bearer JWT | Commits and pushes one reviewed revision.     |
| POST   | `/proposals/:id/reject` | Bearer JWT | Rejects it and resets the workspace.           |
| POST   | `/devices`       | Bearer JWT  | Registers this install's push token (idempotent).   |
| DELETE | `/devices[/:token]` | Bearer JWT | Forgets a push token — what signing out calls.    |
| POST   | `/assistant/webview-session` | Bearer JWT | Creates a one-use URL for the embedded Assistant WebView. |

`login` accepts whatever identifier the UserAP model stores (`login`, `email`, or `username`).
Project scope mirrors the admin panel's `userAccessRelation: 'owner'`: a user sees only the projects
whose `ownerId` is theirs. A project with no owner set is visible to nobody through this API.

## Task attachments

A photo from the camera roll, a log, a spec — whatever the agent has to look at. Uploads are a
**raw body** POST, one file per request, with the name in the query string:

```
POST /tasks/<id>/attachments?fileName=%D1%84%D0%BE%D1%82%D0%BE.png
Content-Type: image/png
<bytes>
```

Not multipart on purpose: the router's `express.json` only engages on a JSON content type, so the
stream arrives untouched and neither side needs a multipart parser. One file per request is also
what gives the app per-file progress and a per-file failure — on a phone connection the common case
is one photo of five timing out, not all five.

Everything is scoped through the task, like the run endpoints: an attachment id that belongs to
another project's task answers **404**, never 403. The bytes and the row live where the admin panel
puts them (`app-agentiz/lib/taskAttachments.ts`, `data/task-attachments`), so a file attached from
the phone and one attached from the dashboard are the same thing — including how they reach a run:
`buildSnapshot` freezes the list into the job, and the worker downloads them into
`<workspace>/<jobId>/task-files/` before the first stage. A file uploaded after a run was queued
belongs to the next run, by design.

Limits are the storage helper's, not this layer's: 25 MB per file (`AGENTIZ_ATTACHMENT_MAX_BYTES`)
and 100 attachments per task. Both answer 413/400 with a message the app shows verbatim.

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

## The inbox: one shape for everything waiting on a person

`GET /activities/summary` answers two different questions in one payload. `unseen` counts the
journal rows newer than the caller's seen mark — the badge on the feed. `items` is the inbox: every
live thing that needs a decision, in one shape, already sorted.

```jsonc
{
  "id": "proposal:01J…",          // stable, unique across kinds — the client's list key
  "kind": "review",               // question | review | no_changes | push_failed | reset_failed
                                  //  | held_diff | run_failed | pr
  "activityType": "proposal.waiting_review",
  "badge": "ревью",               // spelled by app-agentiz/lib/notifications/activityTypes.ts
  "headline": "Обновить зависимости",
  "facts": "3 файл(ов) · +48/−12 · ветка main · ревизия 2",
  "explain": "Изменения лежат в папке воркера … «Одобрить» — закоммитить их и запушить …",
  "projectId": "…", "projectName": "…", "taskId": "…", "taskTitle": "…", "runId": "…",
  "proposalId": "…", "revision": 2, "interactionId": null, "url": null,
  "waitingSince": "2026-08-22T11:02:00.000Z", "expiresAt": null,
  "priority": 2,
  "actions": [{ "key": "approve", "label": "Одобрить…", "style": "primary" }, …]
}
```

Three rules hold it together, and breaking any of them puts the client back to guessing:

- **The server spells everything a person reads.** `badge` comes from the activity catalogue — the
  same file the notification policy schema is generated from — and `label` and `explain` from the
  item builder (`lib/inboxItems.ts`). A client that invents its own words for "ревью" ends up with a
  chip that means nothing in particular. `explain` is the sentence that turns a state into a
  choice — what happened and what each button will do about it; without it "ревью · 0 файлов ·
  [Отклонить]" is a state machine, not a decision anybody can make.
- **`facts` are facts, never the agent's prose.** Files and line counts, a branch, a revision, the
  first line of an error. The first sentence of a run's output reads like an explanation and is not
  one.
- **`actions` name existing endpoints, not new ones.** `answer` → `POST /interactions/:id/answer`,
  `approve`/`reject` → `POST /proposals/:id/…`, `rerun` → `POST /tasks/:id/run`, `apply_diff` →
  `POST /tasks/:taskId/runs/:runId/apply`, and `open_run`/`open_url` are navigation. The inbox is a
  projection for reading; nothing is written through it.
- **Blocking rows and reminders are different things.** A row that *holds* something — a parked
  agent, a reserved worker directory, a diff waiting to be applied — must be resolvable from the
  phone (that is why `held_diff` got `/apply`), is counted by `actionableCount` and the app badge,
  and never goes away by itself. A reminder — `pr`, `run_failed` — holds nothing, is resolved by
  nobody, so it is shown but **not counted**, and it sinks instead of expiring: inside their group
  reminders sort newest-first, so an old one leaves the top of the list because newer ones arrive,
  not because a timer hid it. There is deliberately no expiry rule and no "закрыть задачу" action:
  closing a task that simply is not done any more would be a lie, and in a synced tracker it would
  be a lie other people read.
- **Degenerate states are named, not papered over.** `no_changes` is a review of a run that changed
  no file (approve is closed for good, and all that is left is that the worker's directory is still
  reserved); `run_failed` is a task whose last attempt died, one row per task rather than per
  attempt, keyed off `AgentTask.status = 'failed'` — a re-run clears it by itself.

Ordering is `priority` then time: a question first (an agent is parked mid-turn), then everything
holding a worker's directory (a failed push or reset, a review nobody can approve), then reviews
and held diffs, and finally the two reminders — a dead run and an opened pull request. Inside a
group the direction of time depends on the kind: a blocking row sorts oldest-first (the one ignored
longest has to climb), a reminder newest-first (it is never resolved, only superseded).

The same projection answers two narrower questions: `GET /tasks/:id` returns `actionRequired` for
one task, and `GET /tasks/:taskId/runs/:runId` returns it for one run — that is what the run screen
prints above everything the run produced. At run scope `open_run` is stripped from the actions: the
reader is already there.

`interactions`, `proposals` and `heldRuns` are the same facts in the shape older builds parse and
are still filled. `actionableCount` is the **blocking** part of `items`; `MobileActivityService.badgeCount` is that
same part minus whatever the notification policy mutes for push in its project.

A pull request is the one kind whose resolution happens outside Agentiz — nothing here learns that
it was merged. Its stand-in is the task: an open task keeps the row, a `done`/`cancelled`/`ignored`
one drops it. The same is true of `run_failed`, and it is why neither is counted.

The same projection, scoped to one task, is `actionRequired` in `GET /tasks/:id` — what the task
screen states above everything else instead of leaving "ждёт ревью" to be deduced from a run's page.
A run additionally carries `instruction` (`{ source: comment | description, body, authorName,
createdAt }`): the comment the run was triggered from, resolved through `AgentRun.triggerCommentId`,
or the task's description. A task named "выполни" says nothing on its own, and the agent's answer is
unreadable without the question.

## Push notifications

A question nobody sees is a run that stays parked, so feed events — a new question, a review
waiting, a failed push, a finished run — are pushed to the project owner's phones as they happen.
The core layer owns the events and knows nothing about devices: `ActivityService` writes the
`AgentActivity` feed row, applies the notification policy (`AGENTIZ_NOTIFY_POLICY`) and fans out
through the `activityNotifiers` app-manager collection
(`app-agentiz/lib/activityNotifiers.ts`); this layer contributes `MobilePushService` on the
`push` channel. Delivery is fire-and-forget — a push that fails must never fail the agent's
request. `interaction.created` keeps the legacy `type=interaction` payload so older builds still
deep-route questions; every other type travels as `type=activity`.

The phone is not the only listener: app-agentiz sends the same events to Adminizer's notification
bell (`app-agentiz/lib/notifications/`), so they are visible to somebody watching the dashboard
with no app installed. The two channels are independent — one being off changes nothing about the
other, and the feed (`GET /activities`) is written whatever the policy silences.

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

Every push variable below is also an app-manager setting, so it can be set at runtime through the
MCP tools `agentiz.pushSettings` (what is set, and whether it came from the environment or the
settings table) and `agentiz.managePushSettings` (set it; `null` removes it and falls back to the
variable). A change takes effect on the next notification — the provider pair is rebuilt, not the
process. Values are validated before being stored, and credentials are write-only here: nothing
reads them back. That is what makes installing a Firebase service account possible on a deployment
whose `.env` is behind a deploy.

The environment keeps priority, because that is app-manager's rule: a variable present in `.env`
shadows the stored value, which every read reports per setting (`shadowedByEnvironment`) rather than
leaving it to be discovered.

| Variable                        | Default              | Meaning                                             |
| ------------------------------- | -------------------- | --------------------------------------------------- |
| `AGENTIZ_MOBILE_JWT_SECRET`     | `process.env.SECRET` | HS256 signing secret for mobile tokens.             |
| `AGENTIZ_MOBILE_TOKEN_TTL_SEC`  | `2592000` (30 days)  | Token lifetime in seconds.                          |
| `PUSH_PROVIDER`                 | `firebase`           | `firebase` (send to FCM directly) or `gateway` (forward to a push gateway). |
| `AGENTIZ_FCM_SERVICE_ACCOUNT`   | —                    | Firebase service-account JSON, inline or a path. Enables FCM push. Unused with `PUSH_PROVIDER=gateway`. |
| `PUSH_GATEWAY_URL`              | —                    | Base URL of the push gateway, e.g. `http://push-gateway:3000`. |
| `PUSH_GATEWAY_API_KEY`          | —                    | Bearer key for the gateway. Required with the URL, or the provider stays off. |
| `PUSH_GATEWAY_TIMEOUT_MS`       | `10000`              | Hard timeout on a gateway request — an unreachable gateway must not hold the caller. |

iOS has no variables of its own. Both platforms register FCM tokens, so the APNs `.p8` is uploaded to
the Firebase console rather than to this server, and which of Apple's two hosts a token belongs to is
Google's decision — a TestFlight build and one run from Xcode both work with nothing to match them.

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
