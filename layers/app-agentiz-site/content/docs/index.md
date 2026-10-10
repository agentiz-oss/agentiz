---
title: Documentation
order: 0
description: Agentiz runs AI coding agents against your tasks, on machines you own, and keeps a person in charge of what they change.
---

Start with [Getting started](/docs/getting-started) if you want a running server in ten minutes,
or with [Concepts](/docs/concepts) if you want the picture first.

## Contents

| Page | What it covers |
| --- | --- |
| [Getting started](/docs/getting-started) | Running the server locally and in Docker, the first administrator, connecting a worker, a first run. |
| [Concepts](/docs/concepts) | Projects, tasks, roles, pipelines, runs, jobs, workers, the inbox — and the path a task takes through them. |
| [Pipelines](/docs/pipelines) | The pipeline spec field by field: stages, source, final action, hooks, verdicts, working hours. |
| [Workers](/docs/workers) | Installing the worker, repository vs. prepared-directory runs, push rights, usage limits. |
| [Workflows](/docs/workflows) | Graphs that decide when to run: triggers, nodes, approvals and the review round. |
| [Tool API](/docs/api) | Reading state and taking actions over the `/mcp` endpoint. |

## Architecture in one paragraph

The **server** is a Node.js application (TypeScript) with an admin panel, a REST API for workers
and the mobile app, and a tool endpoint for automation. It owns the state: projects, tasks,
pipelines, the job queue, logs and diffs. A **worker** is a separate Python process that you
install on any machine with your agent CLIs on it. It has no database access — it registers with a
token, claims jobs over HTTPS, prepares the code, runs the agent stages through the
[Agent Client Protocol](https://agentclientprotocol.com) and reports results back. The **mobile
client** (Kotlin Multiplatform, Android and iOS) talks to the same server.

## Found a mistake?

These pages are markdown files in `layers/app-agentiz-site/content/docs/`. Every page has an
“Edit this page” link at the bottom; issues and pull requests are welcome.
