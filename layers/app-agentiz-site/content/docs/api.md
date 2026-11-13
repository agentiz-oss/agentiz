---
title: Tool API
order: 60
description: Everything you can read or do in the panel is also a tool on the /mcp endpoint — for scripts, CI jobs and other agents.
---

> Despite its path and the `"protocol": "mcp"` field, this endpoint is a plain REST/JSON
> catalogue, not the JSON-RPC/Streamable HTTP transport of the Model Context Protocol. A client
> built for the official MCP transport needs an adapter.

## Enabling it

```bash
MCP_ENABLED=true
MCP_ADMIN_KEY=<a long random secret>
```

Without `MCP_ADMIN_KEY` every protected tool is unavailable. Send the key in the `X-Mcp-Key`
header; a `?mcp_key=` query parameter also works but ends up in logs and proxy metrics.

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/mcp` | Compact catalogue: groups and tool names. |
| `GET` | `/mcp/group/:group` | Full descriptions and JSON Schemas for one group. |
| `POST` | `/mcp/call/:tool` | Calls a tool; arguments are the JSON body. |

## Examples

```bash
export AGENTIZ=https://agentiz.example.com
export KEY=...   # your MCP_ADMIN_KEY

# What is there?
curl -s -H "X-Mcp-Key: $KEY" "$AGENTIZ/mcp"

# The last ten runs, then one of them in detail
curl -s -H "X-Mcp-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"limit":10}' "$AGENTIZ/mcp/call/agentiz.runs"
curl -s -H "X-Mcp-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"runId":"<id>"}' "$AGENTIZ/mcp/call/agentiz.runDetails"
```

## Groups

### `agentiz` — read-only

Safe to call as often as you like: `overview`, `projects`, `tasks`, `runs`, `runDetails`,
`configuration`, `pipelineSpecSchema`, `workers`, `workerDetails`, `jobs`, `proposals`,
`approvals`, `repositories`, `workflows`, `workflowDetails`, `workflowSchema`.

### `agentiz-actions` — changes state

`sync`, `runTask`, `cancelRun`, `manage` (projects, roles, pipeline specs…), `manageWorker`,
`manageProposal`, `manageRepositories`, `manageWorkflow`, `fireWorkflowTrigger`, `cancelWorkflowRun`, `decideApproval`
and others.

### `general`

Infrastructure: `health` (public), user management, listing and toggling application layers.

## Writing a pipeline through the API

Read the shape first: `agentiz.pipelineSpecSchema` returns the JSON Schema together with the
project's role keys and the workers' declared workspaces. A rejected write lists the failing
fields in `error.message`.

## Starting a project from scratch

Everything a project needs can be set up through the API, including a repository that does not
exist yet:

1. `manage` — create the project, its roles and two pipelines, both with
   `source.kind: "worker_workspace"` and an absolute `path` on the worker:
   a *bootstrap* pipeline with `createIfMissing: true` and `finalAction: none`, and the working
   pipeline with `finalAction: commit`.
2. `manageWorker` — `setAllowedProjects`, then `setWorkspaces` (bind the directory to the project)
   and `setGitPushRoots` (allow pushing from it).
3. `manage` — create a task for the bootstrap pipeline that asks the agent to initialise the
   repository and publish it with the GitHub CLI (`gh repo create <owner>/<name> --source . --push`),
   then `runTask`. This needs `gh` installed and logged in on the worker, under the same account
   (or an organisation it can see) as Agentiz's GitHub connection. Ask the agent to commit
   everything, stay on the default branch and run `gh auth setup-git`: the working pipeline starts
   only from a clean checkout whose branch matches the remote, and the worker's own `git` needs
   credentials to check that.
4. `manageRepositories` — `link` with `pathWithNamespace: "<owner>/<name>"`. A repository Agentiz
   has not seen yet is picked up by syncing the connections first.
5. Ordinary tasks now run on the working pipeline.

`repositories` lists the git connections, mirrored repositories and a project's links.
`manageRepositories` also has `sync`, `updateLink` and `unlink`; it never creates or deletes
repositories on the platform itself.

## Other APIs

- **Worker API** (`/api/agentiz/worker/v1`) — used by workers only, authenticated by the worker's
  token.
- **Mobile API** — used by the mobile client: tasks, runs, inbox, approvals, notification
  settings, device registration.
- **Webhooks** — inbound endpoints for repository events, signed with a per-repository secret.
