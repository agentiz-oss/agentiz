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


def _recover_stale_marker(root: Path, proposal_id: str | None, allow_stale: bool,
                          report: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Clears a marker left by a proposal the server no longer knows about, keeping its work.

    The marker is only the server's reservation written where this process can see it, so the
    server decides it is stale: `allowStaleMarker` in the job means nothing holds this directory
    any more. Without this, a reservation released while the worker was down would keep blocking
    the path forever, with no proposal left anywhere to point a person at.

    Three things have to go right for that to be a real exit rather than a different wall:

    - a marker that cannot be parsed is stale too. It names no proposal, so nothing can ever match
      it, and refusing to read it would leave `rm` as the only way out;
    - whatever the abandoned proposal left in the directory goes into a stash under *its* name, not
      into the next run's diff and not into the bin. The first-run path insists on a clean tree, so
      without this the directory would simply fail one message later;
    - the stash is reported back through `report`, so the server can write the sha onto the
      proposal it belonged to. A stash nobody can name is barely better than a deletion.
    """
    try:
        marker = _load_marker(root)
    except WorkspaceGitError:
        if not allow_stale:
            raise
        _remove_marker(root)
        if report is not None:
            report["recovered"] = {"proposalId": None, **(_stash_workspace(root, {}) or {})}
        return None
    if not marker or marker.get("proposalId") == proposal_id:
        return marker
    if not allow_stale:
        raise WorkspaceGitError(f"Workspace is reserved by proposal {marker.get('proposalId')}")
    stale_id = str(marker.get("proposalId") or "unknown")
    stash = _stash_workspace(root, {"id": marker.get("proposalId"), "revision": marker.get("revision")})
    # The commits too, and for the same reason the reset does it: a stash covers the working tree
    # only, and leaving HEAD ahead of the remote would just move the wall one message along — the
    # first-run path below fast-forwards to the remote and cannot do that from a diverged HEAD.
    abandoned = None
    head = _git(root, ["rev-parse", "HEAD"])
    base_sha = str(marker.get("baseSha") or "")
    if base_sha and head != base_sha and _git(root, ["cat-file", "-e", f"{base_sha}^{{commit}}"], check=False) == "":
        abandoned = _keep_abandoned_commits(root, stale_id, head, base_sha)
        _git(root, ["reset", "--hard", base_sha])
    _remove_marker(root)
    if report is not None:
        report["recovered"] = {"proposalId": marker.get("proposalId"), "abandonedRef": abandoned, **(stash or {})}
    return None


@contextmanager
def guard_workspace(path: Path, proposal_id: str | None = None, allow_stale_marker: bool = False,
                    report: dict[str, Any] | None = None) -> Iterator[Path]:
    """Lock a Git workspace for one process and enforce any persistent proposal marker.

    Non-Git prepared directories keep their historical behaviour and simply pass through.
    """
    probe = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(path), text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    if probe.returncode:
        yield path
        return
    with workspace_lock(Path(probe.stdout.strip())) as root:
        _recover_stale_marker(root, proposal_id, allow_stale_marker, report)
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


def preflight(path: Path, proposal: dict[str, Any], repository: dict[str, Any] | None,
              allow_stale_marker: bool = False,
              report: dict[str, Any] | None = None,
              stash_dirty: bool = True) -> tuple[Path, dict[str, Any]]:
    """Reserve/check a checkout before an agent is allowed to touch it."""
    root = Path(_git(path, ["rev-parse", "--show-toplevel"])).resolve()
    proposal_id = str(proposal.get("id") or "")
    revision = int(proposal.get("revision") or 0)
    # Empty when the pipeline pinned no repository: the checkout's own remote decides. See _verify_remote.
    expected_url = str((repository or {}).get("cloneUrl") or "")
    remote = str(proposal.get("remote") or "origin")
    if not proposal_id or revision < 1:
        raise WorkspaceGitError("Workspace Git job is missing proposal identity")
    marker = _recover_stale_marker(root, proposal_id, allow_stale_marker, report)
    if marker is None:
        dirty = _git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
        if dirty and stash_dirty:
            # Not the agent's work — it was here before the run started. Refusing over it used to
            # stop the whole pipeline on a file somebody forgot to commit weeks ago; the stash keeps
            # it intact and reports where it went, which answers the same worry without the wall.
            preexisting = _stash_workspace(root, {"id": f"pre-existing before {proposal_id}"})
            if report is not None and preexisting:
                report["preexisting"] = preexisting
        elif dirty:
            raise WorkspaceGitError(
                "Managed workspace must be clean before the first proposal run"
                " (set source.workspace.stashDirty to stash it instead)",
            )
        base_sha = _git(root, ["rev-parse", "HEAD"])
        try:
            base_branch = _git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        except WorkspaceGitError as error:
            raise WorkspaceGitError("Managed workspace must start on a branch, not detached HEAD") from error
        remote_url = _verify_remote(root, remote, expected_url)
        remote_sha = _ls_remote(root, remote, base_branch)
        if not remote_sha:
            raise WorkspaceGitError(f"Local HEAD {base_sha[:12]} is not the current {remote}/{base_branch} base")
        if remote_sha != base_sha:
            # A declared worker workspace is maintained outside Agentiz, but a clean checkout
            # can safely advance to its branch tip.  Never reset: a local commit that is ahead
            # of or diverges from the remote must remain visible to its owner.
            _git(root, ["fetch", "--no-tags", remote, f"refs/heads/{base_branch}"])
            _git(root, ["merge", "--ff-only", "FETCH_HEAD"])
            base_sha = _git(root, ["rev-parse", "HEAD"])
            remote_sha = _ls_remote(root, remote, base_branch)
        if remote_sha != base_sha:
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


def _stash_identity(root: Path) -> list[str]:
    """`git stash` writes commit objects, so it needs an identity the plain reset never did.

    Only supplied when the checkout has none: overriding a configured one would put Agentiz's name
    on a stash of somebody else's work.
    """
    if _git(root, ["config", "user.email"], check=False) and _git(root, ["config", "user.name"], check=False):
        return []
    return ["-c", "user.name=Agentiz", "-c", "user.email=agentiz@localhost"]


def _stash_workspace(root: Path, proposal: dict[str, Any]) -> dict[str, Any] | None:
    """Puts everything the agent left in the directory into a stash instead of deleting it.

    A reject is a verdict on a *proposal*, not on the files: whoever pressed it is saying "do not
    commit this", and had no way to know whether something in there is worth keeping. The stash is
    what makes that decision reversible — and what lets the server queue a reset on its own (a
    cancelled run, a stranded proposal) without asking anyone first.

    Ignored files stay where they are, exactly as `git clean -fd` left them before.
    """
    if not _git(root, ["status", "--porcelain=v1", "--untracked-files=all"]):
        return None
    # The server can spell this label without asking the worker, which is what makes a stash
    # findable (`git stash list`) even when the sha never made it back — an unreadable marker
    # leaves no proposal id, and only then does the label fall back to the time.
    name = proposal.get("id") or "unknown"
    revision = proposal.get("revision")
    label = f"agentiz: proposal {name}" + (f" revision {revision}" if revision else "")
    _git(root, [*_stash_identity(root), "stash", "push", "--include-untracked", "--message", label])
    # The stash *commit*, not `stash@{0}`: the positional name shifts under the next stash, and this
    # sha stays valid for `git stash apply` even after the entry is dropped.
    return {"stashSha": _git(root, ["rev-parse", "refs/stash"]), "stashMessage": label}


def _keep_abandoned_commits(root: Path, proposal_id: str, head: str, base_sha: str) -> str | None:
    """Parks HEAD under `refs/agentiz/abandoned/` when the agent committed before the reject.

    A stash covers the working tree only. Resetting over a commit would leave it reachable through
    the reflog alone — until gc, which is not a promise worth making about someone's work.
    """
    if head == base_sha:
        return None
    ref = f"refs/agentiz/abandoned/{proposal_id}"
    _git(root, ["update-ref", ref, head])
    return ref


def run_action(path: Path, job_kind: str, proposal: dict[str, Any], repository: dict[str, Any] | None) -> dict[str, Any]:
    with workspace_lock(path) as root:
        # A reset that cannot run is a reservation that cannot be released, so every check below
        # asks whether it applies to a *reset* before it refuses one. A reset is local, reversible
        # and idempotent: it pushes nothing, it stashes before it touches anything, and being asked
        # to release a directory this proposal no longer holds is a success, not a conflict.
        try:
            marker = _load_marker(root)
        except WorkspaceGitError:
            if job_kind != "workspace_reset":
                raise
            marker = None
        if not marker or marker.get("proposalId") != proposal.get("id"):
            if job_kind == "workspace_reset":
                return {"summary": "Workspace is no longer held by this proposal; nothing to reset",
                        "stashSha": None, "stashMessage": None, "abandonedRef": None}
            raise WorkspaceGitError("Workspace proposal marker is missing or belongs to another proposal")
        if job_kind != "workspace_reset":
            if marker.get("baseSha") != proposal.get("baseSha"):
                raise WorkspaceGitError("Workspace base SHA no longer matches the reviewed proposal")
            # Local-only: a reset neither reads nor writes the remote, and refusing to restore a
            # directory because somebody repointed `origin` would be obstruction, not safety.
            _verify_remote(root, str(proposal.get("remote") or "origin"), str((repository or {}).get("cloneUrl") or ""))
        if marker.get("actionCompleted") == "reset" and job_kind == "workspace_reset":
            stash = marker.get("stash") or {}
            return {
                "summary": f"Workspace reset to {str(marker['baseSha'])[:12]}",
                "stashSha": stash.get("stashSha"),
                "stashMessage": stash.get("stashMessage"),
            }
        if marker.get("actionCompleted") == "push" and job_kind == "workspace_commit_push":
            commit_sha = str(marker.get("commitSha") or "")
            target = str(marker.get("targetBranch") or "")
            if not commit_sha or _ls_remote(root, str(proposal.get("remote") or "origin"), target) != commit_sha:
                raise WorkspaceGitError("Marker says push completed, but the remote branch does not contain that commit")
            return {"summary": f"Pushed {commit_sha[:12]} to {target}", "commitSha": commit_sha, "targetBranch": target}
        _git(root, ["add", "-A"])
        tree_sha = _git(root, ["write-tree"])
        expected_tree = proposal.get("expectedTreeSha")
        if job_kind == "workspace_reset":
            # Deliberately unchecked. This check exists so a commit cannot deliver something nobody
            # reviewed; a reset delivers nothing and stashes whatever it finds, so a tree that moved
            # after review is a reason to save more, never a reason to refuse and wedge the
            # directory in `reset_failed` with force as the only way out.
            pass
        elif expected_tree:
            if tree_sha != expected_tree:
                raise WorkspaceGitError("Workspace tree changed after review; refusing a destructive Git action")
        else:
            # A run that never reported a diff leaves no reviewed tree. A commit must not invent an
            # approval, but a reset is the operator discarding the directory on purpose — refusing it
            # would wedge the workspace for good, since the reservation is released only when a reset
            # completes (`AgentWorkerApiService`, proposal status "rejected").
            raise WorkspaceGitError("Workspace proposal has no reviewed tree; commit/push is blocked")

        if job_kind == "workspace_reset":
            # The marker over the proposal: it records what this checkout actually started from, and
            # the two differ exactly when the database and the disk disagree — the case where
            # trusting the database would move a directory somewhere it has never been.
            base_sha = str(marker.get("baseSha") or proposal["baseSha"])
            base_branch = str(marker.get("baseBranch") or proposal["baseBranch"])
            # Before anything moves: the stash has to be taken on the branch the work was done on.
            stash = _stash_workspace(root, proposal)
            abandoned = _keep_abandoned_commits(
                root, str(proposal.get("id")), _git(root, ["rev-parse", "HEAD"]), base_sha,
            )
            if _git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) != base_branch:
                _git(root, ["checkout", "-f", base_branch])
            _git(root, ["reset", "--hard", base_sha])
            # Still needed after a stash: empty directories and anything `stash push` declined.
            _git(root, ["clean", "-fd"])
            marker["actionCompleted"] = "reset"
            if stash:
                marker["stash"] = stash
            _save_marker(root, marker)
            kept = []
            if stash:
                kept.append(f"stash {stash['stashSha'][:12]}")
            if abandoned:
                kept.append(abandoned)
            summary = f"Workspace reset to {base_sha[:12]}"
            if kept:
                summary += f"; work kept as {', '.join(kept)}"
            return {
                "summary": summary,
                "stashSha": stash["stashSha"] if stash else None,
                "stashMessage": stash["stashMessage"] if stash else None,
                "abandonedRef": abandoned,
            }

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
