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
`approvals`, `workflows`, `workflowDetails`, `workflowSchema`.

### `agentiz-actions` — changes state

`sync`, `runTask`, `cancelRun`, `manage` (projects, roles, pipeline specs…), `manageWorker`,
`manageProposal`, `manageWorkflow`, `fireWorkflowTrigger`, `cancelWorkflowRun`, `decideApproval`
and others.

### `general`

Infrastructure: `health` (public), user management, listing and toggling application layers.

## Writing a pipeline through the API

Read the shape first: `agentiz.pipelineSpecSchema` returns the JSON Schema together with the
project's role keys and the workers' declared workspaces. A rejected write lists the failing
fields in `error.message`.

## Other APIs

- **Worker API** (`/api/agentiz/worker/v1`) — used by workers only, authenticated by the worker's
  token.
- **Mobile API** — used by the mobile client: tasks, runs, inbox, approvals, notification
  settings, device registration.
- **Webhooks** — inbound endpoints for repository events, signed with a per-repository secret.
