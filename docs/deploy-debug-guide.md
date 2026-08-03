# Deploying and debugging Agentiz on agentiz.m42.cx

How to take a bug you found in production, fix it, ship it, and prove it actually landed —
without shell/DB access to the production host. Written after the first real run of this loop
(2026-08-02): a null-pointer crash in two MCP tools, a job builder that refused to queue
repo-less projects, and a `PipelineSpec` row stuck at `spec: {}`. All three were fixed, deployed
and verified through the steps below, and the whole cycle took under 15 minutes end to end.

This is project-tracked documentation (how the release pipeline works), unlike `notes/`
(`../documentation`, untracked) which is for private working notes — see `AGENTS.md`.

## 1. What you can and can't reach

- **Can:** the Agentiz MCP endpoint at `https://agentiz.m42.cx/mcp` (see `AGENTS.md` for auth —
  `X-Mcp-Key` header, key in `.env` as `MCP_KEY`). This is read/write for everything the `agentiz`
  and `agentiz-actions` tool groups expose.
- **Can:** `git push origin main` — this repo's remote, `github.com:agentiz-oss/agentiz.git`.
- **Can't (from this dev environment):** SSH or any direct network route to the production host
  (`10.0.0.137`). No Postgres access, no `docker compose`, no reading container logs directly.
  That means: production data and behavior can only be inspected and changed through the MCP
  tools that exist, or by shipping a code/migration change through the pipeline below. If you
  need to see or fix something the MCP surface doesn't expose, read section 5 first.

## 2. How a push reaches production

```
git push origin main
        │
        ▼
.github/workflows/container.yml ("Container")
  builds the Docker image, tags it (incl. `main`, `latest`, short sha),
  pushes to ghcr.io/agentiz-oss/agentiz
        │
        ▼
Watchtower on the production host (the `agentiz` service in
deploy/docker-compose.yml carries `com.centurylinklabs.watchtower.enable=true`)
  polls the registry on its own schedule and force-recreates the
  container when the tag it's tracking changes — no manual
  `docker compose up -d --force-recreate` needed for this host
        │
        ▼
New process boots, runs pending migrations (layers/*/migrations,
umzug-based, auto-applied on startup), reseeds (seeds/*.seed.ts,
idempotent), starts serving
```

There is no manual step on your side once the image is pushed — but there's no push-based
notification either. You have to poll. Observed timing in the 2026-08-02 run: CI build finished
in ~2 minutes; Watchtower picked up the new image and the container restarted within ~7 minutes
of the build finishing. Budget up to ~10 minutes before assuming something's stuck.

## 3. Confirming a deploy actually landed

Don't infer this from container uptime alone — `agentiz.overview` reports the build identity
directly (added for exactly this purpose):

```bash
source .env
curl -s -X POST -H "X-Mcp-Key: $MCP_KEY" -H "Content-Type: application/json" \
  -d '{}' https://agentiz.m42.cx/mcp/call/agentiz.overview
```

Look at `result.server`:

```json
{ "gitSha": "808fe69", "buildTime": "2026-08-02T04:33:47Z",
  "processStartedAt": "2026-08-02T04:40:23.404Z", "uptimeSec": 22 }
```

`gitSha`/`buildTime` come from `GIT_SHA`/`BUILD_TIME` Docker build args (set in `container.yml`,
consumed in `Dockerfile`, already used by `config/adminizer.ts` for the admin footer). Compare
`gitSha` against the short hash of the commit you just pushed (`git rev-parse --short HEAD`).
`processStartedAt`/`uptimeSec` tell you the process actually restarted, in case a future change
needs to distinguish "new image, not restarted yet" from "still the old process."

A poll loop that doesn't burn the whole session waiting:

```bash
SHA=$(git rev-parse --short HEAD)
for i in $(seq 1 40); do
  got=$(curl -s -X POST -H "X-Mcp-Key: $MCP_KEY" -H "Content-Type: application/json" -d '{}' \
    https://agentiz.m42.cx/mcp/call/agentiz.overview \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['server']['gitSha'])")
  echo "$(date +%T) gitSha=$got"
  [ "$got" = "$SHA" ] && { echo DEPLOYED; break; }
  sleep 15
done
```

Run this as a background Bash task rather than a tight foreground loop — it can take several
minutes and there's no reason to block on it.

## 4. The fix → ship → verify loop

1. **Reproduce against prod first**, via MCP, before touching code — `agentiz.overview`,
   `agentiz.tasks`, `agentiz.configuration`, `agentiz.runDetails` are all read-only and safe to
   call freely. Get the exact error message/state before guessing.
