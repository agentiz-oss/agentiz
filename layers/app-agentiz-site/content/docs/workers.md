---
title: Workers
order: 40
description: A worker is a Python process on a machine you control. It claims jobs from the server, prepares the code, runs the agents and reports back — nothing else.
---

## What a worker is allowed to know

The worker has no database access. It authenticates with the token the panel issued when the
worker record was created and talks to the server over HTTPS only: claim a job, renew its lease,
stream log events, fetch short-lived repository credentials, upload the result. The agent CLIs'
own logins (Claude, Codex) stay on the worker machine and are never sent to the server.

Installation is covered in [Getting started](/docs/getting-started#worker). The useful commands:

```bash
agentiz-worker configure         # create or update ~/.config/agentiz/worker.json
agentiz-worker run --once        # claim and run a single job, then exit
agentiz-worker run               # run in the foreground
agentiz-worker install-service   # install and start a systemd user service
```

A unit written by `install-service` carries its own `PATH` with `~/.local/bin` first, because
that is where agent CLIs install themselves and systemd does not inherit your shell's
environment. After upgrading the worker, run `install-service` again to refresh the unit.

## Which jobs a worker gets

Filtering happens on the server, inside the claim query. A worker is offered a job only if:

- it is active and has been in contact recently;
- the job's project and executor are on its allowlist;
- the job is not pinned to a different worker;
- it is below its *maximum concurrent jobs*;
- it is inside its own working hours;
- the subscription behind the job's agent is not exhausted and the agent is logged in.

A job nobody may take stays queued. When the reason is something a person must fix — an agent
logged out on every worker — the run says so in its log and in the inbox.

## Two ways to get the code

### Fresh checkout

For a `repository` pipeline the worker creates `<workspace>/<jobId>/repo`, checks out the exact
base commit, runs the stages, collects the staged diff and deletes the directory. Agent stages in
`docker` mode are refused here: the container would not see the checkout.

### Prepared directory

For a `worker_workspace` pipeline the run happens in a directory that already exists on that
machine. Declare it on the worker's card (**Folders** tab) with a key and an absolute path;
pipelines then refer to the key. A declaration may be bound to a project, and then only that
project's pipelines may use the directory — by key or by path.

While a run's result waits for review the directory is *reserved*: further runs there wait until
the change is approved, rejected or released. Rejecting or releasing never destroys work — the
directory is stashed (`git stash push -u`) before it is reset, and the stash commit is recorded on
the proposal.

## Push rights

Whether a run may commit and push from a worker's directory is decided by the **worker record**,
never by the pipeline: either a list of path prefixes from which pushing is allowed, or a
`pushEnabled` flag on a declared workspace (which can also name a remote other than `origin`). It
is checked when a run is queued.

Pushing uses the git credentials already configured on the machine for the worker's user — an SSH
key or a credential helper. Before the first stage the worker checks that the tree is clean, that
`HEAD` is on a branch and that the local branch matches the remote; if any of these fail, the run
stops before an agent is started and the log says which.

## Usage limits

A usage limit belongs to an **account**, not to a machine: two workers logged in to the same
Claude subscription share one limit. Agentiz models this as a *subscription* bound to workers.
Workers report usage every two minutes (for Claude from its OAuth usage endpoint, for Codex
through the CLI's own `app-server`), and the panel shows each window with its reset time.

- When a stage is refused because of a limit, the run is **deferred**, not failed: the job goes
  back to the queue until the window resets (a job pinned to one worker) or retries shortly on
  another worker.
- Stop thresholds let you keep a reserve — stop claiming at 90% of a window, for instance.
- Optionally, a subscription can be aligned so that its daily reset lands at a chosen hour, or
  keep its session windows open back to back.

Logged out is a different state from out of quota: it belongs to one machine, has no end time, and
appears in the inbox until the next healthy report clears it by itself.

## Agent CLIs

Stages are executed through the Agent Client Protocol. The role's `acpCommand` names the adapter,
typically started with `npx`; the model chosen for the stage is applied to the ACP session after
it starts. Reasoning level is applied per agent: Codex receives it with the model id, Claude as a
thinking-token budget.
