"""Safe Git delivery for a prepared worker workspace.

The server stores and approves a tree hash; this module only commits, pushes or resets when the
same checkout still has that exact tree. Credentials remain whatever the machine's Git already
uses. No command uses a shell, force push, or ``git clean -x``.
"""

from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any, Iterator
from urllib.parse import urlsplit, urlunsplit


class WorkspaceGitError(RuntimeError):
    pass


def _git(repo: Path, args: list[str], check: bool = True) -> str:
    result = subprocess.run(["git", *args], cwd=str(repo), text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, check=False, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    if check and result.returncode:
        raise WorkspaceGitError(f"git {' '.join(args)} failed: {redact_git_output(result.stdout).strip()}")
    return result.stdout.strip()


def redact_git_output(value: str) -> str:
    return re.sub(r"(https?://)[^/@\s]+@", r"\1", value)


def safe_remote_url(value: str) -> str:
    value = value.strip()
    if value.startswith(("http://", "https://")):
        parts = urlsplit(value)
        host = parts.hostname or ""
        if parts.port:
            host = f"{host}:{parts.port}"
        return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))
    return redact_git_output(value)


def _remote_identity(value: str) -> str:
    clean = safe_remote_url(value).removesuffix(".git").rstrip("/")
    if re.match(r"^[^/@:]+@[^:]+:", clean):
        user_host, path = clean.split(":", 1)
        return f"{user_host.split('@', 1)[1].lower()}/{path.lstrip('/')}"
    if "://" in clean:
        parts = urlsplit(clean)
        return f"{(parts.hostname or '').lower()}/{parts.path.lstrip('/')}"
    return clean.lower()


def _marker_path(root: Path) -> Path:
    return Path(_git(root, ["rev-parse", "--git-path", "agentiz-workspace-proposal.json"]))


def _load_marker(root: Path) -> dict[str, Any] | None:
    path = _marker_path(root)
    if not path.is_absolute():
        path = root / path
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise WorkspaceGitError(f"Invalid Agentiz workspace marker {path}: {error}") from error


def _save_marker(root: Path, marker: dict[str, Any]) -> None:
    path = _marker_path(root)
    if not path.is_absolute():
        path = root / path
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(marker, indent=2) + "\n")
    temporary.replace(path)


def _remove_marker(root: Path) -> None:
    path = _marker_path(root)
    if not path.is_absolute():
        path = root / path
    path.unlink(missing_ok=True)


@contextmanager
def workspace_lock(path: Path) -> Iterator[Path]:
    root_text = _git(path, ["rev-parse", "--show-toplevel"])
    root = Path(root_text).resolve()
    lock_path = Path(_git(root, ["rev-parse", "--git-path", "agentiz-workspace.lock"]))
    if not lock_path.is_absolute():
        lock_path = root / lock_path
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise WorkspaceGitError(f"Workspace {root} is already in use by another worker process") from error
        yield root


@contextmanager
def guard_workspace(path: Path, proposal_id: str | None = None) -> Iterator[Path]:
    """Lock a Git workspace for one process and enforce any persistent proposal marker.

    Non-Git prepared directories keep their historical behaviour and simply pass through.
    """
    probe = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(path), text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    if probe.returncode:
        yield path
        return
    with workspace_lock(Path(probe.stdout.strip())) as root:
        marker = _load_marker(root)
        if marker and marker.get("proposalId") != proposal_id:
            raise WorkspaceGitError(f"Workspace is reserved by proposal {marker.get('proposalId')}")
        yield root


def _ls_remote(root: Path, remote: str, branch: str) -> str | None:
    line = _git(root, ["ls-remote", "--heads", remote, f"refs/heads/{branch}"])
    return line.split()[0] if line else None


