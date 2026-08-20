"""Assembles the single user message a stage's agent receives.

The job snapshot carries the whole task thread (`conversation`), not only the task record, and the
difference matters: a run started from a comment has to act on *that comment* and read the task
description as background. Rendering it here is what makes the second run on a task continue the
conversation instead of starting the original task over — the server has frozen the thread into the
snapshot since the human-comment trigger existed, but nothing on this side ever read it.

Everything is appended after the task block rather than replacing it: with no `conversation` in the
job the text is byte-identical to what roles have been prompted with all along, so an old snapshot
and a pipeline whose system prompt was written against that shape keep working unchanged.
"""

from __future__ import annotations

from typing import Any

#: Per-message cap. Long enough for a real review comment, short enough that one pasted log cannot
#: crowd out the instruction the run actually exists for.
MAX_THREAD_MESSAGE_CHARS = 2_000
#: Budget for the thread as a whole. The newest messages survive; older ones are dropped as a group
#: and counted out loud, because a silently shortened history reads exactly like a complete one.
MAX_THREAD_CHARS = 12_000
#: Only the last few runs carry state worth re-reading; anything older is already summarised in them.
MAX_PRIOR_RUNS = 3
MAX_RUN_TEXT_CHARS = 2_000


def clip(text: str, limit: int) -> str:
    """Cut to `limit`, saying so — an unmarked cut looks like the agent's own output ended there."""
    stripped = text.strip()
    if len(stripped) <= limit:
        return stripped
    return f"{stripped[:limit].rstrip()}\n… (truncated, {len(stripped) - limit} more characters)"


def _text_of(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _turn(message: dict[str, Any]) -> str:
    kind = _text_of(message.get("authorKind")) or "unknown"
    name = _text_of(message.get("authorName"))
    when = _text_of(message.get("createdAt"))
    label = f"{kind} ({name})" if name else kind
    if when:
        label = f"{label} at {when}"
    return f"--- {label} ---\n{clip(_text_of(message.get('body')), MAX_THREAD_MESSAGE_CHARS)}"


def _stage_text(stage: dict[str, Any]) -> str:
    """The agent's own words for one stage, wherever this server version filed them."""
    output = stage.get("output")
    if isinstance(output, dict):
        for key in ("agentResponse", "summary"):
            text = _text_of(output.get(key))
            if text:
                return clip(text, MAX_RUN_TEXT_CHARS)
    return clip(_text_of(output), MAX_RUN_TEXT_CHARS)


def _prior_run(run: dict[str, Any], number: int) -> str:
    trigger = _text_of(run.get("trigger")) or "unknown"
    status = _text_of(run.get("status")) or "unknown"
    lines = [f"--- run {number} ({trigger}) finished as {status} ---"]
    summary = _text_of(run.get("resultSummary"))
    if summary:
        lines.append(clip(summary, MAX_RUN_TEXT_CHARS))
    else:
        # A run that failed mid-way has no summary of its own; its stages are all that is left of it.
        for stage in run.get("stages") or []:
            if not isinstance(stage, dict):
                continue
            text = _stage_text(stage)
            if text:
                lines.append(f"[{_text_of(stage.get('role')) or 'stage'}] {text}")
    for stage in run.get("stages") or []:
        if not isinstance(stage, dict):
            continue
        error = _text_of(stage.get("errorMessage"))
        if error:
            lines.append(f"[{_text_of(stage.get('role')) or 'stage'}] failed: {clip(error, MAX_RUN_TEXT_CHARS)}")
    error = _text_of(run.get("errorMessage"))
    if error:
        lines.append(f"Run error: {clip(error, MAX_RUN_TEXT_CHARS)}")
    return "\n".join(lines)


def prior_runs_block(runs: list[Any]) -> str:
    entries = [run for run in runs if isinstance(run, dict)]
    if not entries:
        return ""
    dropped = max(len(entries) - MAX_PRIOR_RUNS, 0)
    rendered = [_prior_run(run, dropped + offset + 1) for offset, run in enumerate(entries[-MAX_PRIOR_RUNS:])]
    if dropped:
        rendered.insert(0, f"({dropped} earlier run(s) omitted.)")
    return "\n\n".join(["# Earlier runs on this task", *rendered])


def thread_block(messages: list[Any], skip_id: Any) -> str:
    """The discussion, oldest first, newest kept when the budget runs out."""
    turns = [
        message for message in messages
        if isinstance(message, dict) and _text_of(message.get("body")) and message.get("id") != skip_id
    ]
    kept: list[str] = []
    spent = 0
    for message in reversed(turns):
        rendered = _turn(message)
        if kept and spent + len(rendered) > MAX_THREAD_CHARS:
            break
        kept.append(rendered)
        spent += len(rendered)
    if not kept:
        return ""
    kept.reverse()
    dropped = len(turns) - len(kept)
    if dropped:
        kept.insert(0, f"({dropped} earlier message(s) omitted.)")
    return "\n\n".join(["# Discussion so far, oldest first", *kept])


def _size_label(size: Any) -> str:
    try:
        number = int(size)
    except (TypeError, ValueError):
        return ""
    if number < 1024:
        return f"{number} B"
    if number < 1024 * 1024:
        return f"{number / 1024:.0f} KB"
    return f"{number / 1024 / 1024:.1f} MB"


def attachments_block(files: list[Any] | None) -> str:
    """Files attached to the task, already on this machine's disk.

    The paths are what matters: the agent's own tools read them directly. Said explicitly that
    they live outside the working tree — an agent that helpfully commits a "missing" screenshot
    into the repository would turn an input into a change.
    """
    entries = [item for item in (files or []) if isinstance(item, dict) and item.get("path")]
    if not entries:
        return ""
    lines = [
        "# Attached files",
        "The task has attached file(s), already saved on this machine. Read them from these paths:",
    ]
    for entry in entries:
        details = ", ".join(part for part in (_text_of(entry.get("mimeType")), _size_label(entry.get("sizeBytes"))) if part)
        lines.append(f"- {entry['path']}" + (f" ({details})" if details else ""))
    lines.append(
        "They are inputs stored outside the working tree — do not copy them into the repository "
        "unless the task itself asks for that."
    )
    return "\n".join(lines)


def build_prompt(stage: dict[str, Any], job: dict[str, Any], attachments: list[Any] | None = None) -> str:
    task = job.get("task") if isinstance(job.get("task"), dict) else {}
    conversation = job.get("conversation") if isinstance(job.get("conversation"), dict) else {}
    primary = conversation.get("primaryPrompt") if isinstance(conversation.get("primaryPrompt"), dict) else None
    instruction = clip(_text_of(primary.get("body")), MAX_THREAD_MESSAGE_CHARS * 4) if primary else ""

    parts = [
        _text_of(stage.get("systemPrompt")),
        f"Task: {task.get('title', '')}",
        _text_of(task.get("description")),
        attachments_block(attachments),
        prior_runs_block(conversation.get("priorRuns") or []),
        thread_block(conversation.get("messages") or [], primary.get("id") if primary else None),
    ]
    if instruction:
        # Last, and named: everything above is why the task looks the way it does, this is what to
        # do now. Without the second sentence an agent re-reads the description and redoes the run.
        parts.append(
            "# Current instruction\n"
            "This is the newest message in the thread and it is what you must do now. Everything "
            "above is background — do not start the original task over.\n\n"
            f"{instruction}"
        )
    return "\n\n".join(part for part in parts if part)
