from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agentiz_worker.changes import collect_changes
from agentiz_worker.workspace_git import (
    WorkspaceGitError,
    finalize_action,
    guard_workspace,
    preflight,
    record_tree,
    run_action,
)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.strip()


def fixture(tmp_path: Path) -> tuple[Path, Path]:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(remote)], check=True,
                   stdout=subprocess.DEVNULL)
    repo = tmp_path / "repo"
    git(tmp_path, "clone", str(remote), str(repo))
    git(repo, "config", "user.name", "Agentiz Test")
    git(repo, "config", "user.email", "agentiz@example.test")
    (repo / "README.md").write_text("base\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "base")
    git(repo, "push", "-u", "origin", "main")
    return repo, remote


def marker_path(repo: Path) -> Path:
    """`git rev-parse --git-path` answers relative to the repository, not to this process."""
    return repo / git(repo, "rev-parse", "--git-path", "agentiz-workspace-proposal.json")


def proposal(repo: Path) -> tuple[dict, dict]:
    return ({"id": "proposal-1", "revision": 1, "remote": "origin"},
            {"cloneUrl": git(repo, "remote", "get-url", "origin")})


def test_preflight_stashes_work_the_agent_did_not_do(tmp_path: Path) -> None:
    """The default. Files sitting in the directory when a run starts are not the agent's.

    Refusing over them stopped whole pipelines on something somebody forgot to commit weeks ago,
    and the diff of the run would have claimed them as the agent's work. The stash answers both.
    """
    repo, _ = fixture(tmp_path)
    (repo / "operator.txt").write_text("do not delete")
    (repo / "README.md").write_text("half-finished edit\n")
    prop, repository = proposal(repo)

    report: dict = {}
    _, marker = preflight(repo, prop, repository, report=report)

    assert marker["proposalId"] == "proposal-1"
    assert not (repo / "operator.txt").exists()
    assert (repo / "README.md").read_text() == "base\n"
    assert report["preexisting"]["stashSha"] == git(repo, "rev-parse", "refs/stash")
    git(repo, "stash", "apply", report["preexisting"]["stashSha"])
    assert (repo / "operator.txt").read_text() == "do not delete"


def test_preflight_rejects_dirty_initial_workspace_when_stashing_is_off(tmp_path: Path) -> None:
    repo, _ = fixture(tmp_path)
    (repo / "operator.txt").write_text("do not delete")
    prop, repository = proposal(repo)
    with pytest.raises(WorkspaceGitError, match="must be clean"):
        preflight(repo, prop, repository, stash_dirty=False)
    assert (repo / "operator.txt").read_text() == "do not delete"
    assert git(repo, "stash", "list") == ""


def test_staged_work_is_stashed_too(tmp_path: Path) -> None:
    """`git add` before the run is the same case: the index is not the agent's either."""
    repo, _ = fixture(tmp_path)
    (repo / "staged.txt").write_text("staged\n")
    git(repo, "add", "staged.txt")
    prop, repository = proposal(repo)

    report: dict = {}
    preflight(repo, prop, repository, report=report)

    assert not (repo / "staged.txt").exists()
    assert git(repo, "status", "--porcelain=v1", "--untracked-files=all") == ""
    git(repo, "stash", "apply", report["preexisting"]["stashSha"])
    assert (repo / "staged.txt").read_text() == "staged\n"


def test_preflight_fast_forwards_clean_workspace_to_remote_base(tmp_path: Path) -> None:
    repo, remote = fixture(tmp_path)
    upstream = tmp_path / "upstream"
    git(tmp_path, "clone", str(remote), str(upstream))
    git(upstream, "config", "user.name", "Agentiz Test")
    git(upstream, "config", "user.email", "agentiz@example.test")
    (upstream / "README.md").write_text("base\nremote change\n")
    git(upstream, "add", "README.md")
    git(upstream, "commit", "-m", "advance remote")
    git(upstream, "push", "origin", "main")

    prop, repository = proposal(repo)
    root, marker = preflight(repo, prop, repository)

    assert root == repo.resolve()
    assert marker["baseSha"] == git(remote, "rev-parse", "refs/heads/main")
    assert git(repo, "rev-parse", "HEAD") == marker["baseSha"]
    assert (repo / "README.md").read_text() == "base\nremote change\n"


def test_new_branch_push_restores_original_branch(tmp_path: Path) -> None:
    repo, remote = fixture(tmp_path)
    prop, repository = proposal(repo)
    root, marker = preflight(repo, prop, repository)
    (repo / "README.md").write_text("base\nchange\n")
    changes = collect_changes(repo, marker["baseSha"])
    record_tree(root, marker, changes["treeSha"], 1)
    action = {**prop, **marker, "expectedTreeSha": changes["treeSha"], "targetMode": "new",
              "targetBranch": "agentiz/fix-test7ac1", "commitMessage": "A message with many words"}
    result = run_action(repo, "workspace_commit_push", action, repository)
    assert git(repo, "branch", "--show-current") == "main"
    assert git(remote, "rev-parse", "refs/heads/agentiz/fix-test7ac1") == result["commitSha"]
    # Until the server acknowledges the result, retry reuses the completed marker.
    assert run_action(repo, "workspace_commit_push", action, repository)["commitSha"] == result["commitSha"]
    finalize_action(repo, "proposal-1")
    assert not (repo / ".git" / "agentiz-workspace-proposal.json").exists()


def test_reset_checks_tree_and_preserves_ignored_files(tmp_path: Path) -> None:
    repo, _ = fixture(tmp_path)
    (repo / ".gitignore").write_text(".env\n")
    git(repo, "add", ".gitignore")
    git(repo, "commit", "-m", "ignore env")
    git(repo, "push")
    prop, repository = proposal(repo)
    root, marker = preflight(repo, prop, repository)
    (repo / "README.md").write_text("changed\n")
    (repo / "new.txt").write_text("new\n")
    (repo / ".env").write_text("secret\n")
    changes = collect_changes(repo, marker["baseSha"])
    record_tree(root, marker, changes["treeSha"], 1)
    action = {**prop, **marker, "expectedTreeSha": changes["treeSha"], "targetMode": "current"}
    (repo / "late.txt").write_text("late\n")
    # A commit must still refuse: it would deliver a tree nobody reviewed.
    with pytest.raises(WorkspaceGitError, match="tree changed"):
        run_action(repo, "workspace_commit_push", action, repository)
    # A reset must not. It delivers nothing and stashes whatever it finds, so refusing here would
    # only wedge the directory in `reset_failed` with force as the only way out — and the late file
    # is exactly the kind of thing that must survive the reject.
    result = run_action(repo, "workspace_reset", action, repository)
    finalize_action(repo, "proposal-1")
    assert not (repo / "new.txt").exists()
    assert not (repo / "late.txt").exists()
    assert (repo / ".env").read_text() == "secret\n"
    assert result["stashSha"] == git(repo, "rev-parse", "refs/stash")
    git(repo, "stash", "apply", result["stashSha"])
    assert (repo / "late.txt").read_text() == "late\n"


def test_preflight_refuses_a_marker_of_another_proposal(tmp_path: Path) -> None:
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    preflight(repo, prop, repository)
    with pytest.raises(WorkspaceGitError, match="reserved by proposal proposal-1"):
        preflight(repo, {**prop, "id": "proposal-2"}, repository)


def test_stale_marker_is_dropped_when_the_server_says_nobody_holds_the_directory(tmp_path: Path) -> None:
    """A reservation the server released while this machine was down.

    The marker is only that reservation written where the worker can see it, so once the server
    stops sending a holder the leftover has to go — otherwise a force-released directory stays
    blocked by its own bookkeeping, with no proposal left anywhere to point a person at.
    """
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    preflight(repo, prop, repository)

    _, marker = preflight(repo, {**prop, "id": "proposal-2"}, repository, allow_stale_marker=True)
    assert marker["proposalId"] == "proposal-2"
    # The directory itself is untouched: only a clean checkout gets this far, and the new marker
    # records the same base the old one did.
    assert marker["baseSha"] == git(repo, "rev-parse", "HEAD")


def test_stale_marker_never_costs_uncommitted_work(tmp_path: Path) -> None:
    """The other half of a force-release: whatever the abandoned proposal left behind.

    Dropping the marker alone re-opens the first-run path, which insists on a clean tree — the
    directory would simply fail one message later, and the force-released workspace would still be
    unusable. The leftovers go into a stash under the *old* proposal's name instead.
    """
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    preflight(repo, prop, repository)
    (repo / "agent-output.txt").write_text("work the agent did not get to commit\n")

    report: dict = {}
    _, marker = preflight(repo, {**prop, "id": "proposal-2"}, repository,
                          allow_stale_marker=True, report=report)

    assert marker["proposalId"] == "proposal-2"
    assert not (repo / "agent-output.txt").exists()
    assert report["recovered"]["proposalId"] == "proposal-1"
    assert "proposal-1" in report["recovered"]["stashMessage"]
    git(repo, "stash", "apply", report["recovered"]["stashSha"])
    assert (repo / "agent-output.txt").read_text() == "work the agent did not get to commit\n"


def test_an_unreadable_marker_is_stale_too(tmp_path: Path) -> None:
    """It names no proposal, so nothing can ever match it — refusing to read it means `rm` or nothing."""
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    preflight(repo, prop, repository)
    marker_path(repo).write_text("{ not json")

    with pytest.raises(WorkspaceGitError, match="Invalid Agentiz workspace marker"):
        preflight(repo, prop, repository)
    _, marker = preflight(repo, prop, repository, allow_stale_marker=True)
    assert marker["proposalId"] == "proposal-1"


def test_reset_succeeds_when_the_directory_is_no_longer_held(tmp_path: Path) -> None:
    """Being asked to release a directory this proposal already lost is a success, not a conflict.

    Anything else leaves the reservation with no way down: the reset fails, the proposal parks in
    `reset_failed`, and force is the only exit left.
    """
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    _, marker = preflight(repo, prop, repository)
    action = {**prop, **marker, "expectedTreeSha": None, "targetMode": "current"}
    marker_path(repo).unlink()

    result = run_action(repo, "workspace_reset", action, repository)
    assert "nothing to reset" in result["summary"]
    assert result["stashSha"] is None


def test_reset_ignores_a_remote_that_moved(tmp_path: Path) -> None:
    """A reset is local. Refusing it because somebody repointed `origin` is obstruction."""
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    _, marker = preflight(repo, prop, repository)
    (repo / "new.txt").write_text("new\n")
    action = {**prop, **marker, "expectedTreeSha": None, "targetMode": "current"}
    git(repo, "remote", "set-url", "origin", "https://example.invalid/other/repo.git")

    result = run_action(repo, "workspace_reset", action, repository)
    assert not (repo / "new.txt").exists()
    assert result["stashSha"]


def test_guard_drops_a_stale_marker_for_a_plain_workspace_run(tmp_path: Path) -> None:
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    preflight(repo, prop, repository)

    with pytest.raises(WorkspaceGitError, match="reserved by proposal proposal-1"):
        with guard_workspace(repo):
            pass
    with guard_workspace(repo, None, allow_stale_marker=True) as root:
        assert root == repo.resolve()


def test_reset_stashes_the_work_instead_of_destroying_it(tmp_path: Path) -> None:
    """A reject says "do not commit this", not "this never existed".

    Whoever presses it — or the server, recovering a proposal nobody decided — cannot know whether
    something in the directory was worth keeping, so the reset has to be reversible.
    """
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    root, marker = preflight(repo, prop, repository)
    (repo / "README.md").write_text("changed\n")
    (repo / "new.txt").write_text("new\n")
    changes = collect_changes(repo, marker["baseSha"])
    record_tree(root, marker, changes["treeSha"], 1)
    action = {**prop, **marker, "expectedTreeSha": changes["treeSha"], "targetMode": "current"}

    result = run_action(repo, "workspace_reset", action, repository)
    assert not (repo / "new.txt").exists()
    assert (repo / "README.md").read_text() == "base\n"
    assert f"proposal {prop['id']}" in result["stashMessage"]

    git(repo, "stash", "apply", result["stashSha"])
    assert (repo / "new.txt").read_text() == "new\n"
    assert (repo / "README.md").read_text() == "changed\n"


def test_reset_parks_a_commit_the_agent_made(tmp_path: Path) -> None:
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    root, marker = preflight(repo, prop, repository)
    (repo / "README.md").write_text("committed by the agent\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "agent commit")
    agent_head = git(repo, "rev-parse", "HEAD")
    action = {**prop, **marker, "expectedTreeSha": None, "targetMode": "current"}

    result = run_action(repo, "workspace_reset", action, repository)
    assert git(repo, "rev-parse", "HEAD") == marker["baseSha"]
    # Reachable through a real ref, not just the reflog: gc must not be what decides this.
    assert result["abandonedRef"] == f"refs/agentiz/abandoned/{prop['id']}"
    assert git(repo, "rev-parse", result["abandonedRef"]) == agent_head


def test_reset_reports_no_stash_when_the_directory_is_already_clean(tmp_path: Path) -> None:
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    _, marker = preflight(repo, prop, repository)
    action = {**prop, **marker, "expectedTreeSha": None, "targetMode": "current"}

    result = run_action(repo, "workspace_reset", action, repository)
    assert result["stashSha"] is None
    assert git(repo, "stash", "list") == ""


def test_recovery_also_rewinds_a_commit_the_abandoned_proposal_made(tmp_path: Path) -> None:
    """Otherwise the wall just moves one message along.

    The stash covers the working tree; a commit left on top of it keeps HEAD ahead of the remote,
    and the first-run path below fast-forwards to the remote — which it cannot do from there.
    """
    repo, _ = fixture(tmp_path)
    prop, repository = proposal(repo)
    _, marker = preflight(repo, prop, repository)
    base = marker["baseSha"]
    (repo / "README.md").write_text("agent committed this\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "agent commit")
    agent_head = git(repo, "rev-parse", "HEAD")
    (repo / "left-over.txt").write_text("and left this uncommitted\n")

    report: dict = {}
    _, new_marker = preflight(repo, {**prop, "id": "proposal-2"}, repository,
                              allow_stale_marker=True, report=report)

    assert new_marker["baseSha"] == base
    assert git(repo, "rev-parse", "HEAD") == base
    assert git(repo, "rev-parse", report["recovered"]["abandonedRef"]) == agent_head
    git(repo, "stash", "apply", report["recovered"]["stashSha"])
    assert (repo / "left-over.txt").exists()