def _verify_remote(root: Path, remote: str, expected_url: str) -> str:
    """The remote this checkout pushes to, cross-checked against `expected_url` when there is one.

    A pipeline may pin a hosted repository, and then the URLs have to agree. A plain worker directory
    pins nothing: the remote configured in the checkout is the only statement of where it pushes, so
    it is recorded rather than compared. Either way the caller gets the URL that will actually be used.
    """
    actual = _git(root, ["remote", "get-url", remote])
    if not actual:
        raise WorkspaceGitError(f"Git remote {remote!r} has no URL")
    if expected_url and _remote_identity(actual) != _remote_identity(expected_url):
        raise WorkspaceGitError(f"Workspace remote {safe_remote_url(actual)} does not match repository {safe_remote_url(expected_url)}")
    return safe_remote_url(actual)


def preflight(path: Path, proposal: dict[str, Any], repository: dict[str, Any] | None) -> tuple[Path, dict[str, Any]]:
    """Reserve/check a checkout before an agent is allowed to touch it."""
    root = Path(_git(path, ["rev-parse", "--show-toplevel"])).resolve()
    proposal_id = str(proposal.get("id") or "")
    revision = int(proposal.get("revision") or 0)
    # Empty when the pipeline pinned no repository: the checkout's own remote decides. See _verify_remote.
    expected_url = str((repository or {}).get("cloneUrl") or "")
    remote = str(proposal.get("remote") or "origin")
    if not proposal_id or revision < 1:
        raise WorkspaceGitError("Workspace Git job is missing proposal identity")
    marker = _load_marker(root)
    if marker is None:
        dirty = _git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
        if dirty:
            raise WorkspaceGitError("Managed workspace must be clean before the first proposal run")
        base_sha = _git(root, ["rev-parse", "HEAD"])
        try:
            base_branch = _git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        except WorkspaceGitError as error:
            raise WorkspaceGitError("Managed workspace must start on a branch, not detached HEAD") from error
        remote_url = _verify_remote(root, remote, expected_url)
        remote_sha = _ls_remote(root, remote, base_branch)
        if not remote_sha or remote_sha != base_sha:
            raise WorkspaceGitError(f"Local HEAD {base_sha[:12]} is not the current {remote}/{base_branch} base")
        marker = {"proposalId": proposal_id, "baseSha": base_sha, "baseBranch": base_branch,
                  "remote": remote, "remoteUrl": remote_url, "remoteBaseSha": remote_sha,
                  "revision": revision, "treeSha": _git(root, ["write-tree"]), "commitSha": None}
        _save_marker(root, marker)
    else:
        if marker.get("proposalId") != proposal_id:
            raise WorkspaceGitError(f"Workspace is reserved by proposal {marker.get('proposalId')}")
        if proposal.get("baseSha") and marker.get("baseSha") != proposal.get("baseSha"):
            raise WorkspaceGitError("Workspace marker base SHA does not match the proposal")
        if _git(root, ["rev-parse", "HEAD"]) != marker.get("baseSha"):
            raise WorkspaceGitError("Workspace HEAD changed after the proposal started")
        _verify_remote(root, remote, expected_url)
        _git(root, ["add", "-A"])
        current_tree = _git(root, ["write-tree"])
        if proposal.get("expectedTreeSha") and current_tree != proposal.get("expectedTreeSha"):
            raise WorkspaceGitError("Workspace tree changed after the last reviewed revision")
        marker.update({"revision": revision, "treeSha": current_tree})
        _save_marker(root, marker)
    return root, marker


def record_tree(root: Path, marker: dict[str, Any], tree_sha: str, revision: int) -> None:
    marker.update({"treeSha": tree_sha, "revision": revision})
    _save_marker(root, marker)


def finalize_action(path: Path, proposal_id: str) -> None:
    """Drop the durable marker only after Agentiz acknowledged the terminal action result."""
    root = Path(_git(path, ["rev-parse", "--show-toplevel"])).resolve()
    marker = _load_marker(root)
    if marker and marker.get("proposalId") == proposal_id and marker.get("actionCompleted"):
        _remove_marker(root)


