---
title: Concepts
order: 20
description: A handful of objects, each with one job. Knowing which one owns a decision is most of knowing Agentiz.
---

## The path of a task

```text
task ──► pipeline ──► run ──► job ──► worker ──► stages ──► result ──► review
          (which)     (one     (queue   (machine   (agents)    (diff,     (person)
                      attempt)  entry)   you own)               branch, PR)
```

## Project

The unit of ownership. Tasks, pipelines, agent roles, repositories, workflows and members all
belong to a project. Members hold a role in it — a ladder where each step includes the previous
one — and see only the projects they belong to: in the panel, in the mobile app and through the
API.

## Task

Something to do: a title, a description, tags, attachments and a discussion thread. Tasks come
from a **task source** (GitHub or GitLab issues, synchronised), from the panel, from the mobile
app, or are created by a workflow. A comment in the thread can start a new run that continues the
task instead of redoing it — the agent receives the whole discussion and the results of earlier
runs.

## Agent role

Who does a step: a system prompt, a model and the command that starts the agent. Agents are
started over the Agent Client Protocol, so any ACP-speaking CLI works:

```json
{
  "executor": "openhands-acp",
  "acpCommand": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
}
```

## Pipeline

What happens to a task, written as a JSON spec: an ordered list of stages, each naming a role;
where the code comes from; and what to do with the result. A project can have several pipelines;
tags on the task pick one, and one is marked as the default. See [Pipelines](/docs/pipelines).

## Run and job

A **run** is one attempt at a task with one pipeline. When it is created the server freezes
everything it needs — the spec, the roles, the conversation, the attachments — into a **job**
snapshot and queues it. Freezing is deliberate: editing a pipeline or writing a new comment affects
the next run, never the one in flight.

A manual launch may override three things for that run only: the worker/executor, the model and
the reasoning level.

## Worker

A machine that executes jobs. The queue is filtered on the server: a worker only gets jobs for
projects and executors it is allowed, within its working hours, its concurrency limit and its
agents' usage limits. A job no worker may take simply waits — that is a waiting run, not a lost
one. See [Workers](/docs/workers).

## Result and review

Every run produces a summary and, if it touched code, a diff. The pipeline's **final action**
decides what happens next: open a pull request, commit to a branch, post a comment, or nothing.
With `requireApproval` the change is held in Agentiz until somebody approves it; in a prepared
directory on a worker the diff is reviewed before the worker commits or pushes.

## Inbox

Everything waiting on a person, computed from live state: a question the agent asked, a diff
awaiting review, a held change, a failed push, a task whose last run failed, a worker that needs
its agent logged in again. *Blocking* items hold something — an agent, a directory — and are
counted in the badge; *reminders* hold nothing and simply sink as newer ones arrive. The same
inbox is shown in the panel and in the mobile app.

## Activity and notifications

Every event worth knowing about — a run finished, a question asked, a review waiting — is written
to the activity feed first, then delivered by push or the panel's bell according to a
notification policy. The policy can be set globally, per project and per pipeline, so “why didn't
I get a push?” always has an answer in the feed.

## Workflow

A graph that decides *when* to run a pipeline and what to do afterwards: react to a new task, a
comment, a push or a CI result; wait for a person's approval; post a comment; send a
notification. Pipelines say *how* an agent works; workflows say *when*. See
[Workflows](/docs/workflows).

## Repository and git provider

Repositories are first-class: a connection to GitHub or GitLab (OAuth) gives the server a list of
repositories, and a project links the ones it works on. The same repository id is used by the
worker allowlist, the job snapshot and the stored diff. Where the code lives (git providers) and
where tasks come from (task managers) are separate, so a project can mix them.
