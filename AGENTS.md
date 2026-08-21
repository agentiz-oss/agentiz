# Agentiz development notes

- Documentation index: [`docs/README.md`](docs/README.md).
- Work journal: after finishing a piece of work, write what was done into a file in
  [`docs/journal/`](docs/journal/) (one file per piece of work, name it `YYYY-MM-DD-<slug>.md`):
  what was asked, what was actually changed and where, what was checked and what was left out.
  The directory itself is tracked (via `.gitkeep`), its contents are **git-ignored** — the journal
  is local working memory, not repository documentation. Anything that has to survive for other
  people belongs in `docs/` or in these notes instead.
- Run the server with `npm run dev` (TSX).
- Run `npm run build` after TypeScript changes.
- Local application layers: `layers/app-agentiz` (core), `layers/app-agentiz-gitlab-integration`,
  `layers/app-agentiz-github-integration`, `layers/app-agentiz-mobile-api`.
- Repositories are a **core** concept: `AgentGitConnection` / `AgentRepository` /
  `AgentProjectRepository` live in `app-agentiz`, and a provider layer supplies only the OAuth
  dialect plus a `GitConnectionAuthority` (token renewal + repository mirroring). Do not add
  per-platform repository tables — a repository id has to mean the same thing to the runner
  allowlist, the job snapshot and the stored diff.
- A new layer must be added to `tsconfig.json` **and** `tsconfig.runtime.json` includes — tsx only
  applies `experimentalDecorators` to files matched by the runtime config, otherwise the app fails
  to load with "Decorators are not valid here".
- Layers talk to each other through app-manager collections (`@Collection` / `@CollectionHandler`),
  not direct imports — see `notes/app-layers/` before adding a cross-layer extension point.
- `adminizerMiddlewares` routes are always prefixed with Adminizer's `routePrefix` (`/dashboard`).
  A machine-facing API must be mounted on `this.appManager.app` in `mount()` instead — that is why
  the Worker API lives in `layers/app-agentiz/lib/workerApiRouter.ts`.