def run_action(path: Path, job_kind: str, proposal: dict[str, Any], repository: dict[str, Any] | None) -> dict[str, Any]:
    with workspace_lock(path) as root:
        marker = _load_marker(root)
        if not marker or marker.get("proposalId") != proposal.get("id"):
            raise WorkspaceGitError("Workspace proposal marker is missing or belongs to another proposal")
        if marker.get("baseSha") != proposal.get("baseSha"):
            raise WorkspaceGitError("Workspace base SHA no longer matches the reviewed proposal")
        _verify_remote(root, str(proposal.get("remote") or "origin"), str((repository or {}).get("cloneUrl") or ""))
        if marker.get("actionCompleted") == "reset" and job_kind == "workspace_reset":
            return {"summary": f"Workspace reset to {str(marker['baseSha'])[:12]}"}
        if marker.get("actionCompleted") == "push" and job_kind == "workspace_commit_push":
            commit_sha = str(marker.get("commitSha") or "")
            target = str(marker.get("targetBranch") or "")
            if not commit_sha or _ls_remote(root, str(proposal.get("remote") or "origin"), target) != commit_sha:
                raise WorkspaceGitError("Marker says push completed, but the remote branch does not contain that commit")
            return {"summary": f"Pushed {commit_sha[:12]} to {target}", "commitSha": commit_sha, "targetBranch": target}
        _git(root, ["add", "-A"])
        tree_sha = _git(root, ["write-tree"])
        if tree_sha != proposal.get("expectedTreeSha"):
            raise WorkspaceGitError("Workspace tree changed after review; refusing a destructive Git action")

        if job_kind == "workspace_reset":
            base_sha = str(proposal["baseSha"])
            base_branch = str(proposal["baseBranch"])
            if _git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) != base_branch:
                _git(root, ["checkout", "-f", base_branch])
            _git(root, ["reset", "--hard", base_sha])
            _git(root, ["clean", "-fd"])
            marker["actionCompleted"] = "reset"
            _save_marker(root, marker)
            return {"summary": f"Workspace reset to {base_sha[:12]}"}

        if job_kind != "workspace_commit_push":
            raise WorkspaceGitError(f"Unknown workspace action {job_kind}")
        remote = str(proposal.get("remote") or "origin")
        mode = str(proposal.get("targetMode") or "current")
        target = str(proposal.get("targetBranch") or proposal.get("baseBranch") or "")
        commit_sha = marker.get("commitSha")
        if commit_sha:
            if _git(root, ["rev-parse", "HEAD"]) != commit_sha:
                raise WorkspaceGitError("Marker records a commit but workspace HEAD differs")
        else:
            if _git(root, ["rev-parse", "HEAD"]) != proposal.get("baseSha"):
                raise WorkspaceGitError("Workspace HEAD is not the proposal base")
            remote_base = _ls_remote(root, remote, str(proposal.get("baseBranch")))
            if remote_base != proposal.get("remoteBaseSha"):
                raise WorkspaceGitError("Remote base branch moved since the reviewed diff")
            if mode == "new":
                if not target:
                    raise WorkspaceGitError("New target branch is empty")
                if _ls_remote(root, remote, target):
                    raise WorkspaceGitError(f"Target branch {target} already exists")
                _git(root, ["checkout", "-b", target, str(proposal["baseSha"])])
            elif _git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) != proposal.get("baseBranch"):
                raise WorkspaceGitError("Current-branch delivery is no longer on the original branch")
            _git(root, ["commit", "-m", str(proposal.get("commitMessage") or "Agentiz change")])
            commit_sha = _git(root, ["rev-parse", "HEAD"])
            marker["commitSha"] = commit_sha
            marker["targetBranch"] = target
            _save_marker(root, marker)

        destination = target if mode == "new" else str(proposal.get("baseBranch"))
        args = ["push"] + (["-u"] if mode == "new" else []) + [remote, f"HEAD:refs/heads/{destination}"]
        _git(root, args)
        if mode == "new":
            _git(root, ["checkout", "-f", str(proposal.get("baseBranch"))])
        marker["actionCompleted"] = "push"
        marker["targetBranch"] = destination
        _save_marker(root, marker)
        return {"summary": f"Pushed {commit_sha[:12]} to {remote}/{destination}",
                "commitSha": commit_sha, "targetBranch": destination}
