"""Runs the pipeline's `before` and `after` scripts.

Three decisions here are deliberate:

* **The script never chooses its own interpreter.** The pipeline names `bash` or `node`, and that
  name is resolved to an absolute executable on this machine. A shebang inside the body is just a
  comment, because the file is passed *to* the interpreter rather than executed directly. A spec
  fetched over the API therefore cannot point the operator's machine at an arbitrary binary.
* **Values arrive as environment variables.** The server sends them already computed
  (`snapshot.hooks.env`); nothing is substituted into the script text, so a task titled
  ``"; rm -rf ~`` is a string to the shell rather than a command. See layers/app-agentiz/lib/hookEnv.ts.
* **The script file lives outside the working directory.** For a `worker_workspace` pipeline the
  working directory is the operator's real project, and writing a scratch file into it would show
  up in their `git status` — or, for a repository pipeline, in the diff the run proposes.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

#: `errexit` and `pipefail`, so a failing command in the middle of a hook fails the hook instead of
#: being swallowed by the exit status of the last line. `nounset` is deliberately NOT set: a hook
#: legitimately tests optional variables, and `set -u` would abort on the first `$MAYBE`.
BASH_FLAGS = ["-e", "-o", "pipefail"]

#: Output kept per hook. The tail is what is kept, because a script that failed says why at the end.
MAX_HOOK_OUTPUT_BYTES = 64 * 1024

DEFAULT_TIMEOUT_SEC = 600


class HookError(RuntimeError):
    """A hook failed and its pipeline said that should stop the run."""


def _interpreter(name: str) -> list[str]:
    if name == "bash":
        executable = shutil.which("bash")
        if not executable:
            raise HookError("hook interpreter 'bash' is not installed on this worker")
        return [executable, *BASH_FLAGS]
    if name == "node":
        executable = shutil.which("node")
        if not executable:
            raise HookError("hook interpreter 'node' is not installed on this worker")
        return [executable]
    raise HookError(f"unknown hook interpreter {name!r}; expected 'bash' or 'node'")


def _shebang(name: str) -> str:
    """Written into the file for anyone who later reads it from a core dump or a debug copy.

    It has no effect on execution — the interpreter is chosen by `_interpreter` — which is exactly
    why it is safe to write.
    """
    return "#!/usr/bin/env bash\n" if name == "bash" else "#!/usr/bin/env node\n"


def _tail(text: str, limit: int = MAX_HOOK_OUTPUT_BYTES) -> tuple[str, bool]:
    encoded = text.encode("utf-8", "replace")
    if len(encoded) <= limit:
        return text, False
    # Decoding a slice can cut a multi-byte character in half; "replace" keeps that from raising.
    return encoded[-limit:].decode("utf-8", "replace"), True


def run_hook(
    position: str,
    hook: dict[str, Any],
    workdir: Path,
    env: dict[str, str],
    log: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Executes one hook and returns what happened.

    Raises `HookError` only when the hook failed *and* declared `onFail: stop`; a `continue` hook
    reports its failure in the returned record and lets the run proceed.
    """
    interpreter = str(hook.get("interpreter") or "")
    script = str(hook.get("script") or "")
    if not script.strip():
        raise HookError(f"{position} hook has no script")
    timeout = int(hook.get("timeoutSec") or DEFAULT_TIMEOUT_SEC)
    on_fail = str(hook.get("onFail") or "stop")
    argv = _interpreter(interpreter)

    # mkdtemp is 0700, so the script is unreadable to other users on the machine even though it is
    # the operator's own code — it may well contain a password they typed into the editor.
    scratch = Path(tempfile.mkdtemp(prefix="agentiz-hook-"))
    path = scratch / ("hook.sh" if interpreter == "bash" else "hook.js")
    try:
        path.write_text(_shebang(interpreter) + script)
        path.chmod(0o600)
        if log:
            log(f"Хук {position}: запуск через {interpreter} в {workdir}")
        try:
            result = subprocess.run(
                [*argv, str(path)],
                cwd=str(workdir),
                env={**os.environ, **env},
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                check=False,
            )
            output, truncated = _tail(result.stdout or "")
            exit_code: int | None = result.returncode
            timed_out = False
        except subprocess.TimeoutExpired as expired:
            captured = expired.stdout or ""
            if isinstance(captured, bytes):
                captured = captured.decode("utf-8", "replace")
            output, truncated = _tail(captured)
            exit_code = None
            timed_out = True

        record = {
            "position": position,
            "interpreter": interpreter,
            "exitCode": exit_code,
            "timedOut": timed_out,
            "output": output,
            "outputTruncated": truncated,
            "onFail": on_fail,
        }
        if timed_out:
            record["error"] = f"{position} hook exceeded its {timeout}s timeout and was killed"
        elif exit_code:
            record["error"] = f"{position} hook exited with code {exit_code}"

        if record.get("error"):
            if on_fail == "stop":
                # The output goes into the exception because that message is what the operator
                # reads in the run log; an exit code alone never explains anything.
                raise HookError(f"{record['error']}\n{output}".strip())
            if log:
                log(f"Хук {position} не удался ({record['error']}), но onFail=continue — запуск продолжается")
        elif log:
            log(f"Хук {position} завершён успешно")
        return record
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