- A `PipelineSpec` is an entity of **its** project and never moves: `projectId` is refused on update
  (`@BeforeSave` on the model — the only place all four write paths pass through: MCP `agentiz.manage`,
  Adminizer CRUD, the panel editor, the assistant's `create_model_record`). Its stages already resolve
  `agentRoleKey` among that project's roles only, and `resolveSpecForTask` never looks outside
  `task.projectId`. The half that used to leak was the **directory**: a worker's declared workspace can
  now carry `projectId` (`setWorkspaces`), and then only that project's specs may name it — by
  `workspaceKey` *or* by its path, since a spec rewritten to the bare path would otherwise walk around
  the binding. Checked twice, in `lib/workspaceOwnership.ts`: when the spec is saved, and again in
  `AgentPipelineService.resolveWorkspace` at queue time, because an operator can bind a directory long
  after a spec was written. A declaration without `projectId` stays shared — that is the pre-existing
  behaviour, not an oversight. The reason it matters is the reservation: a workspace proposal is keyed
  by worker+path and knows nothing about projects, so one project's `waiting_review` used to block
  every run of the other project pointed at the same directory.
- Two separate collections own the two halves of "external system": `gitProviders` (where code
  lives) and `taskManagers` (where tasks come from). A project can mix them freely.
- Shared mutable registries must live on a `Symbol.for` global: under tsx a module can be
  instantiated twice (ESM + CJS graphs) and plain module state silently splits in two.
- A pipeline's `spec.source` decides what a run works on: `repository` (default) resolves through a
  git provider, `worker_workspace` runs in a directory on one worker and pins the job to it via
  `AgentRunJob.requiredWorkerId`. The directory is named either by `workspaceKey` (declared ahead of
  time on the worker via `setWorkspaces`, expected to already exist) or by `path` (an absolute path
  given directly in the spec; `createIfMissing` lets the worker create it — see `resolve_workdir` in
  `worker/src/agentiz_worker/main.py`). Exactly one of the two is set — validated in
  `PipelineSpecValidation.ts`, not the JSON schema, since Ajv cannot express "exactly one of".
  Whether a run may `commit`/`push` from that directory is **never** a spec property: the worker
  record carries the grant (`AgentWorker.gitPushRoots` path prefixes, or `git.pushEnabled` on a
  declared workspace, which is also the only way to name a remote other than `origin`). Both forms
  resolve through `lib/workspaceGit.ts`, checked at queue time in `AgentPipelineService`, not in
  `PipelineSpecValidation` — the grant can be withdrawn long after a spec was saved. A hosted
  repository is **not** required for that push: `source.repositoryId` is optional for
  `worker_workspace` + `commit`, and pinning one only adds the check that the checkout's remote still
  matches its `cloneUrl` (`_verify_remote` in `worker/src/agentiz_worker/workspace_git.py`).
  Work already sitting in that directory when a run starts is **not** the agent's, and by default
  the worker stashes it (`source.workspace.stashDirty`, absent = true) instead of refusing to start
  — a file somebody forgot to commit used to stop the whole pipeline, and would otherwise land in
  the run's diff as the agent's own. The sha is reported back as `preexistingStash` and logged on
  the run; `stashDirty: false` restores the refusal for a directory whose contents must not move
  without a human looking first.
  Anything filtering the job queue must be added to **both** claim sites —
  `AgentWorkerApiService.claim()` and `AgentWorkerQueueService.claimLocalJob()` — and as a column,
  not a `snapshot` field: the queue filters in SQL under `FOR UPDATE SKIP LOCKED`, and JSON filtering
  differs between the postgres and sqlite deployments.
- A pipeline's `spec.hooks` runs a bash/node script before the first stage and after the last one,
  in the same directory the agent works in. Values reach a script as `AGENTIZ_*` **environment
  variables**, never substituted into the script text — task titles come from an external tracker,
  so text substitution would make every title a command. The variable catalogue lives in
  `layers/app-agentiz/lib/hookEnv.ts` and is the single source read by the server (builds the
  values), the worker (exports them) and the admin editor (completion and lint); adding a variable
  anywhere else silently splits those three apart.
- The prompt a stage's agent actually receives is assembled on the **worker**,
  `worker/src/agentiz_worker/prompt.py`, out of the job snapshot's `conversation` — the thread the
  server froze at queue time in `AgentPipelineService.conversationForRun` (`primaryPrompt` = the
  comment the run was started from, `messages` = the discussion up to it, `priorRuns` = earlier
  runs' summaries and stage outputs). The trigger comment goes **last** and is named as the current
  instruction, with the task title/description left above it as background: a run started from a
  comment has to continue the task, not redo it. With no `conversation` in the job the text is
  byte-identical to `systemPrompt` + title + description, so old snapshots and role prompts written
  against that shape are unaffected. This was broken from the day the human-comment trigger landed
  until 2026-08-20 — the server wrote the thread into every snapshot and the worker read none of
  it, and the only consumer was the in-process `StubAgentExecutor`, which prod never runs
  (`localWorkerEnabled: false`). Data being present in the snapshot is not evidence that anyone
  reads it, and the worker is a **separate deploy** (`worker-release.yml`, tags `worker`/`worker-v*`).
- Task attachments (files/photos on a task): metadata in `AgentTaskAttachment`, bytes on disk under
  `data/task-attachments` (the volume prod already mounts; `AGENTIZ_ATTACHMENTS_DIR` overrides) —
  all disk access goes through `layers/app-agentiz/lib/taskAttachments.ts`, and the on-disk path is
  built from ids, never from the uploaded name. Upload from the panel is a **raw body** POST to
  `/dashboard/agentiz-tasks/attachments` (query carries `taskId`/`fileName`, one file per request —
  the panel's global parsers only touch JSON/urlencoded, so no multipart dependency), and that
  route must stay **first** in `taskRoutes`: the middleware dispatcher runs every prefix match in
  registration order. The attachment endpoints check the panel session themselves
  (`requirePanelUser`) because the `adminizerMiddlewares` dispatcher runs **before** Adminizer's
  auth policies — the rest of that surface is JSON reads/tracker writes and predates this. To the
  run they travel as metadata only: `buildSnapshot` freezes `task.attachments` (like the
  conversation — a file uploaded later belongs to the next run), the worker downloads bytes through
  the leased `POST /jobs/:jobId/attachments/:attachmentId` (404 = deleted meanwhile ⇒ skip with a
  warning; sha256 mismatch ⇒ fail), lays them out in `<workspace>/<jobId>/task-files/` — **outside**
  the working tree, or they would land in the run's diff and break the next clean-tree preflight —
  and names the directory to hooks as `AGENTIZ_TASK_FILES_DIR` and to the agent as an
  `# Attached files` prompt block (`attachments_block` in `prompt.py`). Docker stages don't get the
  paths: the container has its own tree, and a host path in the prompt would be a lie there. The
  mobile app writes through the **same** helper (`MobileTaskService.addAttachment`, routes under
  `/tasks/:id/attachments` in `mobileApiRouter.ts`), also as a raw body — so a photo from a phone
  and a file from the panel are one thing to the snapshot and to the worker. Scope there is the
  task, like every mobile run endpoint: a foreign attachment id answers 404, never 403.
- A manual launch may overrule the pipeline in three ways, and all three live in one place —
  `AgentRun.executorOverride` (`AgentRunExecutorOverride`), normalized by `normalizeRunOverride` in
  `layers/app-agentiz/lib/harnessCatalog.ts` for every entry point (panel `runTask`, mobile
  `POST /tasks/:id/run`, MCP `agentiz.runTask`): the **runner** (`workerId` + `executorKey`, which
  is also a worker pin — only that machine has that executor installed), the **model**, and the
  **reasoning level** (`low|medium|high|xhigh`, Codex's `reasoning_effort` vocabulary). Model and
  level pin nothing and apply to every stage of the run; a per-stage model still belongs in
  `spec.stages[].model`. Precedence is resolved once, in `buildSnapshot`: launch → stage → role.
  What the dialog offers and what it gets untouched comes from `lib/runOptions.ts`
  (`buildRunOptions`), read by both the panel task detail and mobile `GET /tasks/:id/run-options` —
  the model/level catalogue in `harnessCatalog.ts` is **advisory UI vocabulary**, never a whitelist,
  because the ACP server decides what it accepts and a new model id must not need a server release.
  The level is applied on the **worker** (`reasoning_settings` in `worker/src/agentiz_worker/main.py`),
  differently per harness because it is not an ACP field: codex takes it inside the model id
  (`gpt-5.5/high`, split by openhands-sdk into `reasoning_effort`) and therefore needs a model,
  claude has no such option and gets `MAX_THINKING_TOKENS` in the CLI subprocess's environment —
  set around the stage and restored after it, since stages share the worker process. Anything else
  warns into the run log instead of silently ignoring what a person asked for.
- A stage's `model` (`spec.stages[].model`) overrides the model of the `AgentRole` it names, for
  that stage only — absent falls back to `AgentRole.model`, unchanged from before this field
  existed. It flows through `AgentPipelineService.buildSnapshot` into the job snapshot's
  `stage.agent.model`, and the worker passes it as `ACPAgent(acp_model=...)`
  (`worker/src/agentiz_worker/main.py`): the ACP server applies it to the session after it starts
  (`set_config_option`/`set_session_model`), not via a CLI flag or env var — `claude-agent-acp`
  otherwise falls back to `ANTHROPIC_MODEL`/its own default.
- Every "a person may care" event (a question asked, a review waiting, a run finished, a failed
  push — catalogue in `layers/app-agentiz/lib/notifications/activityTypes.ts`, the single source
  the policy schema, the built-in defaults and the UI hints all derive from) goes through **one
  dispatcher**, `ActivityService.record()`: it always INSERTs an `AgentActivity` feed row first —
  the journal is complete whatever the notification policy says — then resolves the policy once
  and fans out through the `activityNotifiers` collection
  (`layers/app-agentiz/lib/activityNotifiers.ts`). A notifier only declares its *channel*
  (`push`/`dashboard`); the policy check lives in the dispatcher, so a new delivery layer cannot
  forget it. app-agentiz owns the events and contributes no *push* listener, because reaching a
  phone means device tokens and credentials. Today there are two listeners: `MobilePushService` in
  the mobile-api layer, and `DashboardActivityNotifier` in app-agentiz itself — the second is not
  an exception to that rule, its recipient is a user of the panel app-agentiz already runs inside,
  so no credential enters the core. Fan-out is fire-and-forget on purpose: some emitters run
  inside the worker's `requestHumanInput` call and must never delay or fail it — which is also why
  nothing there retries, only classifies; `record()` itself never throws either. Push credentials
  are optional everywhere — with none configured nothing is sent and `/devices` still stores
  tokens. Two emit rules with sharp edges: `run.succeeded/failed/cancelled` comes from an
  `@AfterUpdate` hook on `AgentRun`, so a terminal status must be written through an **instance**
  `run.update()` — a bulk `AgentRun.update({status},{where})` bypasses the hook and the activity
  is never born; proposal events are explicit calls at their four sites instead, because
  auto-approve passes `waiting_review` only in transit and a hook would announce a review that no
  longer exists. `interaction.created` keeps its legacy push payload (`type=interaction`) for
  older app builds; every other type travels as `type=activity`.
- *How* a push travels is chosen once, from `PUSH_PROVIDER`, and never branched on again:
  `MobilePushService` builds one FCM-HTTP-v1-shaped `PushMessage` and sends it through a
  `PushProvider` (`layers/app-agentiz-mobile-api/lib/push/`). `firebase` (default) signs and posts to
  FCM here; `gateway` forwards the identical body to `POST {PUSH_GATEWAY_URL}/v1/messages:send` and
  the backend then holds **no** Firebase credentials. Both platforms travel this one route: iOS
  carries the Firebase SDK and registers an FCM token, so the `apns` block of the message is applied
  by FCM rather than by us. Talking to Apple directly (`ApnsPushProvider`, `AGENTIZ_APNS_*`) was
  removed — with it went tracking which APNs host a token belongs to, which Google now decides per
  token; that is why a TestFlight build and a build run from Xcode both work with no setting to
  match them. `MobileDevice` therefore records no transport at all — one route means the column
  could not differ — and `POST /devices` accepts an older build's `transport` field and ignores it.
  Every provider answers the same `PushResult`, and only `reason: 'invalid-token'` deletes a device
  row.
- Push providers read their configuration through `pushSetting()`
  (`layers/app-agentiz-mobile-api/lib/push/settings.ts`), never `process.env` directly. The values are
  **app-manager settings** — slots declared in the layer's `settings` collection, stored in the
  platform's `settings` table — not a table of this layer's own, so a credential can be installed over
  MCP (`agentiz.managePushSettings`) on a deployment whose `.env` is behind a deploy. Two consequences
  of using that mechanism: `process.env` **wins** over a stored value (`SettingStorage.get` checks it
  first), which is why every read reports its `source` and a shadowed write comes back as a warning
  instead of doing nothing visible; and app-manager logs `Setting saved in database: <key>: <value>`
  on save, from `Setting.beforeSaveHook` in the package — which would put a service account or a
  `.p8` in `logs/app.log` and on stdout, so `lib/push/redactSettingLog.ts` wraps the winston format
  and masks the value of every key `isSecretPushSetting()` names. It wraps both `AppManager.logger`
  as imported *and* the running instance's own class logger: under tsx those are not always the same
  object, and wrapping only the wrong one fails silently. A write validates, then calls
  `resetPushProviders()` — the cached provider pair is what makes a change take effect without a
  restart, and it lives on a `Symbol.for` global for the same reason every other registry here does.
  Stored values are write-only through this layer: `describe()` masks and nothing returns a credential.
- *Which* events reach push/bell is one json app-manager setting, `AGENTIZ_NOTIFY_POLICY`
  (`layers/app-agentiz/lib/notifications/policySettings.ts`, slot + schema generated from
  `activityTypes.ts`; writes via `NotificationPolicyService` / MCP
  `agentiz.manageNotificationPolicy`, mobile `GET/PUT /notification-policy` merges only the
  caller's own entries). Same mechanics as `pushSetting()`: env wins — and shadows the stored
  document **entirely** — every read reports `source`, a shadowed write returns a warning. Not in
  `PipelineSpec.spec` on purpose: a spec snapshots into the run and ships to the worker, and "будить
  ли человека" is the recipient's preference, which must not freeze at queue time. Three scopes,
  resolved per channel from specific to general — `pipelines[specId]` (via `AgentRun.pipelineSpecId`,
  set in `createRun`; `task.pipelineSpecId` is the *latest* run's spec and cannot stand in) →
  `projects[projectId]` → `defaults` → built-in; inside a scope an explicit type entry beats the
  scope's `mute: true`, so "проект замьючен, кроме явно включённого пайплайна" needs no special
  code. `set()` prunes entries whose project/pipeline id no longer exists. The policy filters
  **delivery only**: the `AgentActivity` feed row is written regardless, which is what makes
  "почему не пришло" debuggable (`GET /activities`, per-user seen mark in `AgentActivitySeen`).
- Agentiz sends into Adminizer's own notification subsystem (the bell) through one seam,
  `layers/app-agentiz/lib/notifications/dashboardNotifications.ts`, under its own class `agentiz`
  (permission token `notification-agentiz`, registered by adminizer's base service). Two things about
  that subsystem decide how anything is written into it: `title`/`message` are `STRING(255)`, and the
  shipped bell renders **only** those two — `metadata` is JSON and unlimited but invisible, so it is
  storage for ids and links, never for what a person has to read. Always pass `userId`: an
  unaddressed notification goes to every user holding the permission. The whole thing is off unless
  `notifications.enabled` is set in `config/adminizer.ts` (env `ADMINIZER_NOTIFICATIONS`), and the
  seam is a silent no-op when it is — callers never check.
- A run's log is written from two places and read from one. The worker posts milestones
  (`workspace.*`, `stage.started/completed`, `hook.*`) inline, but everything the agent produces
  *while* a stage runs (`stage.tool`, `level: debug`) goes through `LiveEventStream`
  (`worker/src/agentiz_worker/live_events.py`): `ACPAgent` invokes its event callback synchronously
  on the ACP portal thread, so a blocking POST from there stalls the agent's turn. Both threads take
  their `sequence` from one lock-guarded `SequenceCounter`, and every terminal POST is preceded by
  `flush()` — a log line arriving after the run's result reads as garbage. On the read side
  **everything** goes through `listRunLogs` (`layers/app-agentiz/lib/runLogs.ts`): the dashboard,
  the mobile API, the task screen and `agentiz.runDetails`. Its first page is the **tail**, keyed by
  `(createdAt, id)` — a run streaming its tool calls outgrows any fixed limit, and a reader taking
  "the first N" stops showing new lines exactly on the run somebody is watching.
- Harness limits and queue scheduling (design: `.ai-notes/harness-limits-and-scheduling.md`): a
  usage limit belongs to an **account**, so the core models it as `AgentHarnessSubscription`
  (+ `AgentWorkerHarness` binding per worker × harness, + `AgentHarnessUsageSample` history).
  `subscription.exhaustedUntil` is the **only** field that closes the claim gate; `windows` is
  advisory telemetry that reaches enforcement solely through `stopPolicy` thresholds or a
  classified refusal — both applied in `AgentCapacityService`, the single write point (samples,
  cache invalidation, waking deferred jobs on recovery). Provider specifics (refusal wordings,
  usage-report shapes) never enter the core: they come through the `harnessLimitProviders`
  collection — `layers/app-agentiz-claude-limits` is the first provider — and with an empty
  collection everything still works manually (`agentiz.manageWorker markHarnessExhausted` /
  `clearHarnessLimit`). Both claim sites now delegate to `AgentJobClaimService.claim()` — a new
  queue filter goes **there** (still as a SQL column, never JSON), not into two hand-kept WHEREs;
  the same service enforces `AgentWorker.maxConcurrentJobs` under a `FOR UPDATE` of the worker
  row. A failed pipeline result whose error text a provider classifies as a limit is **deferred,
  not failed**: job → `released` + `deferReason` with the claim's `attempt` increment refunded
  (deferrals have their own budget, `AGENTIZ_JOB_MAX_DEFERRALS`), run keeps its status and only
  carries `waitingReason`/`waitingUntil` (deliberately not a new status ENUM value), and a pinned
  job's `availableAt` is the actual reset time while an unpinned one retries in minutes on another
  worker. `AgentRunJob.harnessKey` is derived only in `lib/harness.ts` ('mixed' in the column ⇒
  exact list in `snapshot.harnessKeys`); git-only jobs stay NULL and are never limit-gated.
  Working hours live in `spec.constraints.activeHours` (start-only enforcement; `pause` needs a
  worker release and is rejected by validation) and in `AgentWorker.activeHours` — the first is a
  job property and lands in `availableAt`, the second is a claim-side gate and must never touch
  `availableAt`.
- Daily reset alignment (`AgentHarnessSubscription.alignReset*`, logic in `lib/harnessAlign.ts`) is
  **best-effort discipline over when a session window opens**, never enforcement: it reads the same
  advisory `windows` telemetry the UI shows, does nothing when telemetry is stale or absent, and
  never touches `exhaustedUntil`. Two arms, both derived from the next anchor `A`, window length
  `W` and tolerance `T` (±1h, `ALIGN_TOLERANCE_MS`): a claim-side `hold` in `(A−2W+T, A−W−T)`
  (added to `gatedHarnessKeys()`, like `activeHours` it must never touch `availableAt` — the first
  claim after the hold opens a window whose reset lands within `A±T` by itself), and a `poke` in
  `[A−W, A)` that rides the **response** of `POST /harness-usage` as `openWindow` — decided on
  telemetry that very report refreshed, executed by the worker as a one-word `claude -p`
  (throttled, re-reports immediately so the server stops asking). The tolerance is the accepted
  trade: under continuous load the reset lands within ±1h of the anchor and the daily pause costs
  up to ~`W−2T` (≈3h — 24h does not divide evenly by 5h, so some gap is mathematically
  unavoidable); an idle night still ends in a poke at exactly `A−W` and a reset at the anchor to
  the minute.
- Usage telemetry is **pushed, never pulled**: the numbers live behind a credential on the worker
  machine (Claude's OAuth token), so `claudeLimitProvider` declares no `refresh()` and the server's
  refresh cycle is a no-op with only that provider registered. The worker reports every 120s from
  `worker/src/agentiz_worker/harness_usage.py` (`POST /harness-usage`, deliberately outside any job
  lease — a spent subscription is exactly the state in which the worker holds no job), sending its
  collector's payload **verbatim**: window names and field spellings are provider vocabulary and are
  decoded only by `interpretReport` in the provider layer. Both external transports — that endpoint
  and `agentiz.reportHarnessUsage` — enter through `AgentCapacityService.applyReport()`, so a report
  shape is understood in one place; `applySnapshot` stays the single write point behind it. A
  collector returning nothing sends nothing on purpose: an empty report would auto-create a binding
  and a subscription for a harness that machine does not run. The Claude collector **renews the
  OAuth token itself** when it has expired, writing back to the store the CLI owns — the CLI only
  refreshes when it is about to call the API, so without this the numbers would freeze exactly
  while the machine is idle. That write is a compare-and-swap plus an atomic replace, and it must
  persist a **rotated** refresh token or the CLI is logged out (`AGENTIZ_CLAUDE_TOKEN_REFRESH=0`
  disables it).
- The admin assistant's dialogs live in a table, `AgentAssistantConversation`
  (`agentiz_assistant_conversations`, keyed by `agentId` + `userId`), not in the service: a deploy
  used to end every conversation and drop the model's context mid-dialog. Adminizer reads the
  dialog list through a **synchronous** contract (its `AbstractAiConversationHistoryService` —
  `list`/`getActive`/`create`/`select`/`remove`/`saveActive` all return values, not promises), which
  a table cannot answer, so `lib/ai/assistantConversationHistory.ts` is a cache in front of it:
  `AppAgentiz.mount()` awaits `loadConversations()` **before** the model is registered (a read from
  a cold cache would answer "no history" and open a second dialog beside the stored one), reads are
  served from memory and writes go through one serialized queue behind them. The table is the
  source of truth — `getSession` fills a fresh openharness `Session` from the active dialog, so the
  history comes back even on the pinned adminizer build.7, whose panel has no conversation
  endpoints at all and never calls any of that contract. Two rules keep the queue from becoming a
  write amplifier: a dialog with no messages is never inserted (opening the panel must not leave a
  row per visit), and a save whose payload hashes to what was last stored is skipped — adminizer
  re-saves the active dialog on every poll and once more after each turn. Inlined images are stored
  as a placeholder text part instead of their base64: whole messages are never dropped to save
  space, because that can separate a tool call from its result and the provider then rejects the
  restored dialog.
- A workflow reacts to Agentiz through **one** seam: `layers/app-agentiz/lib/workflow/`. Task facts
  reach the engine as app-manager emitter events (`agentiz.task.created` / `agentiz.task.updated`),
  emitted from `@AfterCreate`/`@AfterUpdate` hooks on `AgentTask` rather than from the four places
  that create tasks — and `task.updated` watches `title`/`description`/`tags` only, because a run
  moves `status` constantly and a flow that starts pipelines would otherwise feed itself. Declaring
  the event class (`@Collection events`) is what puts it in the canvas dropdown; emitting is
  separate from declaring. The three node types (`agentiz.task.trigger` / `.match` / `.run`) go out
  through the `workflowNodes` collection with **type-only** imports of `@nodeknit/app-workflow`, so
  the engine being absent or disabled costs app-agentiz nothing. Graphs are stored by this layer
  (`AgentWorkflowSpec`) and so is run state (`AgentWorkflowRun`, `workflowStores`) — the second is
  not optional once a node waits: `agentiz.pipeline` parks a flow in `waiting_external` for the
  whole length of a pipeline, and the engine's in-memory default would lose it on the next deploy.
  Waiting and not waiting are **two node types** (`agentiz.pipeline` vs `agentiz.task.run`), because
  the engine dispatches on a node's `kind` and a kind cannot depend on config. The continuation is
  an `@AfterUpdate` hook on `AgentRun` → `completePipelineWait` (`lib/workflow/engineBridge.ts`,
  ref `run:<id>`), separate from the activity hook next to it so a workflow never waits behind push
  fan-out; a failed pipeline takes the node's `failed` port rather than failing the flow. That
  bridge and the MCP tools (`agentiz.workflows` / `workflowDetails` / `workflowSchema` /
  `manageWorkflow` / `fireWorkflowTrigger` / `cancelWorkflowRun`, all thin wrappers over the same
  `WorkflowAdminApi` the canvas uses) are the only two places that reach *into* the engine at
  runtime; everything else is data through collections. There is deliberately no "run this
  workflow" verb — a flow runs because a trigger fired, and the manual gesture names one trigger
  node. Two things a list-shaped node config must respect: the canvas drops the whole config to a
  JSON textarea if any schema property is an array (hence comma-separated strings), and a trigger
  binder must be idempotent per `listenerKey` — the engine can rebind twice concurrently on
  startup, which would otherwise run the flow twice for one task.
- A migration file under `layers/app-agentiz/migrations/umzug/` does nothing until it is also listed
  in `migrations/umzugExports.ts` — that hand-written array, not the directory, is what runs.
- Keep documentation specific to Agentiz in `notes/` (a local symlink, not tracked).
- Do not commit or publish changes unless explicitly requested.

## Debugging a run that "starts but nothing happens"

The full ship-and-verify loop lives in [`docs/deploy-debug-guide.md`](docs/deploy-debug-guide.md);
this is the triage that comes before it. Symptom: a run appears, no agent output ever shows up.
Read the run's own log first — it names the layer that gave up, and there are only four places it
can be. `agentiz.runDetails` is read-only and safe to call as often as needed:

```bash
source .env
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d '{"limit":10}' https://agentiz.m42.cx/mcp/call/agentiz.runs
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d '{"runId":"<id>"}' https://agentiz.m42.cx/mcp/call/agentiz.runDetails
```

The log lines are the checkpoints; the **last one present** tells you who failed:

| Last log line | Reached | Read next |
| --- | --- | --- |
| `Run created from spec ...` | server built the run, never queued a job | `AgentPipelineService.buildSnapshot` — spec/role/repository resolution |
| `Worker job queued` | job is in the queue, unclaimed | claim filters: `AgentWorkerApiService.claim()` **and** `AgentWorkerQueueService.claimLocalJob()`, plus the worker's `status`/`contactState`/`allowed*`/`requiredWorkerId` |
| `Worker job claimed by <worker>` | worker took it, died before reporting | worker-side preflight — `worker/src/agentiz_worker/main.py`, `workspace_git.py` |
| a `job.*` event (e.g. `Работа идёт в готовой папке воркера: ...`) | worker is executing | the executor/ACP session |

A run whose `stages[]` are all still `pending` while the run itself is `failed` never reached an
agent — the error is infrastructure, not the agent's output. `run.errorMessage` equals the job's
`lastError` in that case, so `agentiz.jobs` adds nothing; grep the string in the repo (`--include=*.ts
--include=*.py`, the worker is Python and easy to forget) to find the exact `throw`/`raise`.

### The worker-side preflight ladder

`workspace_git.preflight()` (`worker/src/agentiz_worker/workspace_git.py`) is where a
`worker_workspace` run dies before its first stage, and it fails one check at a time — fixing one
reveals the next, so expect several round trips rather than one root cause. In order: `rev-parse
--show-toplevel` (git must accept the checkout), a clean tree **including untracked files** when no
marker exists yet, `symbolic-ref HEAD` (no detached HEAD), `_verify_remote`, then `ls-remote` — local
`HEAD` must equal the remote branch head, which means the worker needs working push-side credentials
just to *start*, not only to push.

Reproduce each check as the **worker's** user, not yours — the worker is a separate install with its
own `HOME`, so per-user git config and SSH identities differ from the shell you are typing in
(`ps -eo user,pid,cmd | grep agentiz_worker` gives the user; the install lives under
`~<user>/.local/share/agentiz-worker`, config in `~<user>/.config/agentiz/worker.json`):

```bash
sudo -u <worker-user> git -C <workspace> rev-parse --show-toplevel     # dubious ownership?
sudo -u <worker-user> git -C <workspace> status --porcelain=v1 -uall   # must be empty
sudo -u <worker-user> git -C <workspace> ls-remote --heads origin      # credentials reachable?
sudo -u <worker-user> git config --global --list --show-origin | grep safe.directory
```

`detected dubious ownership` means `.git` is owned by a different user than the worker runs as — check
`.git` itself, not just the workspace directory; they can differ when a human created the checkout and
the worker inherited it. The host convention here is a `safe.directory` entry in the **worker user's**
`~/.gitconfig` (verify with `--show-origin`; `sudo -u` alone does not guarantee the `HOME` you assume).
A `sudo -u` shell also has no ssh-agent socket, so a `Permission denied (publickey)` from that command
is not proof the worker itself lacks access — settle it against the socket the running process actually
holds (here: a gpg-agent one, and it turned out to hold no identities at all):

```bash
sudo -u <worker-user> bash -c 'tr "\0" "\n" < /proc/<worker-pid>/environ | grep SSH_AUTH_SOCK'
sudo -u <worker-user> bash -c 'export SSH_AUTH_SOCK=<that socket>; ssh-add -l; ssh -o BatchMode=yes -T git@<host>'
```

A dirty workspace is not necessarily junk: a run that succeeded while git delivery was broken leaves
its whole output uncommitted there. Read `agentiz.runs` for the last `succeeded` run on that path
before cleaning anything.

### A workspace still held by an earlier proposal

`Workspace is reserved by proposal <id>` (no workspace name in the text — the quoted variant comes
from the server, this one from the worker's on-disk marker) names a proposal from a **previous** run
on that directory, never the run you are reading: that run's own proposal is already `rejected`,
which is why the message reads as though a resolved proposal were blocking. Find the actual holder
and release it, both through MCP:

```bash
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d '{"holding":true}' https://agentiz.m42.cx/mcp/call/agentiz.proposals
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d '{"action":"reject","proposalId":"<id>"}' https://agentiz.m42.cx/mcp/call/agentiz.manageProposal
```

`reject` queues `workspace_reset` on the owning worker; the reservation and the marker are dropped
only when that job reports success, so watch `agentiz.jobs`. `approvable:false` in the listing means
approve is closed for good on that revision — a run that failed before changing anything leaves an
empty diff, and reject is then the only exit.

`reject` is a *review* decision and answers 409 in every status where nobody is reviewing anything
(`working`, `continuing`, `apply_queued`, `reset_queued`) — which is exactly where a cancelled run
or a dead worker leaves a proposal that still holds its directory. `release` is the exit from those:

```bash
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d '{"action":"release","proposalId":"<id>"}' https://agentiz.m42.cx/mcp/call/agentiz.manageProposal
```

It stops whatever is still queued and queues the same reset, so the reservation still falls away
with the worker's report — `force: true` skips the worker entirely and drops the reservation now,
which is only right when that machine is not coming back: the files stay exactly as they were and
the next run there fails on a workspace that is not clean until somebody cleans it. The same two
buttons sit on the run screen under the proposal card, and a *safe* release is refused while a
worker still holds a live lease on the directory (the job is asked to stop; retry once it has).

None of this destroys work, which is what makes it safe to do automatically: `workspace_reset`
**stashes** the directory (`git stash push -u`, plus `refs/agentiz/abandoned/<proposalId>` when the
agent had committed) before restoring it to the base. The receipt lands on the proposal as
`stashSha`/`abandonedRef` and in the run log — the stash *commit*, not `stash@{0}`, because the
positional name shifts under the next stash. That is also why cancelling a run now settles its
proposal instead of leaving it in `working`: `cancelRun` releases it whenever it terminates the run
itself, and leaves it alone when the worker is still executing and will report anyway.

Two invariants hold the whole thing up, and both are easy to break by adding an innocent-looking
check:

1. **A `workspace_reset` must never be refusable.** A reset that cannot run is a reservation that
   cannot be released, and every refusal added to that path is a new way to wedge a directory with
   `force` as the only exit. So `run_action` asks `job_kind == "workspace_reset"` before every
   check it inherited from the push path: a missing or foreign marker answers *success* ("this
   proposal no longer holds the directory"), an unreadable marker, a moved remote, a base that
   drifted from the database and a tree that changed after review are all ignored, and the reset
   targets the **marker's** base rather than the proposal's — the marker is what this checkout
   actually started from. Nothing is lost by being permissive here, because the stash happens
   first.
2. **The stash is always nameable from the server.** `workspaceStashLabel()` in
   `lib/workspaceGit.ts` spells the same string as `_stash_workspace` in the worker, from data the
   server already holds, so even the one case that produces no sha — `force`, which by definition
   has no worker — records the label the stash will get, and a person can find it with `git stash
   list`. The sha arrives later anyway: the next pipeline run on that directory is what stashes a
   force-released leftover (`staleMarkerAllowed`), and it reports `recoveredStash` back, which
   `AgentWorkerApiService.recordRecoveredStash` files under the proposal it belonged to — on the
   failure path too, since whether *that* run worked has nothing to do with the work it found.

Reaching one of those statuses is not supposed to need a human at all: `AgentJobReaperService`
sweeps them. A proposal left `working` after its run ended gets the reset queued for it, and a
decision whose action job no worker ever claimed (`attempt` still 0 —  the lease machinery never
sees it) reopens as `push_failed`/`reset_failed` after `AGENTIZ_PROPOSAL_ACTION_TIMEOUT_MS`
(15 min). Neither arm ever clears `reservationKey` itself: the worker's on-disk marker outlives the
row, so an automatic release would trade this block for a less legible one. The counterpart on the
worker is `staleMarkerAllowed` in the job snapshot — set when the reservation table shows nobody
holding the path, which is what lets a force-released directory drop the marker its proposal never
got to remove.

Before debugging code, check that prod is actually running the code you're reading — these drift
independently and a fix pushed after the failed run explains the failure without any bug:

```bash
curl -s -H "X-Mcp-Key: $MCP_KEY" -d '{}' https://agentiz.m42.cx/mcp/call/agentiz.overview   # server.gitSha / buildTime
curl -s -H "X-Mcp-Key: $MCP_KEY" -d '{}' https://agentiz.m42.cx/mcp/call/agentiz.workers    # items[].version = agentiz-worker/<v>+<sha>
```

Compare both against `git log`, and compare `buildTime` against the run's `createdAt`. If the error
string is absent from the working tree, `git log -S'<error text>'` dates its removal — that is the
commit that has to be deployed, and the worker is a **separate** deploy from the server. Only after
both SHAs match the code you're reading is a re-run (`agentiz-actions.runTask`) evidence of anything.

A prod SHA that lags the branch you're on usually means **no build was ever triggered**, not a broken
one — check that before reading CI logs for a failure that does not exist:

```bash
gh run list --branch "$(git branch --show-current)" --limit 5   # empty output = never built
gh pr list --state all --limit 5
```

`.github/workflows/container.yml` (the server image) fires only on push to `main`/`master`, on `v*`
tags, on `pull_request` and on `workflow_dispatch`; `worker-release.yml` only on the `worker` /
`worker-v*` tags. A feature branch with no PR therefore produces no run at all, and prod keeps
serving the last `main` build — consistent, just old. Ways forward: `gh pr create --fill` (runs the
checks, publishes no branch image), `gh workflow run container.yml --ref <branch>`, or merge to
`main`. The worker is a separate deploy either way.

## Calling the Agentiz MCP endpoint

- Base URL: `https://agentiz.m42.cx/mcp`. Auth via header `X-Mcp-Key: <MCP_KEY>` (or query param
  `mcp_key=...`) — the key lives in `.env` as `MCP_KEY` (`MCP_ADMIN_KEY` is a separate key and did
  not authenticate against this endpoint). Never hardcode the key value in tracked files; read it
  from `.env` at call time.
- `GET /mcp` returns the compact tool catalogue (groups + tool list). Without a valid key it only
  shows the public `general` group (just `health`). With a valid key it also shows `agentiz`
  (read-only: overview, projects, tasks, runs, runDetails, configuration, pipelineSpecSchema,
  workers, workerDetails, jobs, proposals, workflows, workflowDetails, workflowSchema) and
  `agentiz-actions` (state-changing: sync, runTask, cancelRun, manage, manageWorker,
  manageProposal, manageWorkflow, fireWorkflowTrigger, cancelWorkflowRun), plus more `general`
  tools (adminizer.user, system.listApps, system.toggleApp).
- `PipelineSpec.spec` is validated against `layers/app-agentiz/schemas/pipeline-spec.schema.json`.
  Anything writing a spec — the MCP `agentiz.manage` tool, Adminizer's generic CRUD, the admin
  assistant's `create_model_record` skill — reads that shape through `agentiz.pipelineSpecSchema`,
  which also returns the project's role keys and worker workspaces. Rejections carry the failing
  fields and that tool name in `error.message`, because those callers surface nothing else.
- `GET /mcp/group/:group` returns full schemas for one group.
- `POST /mcp/call/:toolName` calls a tool with a JSON body.
- Example:
  ```bash
  source .env
  curl -s -H "X-Mcp-Key: $MCP_KEY" https://agentiz.m42.cx/mcp
  ```
- The auth status has appeared as `unauthenticated` on a first request and `authenticated` on an
  immediate retry with the same key — treat a stale/cached-looking `unauthenticated` response as
  worth one retry before assuming the key is wrong.

## Signing in to the admin UI (Playwright)

- Driving the Adminizer dashboard (`/dashboard`) through Playwright needs a login. The credentials
  live in `.env` as `ADMIN_CREDS`, in `login:password` form — read them from there at call time
  (`source .env`), same rule as `MCP_KEY`: never hardcode the value in a tracked file.
