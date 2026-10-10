---
title: Pipelines
order: 30
description: A pipeline spec is a JSON document that says which agents work on a task, in what order, on what code, and what happens to the result.
---

Specs are validated against a JSON Schema
(`layers/app-agentiz/schemas/pipeline-spec.schema.json`) on every write path — the panel's
editor, the generic admin form, the tool API and the panel assistant — and a rejection always
names the field. A spec belongs to its project and never moves to another one.

## A complete example

```json
{
  "stages": [
    { "order": 1, "role": "investigate", "agentRoleKey": "investigator",
      "runtime": { "mode": "host" } },
    { "order": 2, "role": "fix", "agentRoleKey": "fixer",
      "runtime": { "mode": "host" } },
    { "order": 3, "role": "review", "agentRoleKey": "reviewer",
      "runtime": { "mode": "host" }, "model": "claude-opus-5-5", "verdict": true }
  ],
  "source": { "kind": "repository", "branch": "main" },
  "finalAction": {
    "type": "commit_and_pr",
    "branchPrefix": "agentiz/bug-",
    "commitMessageTemplate": "fix: {{title}} (#{{externalId}})",
    "pullRequestTitleTemplate": "fix: {{title}}"
  },
  "hooks": {
    "before": { "interpreter": "bash", "script": "npm ci", "timeoutSec": 600 },
    "after":  { "interpreter": "bash", "script": "npm run format",
                "onFail": "continue" }
  }
}
```

Only `stages` and `finalAction` are required.

## Stages

Stages run strictly in ascending `order`, and each receives the outputs of the ones before it.

| Field | Meaning |
| --- | --- |
| `order` | Position; unique within the spec. |
| `role` | Display and log name of the step: `investigate`, `fix`, `review`… |
| `agentRoleKey` | The agent role (from the same project) that supplies prompt, model and command. |
| `runtime.mode` | `host` runs the agent in the worker's process; `docker` starts it in a container. |
| `model` | Overrides the role's model for this stage only. |
| `onFail` | `stop` (default) fails the run; `continue` marks the stage failed and goes on. |
| `verdict` | Ask the agent for a machine-readable `AGENTIZ_VERDICT: pass` or `AGENTIZ_VERDICT: fail — reason`. |

Model precedence is: manual launch → stage → role.

### Verdicts

A stage with `verdict: true` gets an extra instruction in its prompt, and its answer — only its
own, never another stage's prose — is parsed into the run's `verdict` (`pass` / `fail`) and
`verdictReason`. If the agent forgets the marker, the worker asks once more in the same session.
In a workflow, a pipeline with a verdict stage exits through `pass` / `fail` ports; `failed` stays
reserved for infrastructure failures.

## Source

`source.kind` decides what the run works on.

### `repository` (default)

The worker makes a fresh checkout of a repository linked to the project, at the exact base commit
the server recorded, and removes it afterwards. Credentials are handed to git through a temporary
helper and never land in `.git/config` where the agent could read them.

| Field | Meaning |
| --- | --- |
| `repositoryId` | Which linked repository; absent means the repository the task came from. |
| `branch` | Branch to start from; absent means the repository's default. |
| `allowTaskOverride` | Let a task pick the branch with a `branch:<ref>` tag. |

### `worker_workspace`

The run happens in a prepared directory on one specific worker — a project with its dependencies
already installed and its environment filled in. The job is pinned to that worker.

```json
"source": {
  "kind": "worker_workspace",
  "workspace": { "workerId": "…", "workspaceKey": "monorepo" }
}
```

Name the directory with exactly one of `workspaceKey` (declared on the worker in advance, so the
path can change without touching the spec) or `path` (absolute; add `createIfMissing` to let the
worker create it). Uncommitted changes already in the directory are not the agent's: by default
they are stashed before the run and the stash is named in the log. Set `stashDirty: false` to
refuse to start instead.

## Final action

| `type` | Result |
| --- | --- |
| `commit_and_pr` | Push a branch `<branchPrefix><externalId>` and open a pull/merge request. |
| `commit` | Commit to `branch` (or, in a workspace, to the current or a new short branch via `targetBranch`). |
| `comment_only` | Post the result to the task, change nothing. |
| `none` | Keep the result in Agentiz. |

Templates understand `{{taskId}}`, `{{externalId}}`, `{{title}}` and `{{summary}}`.
`requireApproval: true` holds the change in Agentiz until a person applies it.

Whether a run may commit or push from a worker's directory is **not** a property of the spec. The
grant lives on the worker record and is checked when the run is queued, so it can be withdrawn at
any time. See [Workers](/docs/workers#push-rights).

## Hooks

A `bash` or `node` script before the first stage and after the last one, in the directory the
agent works in. `after` runs before the diff is collected (a formatter's changes are included)
and also when a stage failed, with `AGENTIZ_RUN_STATUS=failed`.

Values reach scripts only as `AGENTIZ_*` environment variables — never substituted into the script
text, because task titles come from external trackers and substitution would turn every title
into a command. The panel's hook editor completes the available variable names.

## Triggers and constraints

```json
"triggers": { "humanComment": true },
"constraints": {
  "priority": 10,
  "activeHours": {
    "timezone": "Europe/Berlin",
    "windows": [{ "days": ["mon","tue","wed","thu","fri"], "start": "09:00", "end": "19:00" }]
  }
}
```

`humanComment` starts a run when a person writes in the task thread; the comment becomes the
run's instruction. `priority` orders the queue (lower first). `activeHours` delays the *start* of
runs to the given windows; a window whose end is before its start crosses midnight.