2. **Find the code** the error maps to (grep the error string — it's usually a literal `throw`).
3. **Fix it.** Prefer the minimal, root-cause change; don't paper over a symptom with a fallback
   if the underlying invariant is wrong (see the `buildSnapshot` example in §6 — the fix made an
   incorrect requirement conditional, it didn't add a workaround around it).
4. **Type-check before pushing:** `npx tsc --noEmit`. This repo has some pre-existing unrelated
   errors (currently in `layers/app-agentiz-mobile-api/lib/mobileApiRouter.ts` and
   `seeds/agentiz-projects.seed.ts`) — confirm your change doesn't add new ones, don't try to fix
   unrelated ones in the same push.
5. **Smoke test locally before pushing**, especially for anything touching migrations or model
   data — a broken migration on prod is much more expensive to unwind than one caught locally:
   ```bash
   cp .tmp/app-db.sqlite /path/to/scratchpad/app-db.smoketest.sqlite
   DB_STORAGE=/path/to/scratchpad/app-db.smoketest.sqlite timeout 40 npm run dev
   ```
   Watch for migration/boot errors in the output. Never point this at the real `.tmp/app-db.sqlite`
   without copying it first — `npm run dev` will apply migrations and reseed against whatever
   `DB_STORAGE` points at.
6. **Stage only the files your fix touches.** Don't `git add -A` — this repo's working tree
   routinely has unrelated in-progress edits (e.g. a hand-edited `AGENTS.md`) that aren't yours to
   commit.
7. **Commit and push to `main`.** `container.yml` triggers on push to `main`/`master` — there's no
   separate release/tag step for this deployment.
8. **Poll CI**, then **poll `agentiz.overview`** (§3) until `gitSha` matches.
9. **Re-run the same MCP calls from step 1** and confirm the failure is gone. Don't assume — the
   fix might be incomplete, or might surface the *next* blocker in the chain (this happened twice
   in the 2026-08-02 session: fixing the null-pointer crash revealed the pipeline-spec schema
   error, and fixing that revealed the repo-resolution error).
10. **If it's still broken, go back to step 1.** Nothing here is a single-shot process — treat it
    as a loop and keep the same run/task IDs across iterations so you're comparing like with like.

## 5. No MCP tool for what you need? Add one.

The `agentiz` group (read-only: `overview`, `projects`, `tasks`, `runs`, `runDetails`,
`configuration`, `workers`, `workerDetails`, `jobs`) and `agentiz-actions` group (state-changing:
`sync`, `runTask`, `cancelRun`) are
defined in `layers/app-agentiz/mcp/agentizTools.ts` as a flat `IMcpTool[]` array
(`agentizMcpTools`). If the thing you need to inspect or change in production has no tool:

1. Add a new `IMcpTool` object in that file — copy the shape of an existing tool in the same
   group (`mode: 'protected'`, an `inputSchema`, an async `handler()` that talks to the Sequelize
   models directly, same as `overviewTool`/`runTaskTool`).
2. Put read-only tools in `agentiz`, state-changing ones in `agentiz-actions` — this split is
   meaningful to callers, not cosmetic.
3. Add it to the `agentizMcpTools` export array at the bottom of the file.
4. Ship it through the loop in §4. Confirm it's live by re-fetching the catalogue, not just by
   calling it — `GET /mcp` (or `/mcp/group/agentiz[-actions]`) should list the new tool name once
   the new build is deployed:
   ```bash
   curl -s -H "X-Mcp-Key: $MCP_KEY" https://agentiz.m42.cx/mcp
   ```

**When not to add a tool:** a one-off repair of existing bad data (not a capability you'll need
again) belongs in a migration instead — see §6. Don't build a permanent MCP mutation endpoint just
to run it once.

## 6. Data repairs: migrations, not manual DB edits

There's no direct DB access from here, so a broken *row* (not a broken *schema*) gets fixed the
same way as broken code: a migration under `layers/app-agentiz/migrations/umzug/`, registered in
`umzugExports.ts`, applied automatically the next time the process boots (via the same
push → build → Watchtower cycle in §2 — no separate migration-run step).

Worked example (`1785000008000_repair_empty_pipeline_specs.ts`, added 2026-08-02): a project had a
`PipelineSpec` row with `spec: {}` — valid enough to create, but rejected by
`PipelineSpecResolver.assertValidSpec` at run time, so every task in that project failed before
its first stage with no way to fix it through the admin UI or an MCP tool. The migration:

- selects every `PipelineSpec` row across all projects,
- leaves any row with a real `stages` array untouched,
- for the rest, creates a `stub` `AgentRole` for that project if one doesn't exist yet, and
  overwrites `spec` with a minimal one-stage `finalAction: none` pipeline.

Guard on the *shape of the bad data*, not a hardcoded project ID — that keeps the migration
correct if the same defect shows up in a different project or environment, and makes it a no-op
(verified locally, §4 step 5) everywhere the data is already fine. Data-repair migrations don't
need a real `down()` — the original bad state usually isn't worth reconstructing; say so in a
comment rather than faking a reversible migration.

## 7. Worked example: the three bugs fixed 2026-08-02

For reference — the shape of an actual debug session using this whole loop:

1. **`agentiz.overview` / `agentiz.projects` → `Cannot read properties of null (reading 'owner')`.**
   `projectTeaser()` in `agentizTools.ts` read `project.repoConfig.owner` unconditionally.
   `repoConfig` is nullable by design (migration `optional_project_repo`: a project can be
   task-manager-only, with no git provider at all). Fix: guard with `project.repoConfig ? ... :
   null`.
2. **`agentiz.runTask` → `"Pipeline spec does not match schema"`.** The project's only
   `PipelineSpec` had `spec: {}`. Traced through `PipelineSpecResolver.assertValidSpec` against
   `schemas/pipeline-spec.schema.json`. Fixed by the data-repair migration in §6, not by hand-
   editing the row (no access to do that anyway).
3. **After the migration, `agentiz.runTask` still failed** — this time inside
   `AgentWorkerJobBuilder.buildSnapshot`, which unconditionally called `resolveTaskRepository()`
   and threw `Project ...: task ... has no repository` for the same repo-less project. But
   `AgentPipelineService`'s own `finalize()` already treats `finalAction: 'none'` as needing no git
   provider at all — `buildSnapshot` was stricter than the code that actually executes the run.
   Fix: only resolve the repository when `finalAction.type !== 'none'`.

Each of the three was: reproduce via MCP → find the throwing line → fix → typecheck → push →
poll CI → poll `agentiz.overview` for the new `gitSha` → re-run the same MCP call → confirm, or
find the next layer of the bug and repeat. Final confirmation was `agentiz.runTask` succeeding,
`agentiz.runDetails` showing a clean stage log ending in `Run succeeded, task moved to "done"`,
and `agentiz.tasks` showing `status: "done"`.
