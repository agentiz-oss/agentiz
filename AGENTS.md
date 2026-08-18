# Agentiz development notes

- Documentation index: [`docs/README.md`](docs/README.md).
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
- A stage's `model` (`spec.stages[].model`) overrides the model of the `AgentRole` it names, for
  that stage only — absent falls back to `AgentRole.model`, unchanged from before this field
  existed. It flows through `AgentPipelineService.buildSnapshot` into the job snapshot's
  `stage.agent.model`, and the worker passes it as `ACPAgent(acp_model=...)`
  (`worker/src/agentiz_worker/main.py`): the ACP server applies it to the session after it starts
  (`set_config_option`/`set_session_model`), not via a CLI flag or env var — `claude-agent-acp`
  otherwise falls back to `ANTHROPIC_MODEL`/its own default.
- A new agent question (`AgentRunInteractionService.create`) is announced through the
  `interactionNotifiers` collection (`layers/app-agentiz/lib/interactionNotifiers.ts`) — app-agentiz
  owns the event and contributes no *push* listener, because reaching a phone means device tokens and
  credentials. Today there are two listeners: `MobilePushService` in the mobile-api layer, and
  `DashboardInteractionNotifier` in app-agentiz itself — the second is not an exception to that rule,
  its recipient is a user of the panel app-agentiz already runs inside, so no credential enters the
  core. Delivery is
  fire-and-forget on purpose: it runs inside the worker's `requestHumanInput` call and must never
  delay or fail it — which is also why nothing there retries, only classifies. Push credentials are
  optional everywhere — with none configured nothing is sent and `/devices` still stores tokens.
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
  and a subscription for a harness that machine does not run.
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
  workers, workerDetails, jobs, proposals) and `agentiz-actions` (state-changing: sync, runTask,
  cancelRun, manage, manageWorker, manageProposal), plus more `general` tools (adminizer.user,
  system.listApps, system.toggleApp).
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
