---
title: Workflows
order: 50
description: A workflow is a graph that decides when a pipeline runs and what happens around it. Pipelines say how an agent works on a task; workflows say when.
---

## Shape of a graph

- **Triggers** are the only entry points. There is no “run this workflow” button — a flow runs
  because a trigger fired. A manual run names one specific trigger node.
- **Server nodes** do their work immediately and pass the message on.
- **External nodes** park the flow until something else happens — a pipeline finishes, a person
  decides. Parked flows are stored in the database and survive restarts and deploys.

Graphs are acyclic. Several edges may lead *into* a node, but one output port may have only one
edge out of it; different ports of the same node (`succeeded`, `failed`) are separate.
**Saving is deploying**: an active graph's triggers are armed the moment it is saved, and saving
validates it.

## Nodes

| Node | Does |
| --- | --- |
| `agentiz.task.trigger` | Fires when a task is created, updated (title, description, tags) or commented. |
| `agentiz.repository.trigger` | Fires on commits pushed to a branch, a finished CI run, or a published package. |
| `trigger.cron` | Fires on a schedule. |
| `agentiz.task.match` | Checks a task against words, tags or other conditions and routes it. |
| `agentiz.tasks.query` | Finds tasks, e.g. for a scheduled release round. |
| `agentiz.task.run` | Starts a pipeline and moves on immediately. |
| `agentiz.pipeline` | Starts a pipeline and waits for it; exits through `succeeded`, `failed` or, with a verdict stage, `pass` / `fail`. The run's facts — branch, commit, PR, diff size — travel on in the payload. |
| `agentiz.approval` | Waits for a person to approve or reject. A rejection must carry a text, which becomes the agent's next instruction. |
| `agentiz.task.create` | Creates a task. |
| `agentiz.task.comment` | Writes into a task's thread. |
| `agentiz.task.status` | Sets the task's human-readable workflow status (“waiting for QA”). |
| `agentiz.notify` | Sends a notification through the project's notification policy. |

Each node carries its own documentation in the canvas's properties panel, and the same text is
returned by the `agentiz.workflowSchema` tool. Templates in node settings read the incoming
message, for example `{{payload.branch}}` after a pipeline node.

## Recipe: start a pipeline for marked tasks

```text
[task created] ──► [match: title contains "do it" or tag "todo"] ──► [pipeline (wait)]
```

1. In the project open **Automation → Workflows → New workflow**.
2. Drop three nodes from the palette: the task trigger, the task match and the pipeline node.
   Connect them.
3. Configure the trigger for *created*, the match for the words or tags you want, and pick the
   pipeline.
4. Mark the workflow active and save. The next matching task starts a run.

## The round with a human

“Agent does it → agent checks it → a person accepts it” is expressed without a cycle. The graph
has two inputs: *task created* and *task commented*. The develop-and-review work is one pipeline
with a verdict stage; after it an approval node waits for a person. When the person rejects with
remarks, the last node writes them into the task's thread — and that comment fires the second
input, which starts the next round.

```text
[task created] ───┐
                  ├─► [pipeline: fix + review] ─pass─► [approval] ─approve─► [status: done]
[task commented] ─┘                           └fail─► [comment]  └reject──► [comment remarks]
```

Four safeguards keep such a loop from feeding itself. Two are hard rules: a comment written by a
run never wakes the trigger, and neither does a comment marked silent. Two are settings on the
trigger: `skipIfFlowActive` (do not start while this task already has a flow in progress) and
`maxRounds`.

## Repository events

Commits and CI results arrive from two sources at once — a webhook Agentiz installs on the
repository, and a poll every 15 minutes, because webhook deliveries can be lost while a server is
restarting. A per-repository cursor makes them one source: a push the webhook already reported is
not reported again by the poll. Pushes made by Agentiz's own runs are ignored by default, CI
results for them are not — “the build of our branch failed” is exactly what should send the task
back to the agent.

Webhooks need `AGENTIZ_PUBLIC_URL`. Without it everything still works through polling.
