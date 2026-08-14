from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agentiz_worker.changes import collect_changes
from agentiz_worker.workspace_git import WorkspaceGitError, finalize_action, preflight, record_tree, run_action


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


def proposal(repo: Path) -> tuple[dict, dict]:
    return ({"id": "proposal-1", "revision": 1, "remote": "origin"},
            {"cloneUrl": git(repo, "remote", "get-url", "origin")})


def test_preflight_rejects_dirty_initial_workspace(tmp_path: Path) -> None:
    repo, _ = fixture(tmp_path)
    (repo / "operator.txt").write_text("do not delete")
    prop, repository = proposal(repo)
    with pytest.raises(WorkspaceGitError, match="must be clean"):
        preflight(repo, prop, repository)
    assert (repo / "operator.txt").read_text() == "do not delete"


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
    with pytest.raises(WorkspaceGitError, match="tree changed"):
        run_action(repo, "workspace_reset", action, repository)
    (repo / "late.txt").unlink()
    run_action(repo, "workspace_reset", action, repository)
    finalize_action(repo, "proposal-1")
    assert not (repo / "new.txt").exists()
    assert (repo / ".env").read_text() == "secret\n"
