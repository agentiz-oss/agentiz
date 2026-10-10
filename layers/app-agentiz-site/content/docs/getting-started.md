---
title: Getting started
order: 10
description: Run the server, create the first administrator, connect one worker and watch a task go through a pipeline.
---

> The panel's interface is in Russian for now. Menu items below are given in English translation,
> in the order you will find them.

## 1. Run the server

You need Node.js 20 or newer and git. The repository pulls its platform modules in as git
submodules, so clone it with them:

```bash
git clone --recurse-submodules https://github.com/agentiz-oss/agentiz
cd agentiz
npm install
npm run dev
```

The server listens on `http://localhost:17280`; the panel is at `/dashboard` and this site at `/`.
Out of the box it stores everything in SQLite (`.tmp/app-db.sqlite`) and applies database
migrations on start.

Outside production the server also seeds a few demo projects, roles and pipelines on every start,
so the panel is not empty on the first visit. With `NODE_ENV=production` seeds are switched off.

## 2. Create the administrator

The first visit to `/dashboard` asks for a login and a password — there is no default account.
Credentials are stored only as a salted hash; set `AP_PASSWORD_SALT` in production before you
create the account, and never change it afterwards.

## 3. Run it for real

For a long-lived deployment use PostgreSQL and the container image. Copy `.env.example` to `.env`
and adjust it; the important variables are:

| Variable | Meaning |
| --- | --- |
| `PORT` | HTTP port, `17280` by default. |
| `DB_DIALECT` | `sqlite` (default) or `postgres`, with `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`. |
| `AGENTIZ_PUBLIC_URL` | The address people and webhooks reach the server at, e.g. `https://agentiz.example.com`. Needed for OAuth callbacks behind a proxy and for repository webhooks. |
| `AGENTIZ_WORKER_API_ENABLED` | `true` (default) lets remote workers connect. `false` starts an in-process worker instead — handy for trying things out. |
| `AGENTIZ_SYNC_ENABLED` | Periodic synchronisation of tasks from connected trackers. |
| `MCP_ENABLED`, `MCP_ADMIN_KEY` | Turn on the [tool API](/docs/api) and set its key. |

A minimal Compose file:

```yaml
services:
  agentiz:
    image: ghcr.io/agentiz-oss/agentiz:latest
    env_file: .env
    environment:
      DB_DIALECT: postgres
      DB_HOST: postgres
      DB_NAME: agentiz
      DB_USER: agentiz
      DB_PASS: change-me
    ports: ["17280:17280"]
    volumes: ["./data:/app/data"]   # task attachments and other files
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: agentiz
      POSTGRES_USER: agentiz
      POSTGRES_PASSWORD: change-me
    volumes: ["./pgdata:/var/lib/postgresql/data"]
```

The repository's `deploy/` directory has the Compose files used for the project's own
deployment, including an ARM variant.

## 4. Connect a worker {#worker}

Runs are executed by workers, not by the server. On the machine that should run agents you need
Python 3.11+, Node.js/npm (agents are started through `npx`) and, for containerised stages, Docker.

1. In the panel open **Workers → New worker**. The panel shows a one-time **token** — copy it.
2. Install the worker:

   ```bash
   cd agentiz/worker
   python3 -m venv .venv && . .venv/bin/activate
   python -m pip install -e .
   ```

3. Configure it. Choose “custom server”, enter your server's address and paste the token:

   ```bash
   agentiz-worker configure
   ```

   The profile is saved to `~/.config/agentiz/worker.json` with mode `0600`.

4. Check that it can claim a job, then install it as a systemd user service:

   ```bash
   agentiz-worker run --once
   agentiz-worker install-service
   ```

The worker shows up as *online* in the panel. Log in to your agent CLIs (`claude`, `codex`)
**as the same Unix user** the worker runs as — the worker uses their existing login and never
sends credentials to the server.

## 5. First run

1. Open a project (or create one) and add a task under **Tasks → New task** — or connect
   GitHub/GitLab under **Integrations** and let the tasks sync in.
2. Make sure the project has a pipeline. The demo projects ship with a *Default pipeline*; see
   [Pipelines](/docs/pipelines) to write your own.
3. Press **Run** on the task. You can pick the worker, the model and the reasoning level for this
   run, or leave the pipeline's choices.
4. Follow the run on its page: stages, the live log, the diff. Anything that needs you — a
   question from the agent, a diff to approve — appears in the **Inbox**.

## When a run does not move

A run that sits in the queue is almost always waiting for a worker that is allowed to take it.
Read the run's log first; its last line tells you how far it got:

| Last log line | Look at |
| --- | --- |
| Run created from spec … | The pipeline spec: roles, repository, source. |
| Worker job queued | Workers: is one online, allowed for this project, not paused, not out of its usage limit or working hours? |
| Worker job claimed by … | The worker's own log: checkout, credentials, a dirty or misconfigured directory. |
| Stage / tool events | The agent itself is running. |
