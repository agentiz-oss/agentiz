"""Checks out the exact commit a job was queued for.

Two things here are deliberate and easy to get wrong:

* **The clone URL stays clean.** Credentials go through a temporary GIT_ASKPASS script, never into
  the URL and never into `git config credential.helper`. The agent can read `.git/config`, and a
  token embedded in `remote.origin.url` would sit there for the whole run.
* **`GIT_TERMINAL_PROMPT=0`.** Without it git asks for a username on an unreachable repository and
  hangs forever under systemd, where there is no terminal to answer.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any, Callable

ASKPASS_NAME = "askpass.sh"


class CheckoutError(RuntimeError):
    pass


def _run(args: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def _git(args: list[str], cwd: Path, env: dict[str, str]) -> str:
    result = _run(["git", *args], cwd=cwd, env=env)
    if result.returncode:
        raise CheckoutError(f"git {' '.join(args)} failed: {result.stdout.strip()}")
    return result.stdout


def write_askpass(root: Path, username: str, password: str) -> tuple[Path, dict[str, str]]:
    """Creates the helper git calls when it needs credentials, plus the env that drives it."""
    askpass = root / ASKPASS_NAME
    askpass.write_text(
        '#!/bin/sh\ncase "$1" in\n  Username*) echo "$GIT_USER" ;;\n  *) echo "$GIT_PASS" ;;\nesac\n'
    )
    askpass.chmod(0o700)
    env = {
        **os.environ,
        "GIT_ASKPASS": str(askpass),
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_USER": username,
        "GIT_PASS": password,
    }
    return askpass, env


def prepare_checkout(
    repository: dict[str, Any],
    credentials: dict[str, Any] | None,
    root: Path,
    log: Callable[[str], None] = lambda _message: None,
) -> Path:
    """Working tree checked out at `repository['baseSha']`, created under `root`."""
    clone_url = str(repository.get("cloneUrl") or "").strip()
    base_sha = str(repository.get("baseSha") or "").strip()
    base_ref = str(repository.get("baseRef") or "").strip()
    if not clone_url:
        raise CheckoutError("job repository has no cloneUrl")
    if not base_sha:
        raise CheckoutError("job repository has no baseSha; the server did not pin a commit")

    repo = root / "repo"
    repo.mkdir(parents=True, exist_ok=True)

    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    askpass: Path | None = None
    if credentials and credentials.get("password"):
        askpass, env = write_askpass(root, str(credentials.get("username") or "x-access-token"), str(credentials["password"]))

    try:
        _git(["init", "--quiet"], cwd=repo, env=env)
        _git(["remote", "add", "origin", clone_url], cwd=repo, env=env)

        # Three steps, cheapest first. A server with uploadpack.allowReachableSHA1InWant disabled
        # refuses to fetch a bare SHA, so the branch is fetched instead; a commit older than the
        # shallow window then needs the full history.
        attempts: list[tuple[str, list[str]]] = [
            (f"shallow fetch of {base_sha[:12]}", ["fetch", "--depth=1", "origin", base_sha]),
        ]
        if base_ref:
            attempts.append((f"shallow fetch of {base_ref}", ["fetch", "--depth=50", "origin", base_ref]))
            attempts.append((f"full fetch of {base_ref}", ["fetch", "origin", base_ref]))

        last_error = ""
        fetched = False
        for description, args in attempts:
            result = _run(["git", *args], cwd=repo, env=env)
            if result.returncode == 0:
                fetched = True
                break
            last_error = result.stdout.strip()
            log(f"{description} failed, trying the next strategy: {last_error.splitlines()[-1] if last_error else 'no output'}")
        if not fetched:
            raise CheckoutError(f"could not fetch {base_sha} from the repository: {last_error}")

        _git(["checkout", "--detach", base_sha], cwd=repo, env=env)

        head = _git(["rev-parse", "HEAD"], cwd=repo, env=env).strip()
        if head != base_sha:
            raise CheckoutError(f"checked out {head}, expected {base_sha}")
        log(f"checked out {base_sha[:12]}")
        return repo
    finally:
        # The token must not outlive the clone: the agent runs next, in this very directory.
        if askpass and askpass.exists():
            askpass.unlink()
