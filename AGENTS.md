# Agentiz development notes

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
  git provider, `worker_workspace` runs in a directory declared on one worker and pins the job to it
  via `AgentRunJob.requiredWorkerId`. Anything filtering the job queue must be added to **both**
  claim sites — `AgentWorkerApiService.claim()` and `AgentWorkerQueueService.claimLocalJob()` — and
  as a column, not a `snapshot` field: the queue filters in SQL under `FOR UPDATE SKIP LOCKED`, and
  JSON filtering differs between the postgres and sqlite deployments.
- A pipeline's `spec.hooks` runs a bash/node script before the first stage and after the last one,
  in the same directory the agent works in. Values reach a script as `AGENTIZ_*` **environment
  variables**, never substituted into the script text — task titles come from an external tracker,
  so text substitution would make every title a command. The variable catalogue lives in
  `layers/app-agentiz/lib/hookEnv.ts` and is the single source read by the server (builds the
  values), the worker (exports them) and the admin editor (completion and lint); adding a variable
  anywhere else silently splits those three apart.
- Keep documentation specific to Agentiz in `notes/` (a local symlink, not tracked).
- Do not commit or publish changes unless explicitly requested.

## Calling the Agentiz MCP endpoint

- Base URL: `https://agentiz.m42.cx/mcp`. Auth via header `X-Mcp-Key: <MCP_KEY>` (or query param
  `mcp_key=...`) — the key lives in `.env` as `MCP_KEY` (`MCP_ADMIN_KEY` is a separate key and did
  not authenticate against this endpoint). Never hardcode the key value in tracked files; read it
  from `.env` at call time.
- `GET /mcp` returns the compact tool catalogue (groups + tool list). Without a valid key it only
  shows the public `general` group (just `health`). With a valid key it also shows `agentiz`
  (read-only: overview, projects, tasks, runs, runDetails, configuration) and `agentiz-actions`
  (state-changing: sync, runTask, cancelRun), plus more `general` tools (adminizer.user,
  system.listApps, system.toggleApp).
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
