"""Turns what the agent did to the working tree into the contract Agentiz commits from.

Two artefacts come out of the same staged state, and both matter:

* **operations** — what the server actually applies through the platform's REST API;
* **the patch** — the exact record of what the agent did, stored for audit and used as the source
  of truth when the two disagree.

The patch is produced even when it is large: a truncated patch is more useful than none.
"""

from __future__ import annotations

import base64
import hashlib
import subprocess
from pathlib import Path
from typing import Any

DEFAULT_MAX_PATCH_BYTES = 5 * 1024 * 1024
#: Git's own default for a regular file; used when a path has no mode of its own to report.
DEFAULT_MODE = "100644"
KNOWN_MODES = {"100644", "100755", "120000"}


def _git_text(repo: Path, args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args], cwd=str(repo), text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def _git_bytes(repo: Path, args: list[str]) -> bytes:
    result = subprocess.run(
        ["git", *args], cwd=str(repo),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def _mode_of(repo: Path, path: str) -> str | None:
    """Mode as git records it in the index, e.g. `100755` for something the agent made executable."""
    line = _git_text(repo, ["ls-files", "--stage", "--", path]).strip()
    if not line:
        return None
    mode = line.split()[0]
    return mode if mode in KNOWN_MODES else None


def _binary_paths(repo: Path) -> set[str]:
    """Paths git reports as binary — `numstat` prints `-` instead of line counts for those."""
    binary: set[str] = set()
    for line in _git_text(repo, ["diff", "--cached", "--numstat", "-z", "-M"]).split("\0"):
        parts = line.split("\t")
        if len(parts) >= 3 and parts[0] == "-" and parts[1] == "-":
            binary.add(parts[2])
    return binary


def _content(repo: Path, path: str, binary: bool) -> tuple[str, str]:
    """File content as staged, plus the encoding Agentiz should commit it with."""
    raw = _git_bytes(repo, ["show", f":{path}"])
    if binary:
        return base64.b64encode(raw).decode("ascii"), "base64"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        # numstat did not call it binary, but it is not valid UTF-8 either; base64 is lossless.
        return base64.b64encode(raw).decode("ascii"), "base64"


def _upsert(repo: Path, path: str, binary: set[str]) -> dict[str, Any]:
    content, encoding = _content(repo, path, path in binary)
    op: dict[str, Any] = {"op": "upsert", "path": path, "content": content, "encoding": encoding}
    mode = _mode_of(repo, path)
    if mode and mode != DEFAULT_MODE:
        op["mode"] = mode
    return op


def _stats(repo: Path) -> dict[str, int]:
    """`--shortstat` prints e.g. ` 3 files changed, 12 insertions(+), 4 deletions(-)`."""
    line = _git_text(repo, ["diff", "--cached", "--shortstat"]).strip()
    stats = {"files": 0, "insertions": 0, "deletions": 0}
    for part in line.split(","):
        chunk = part.strip().split()
        if len(chunk) < 2:
            continue
        try:
            value = int(chunk[0])
        except ValueError:
            continue
        if chunk[1].startswith("file"):
            stats["files"] = value
        elif chunk[1].startswith("insertion"):
            stats["insertions"] = value
        elif chunk[1].startswith("deletion"):
            stats["deletions"] = value
    return stats


def collect_changes(repo: Path, base_sha: str, max_patch_bytes: int = DEFAULT_MAX_PATCH_BYTES) -> dict[str, Any]:
    """Everything the agent changed, as `{ops, patch, stats, truncated, baseSha}`."""
    # `add -A` stages new, modified and deleted paths alike, which is what makes one `--cached`
    # diff describe the whole working tree instead of only tracked edits.
    _git_text(repo, ["add", "-A"])

    diff_args = ["diff", "--cached", "--binary"] + ([base_sha] if base_sha else [])
    full_patch_bytes = _git_bytes(repo, diff_args)
    patch_size = len(full_patch_bytes)
    patch_hash = hashlib.sha256(full_patch_bytes).hexdigest()
    patch_bytes = full_patch_bytes
    truncated = patch_size > max_patch_bytes
    if truncated:
        patch_bytes = patch_bytes[:max_patch_bytes]
    patch = patch_bytes.decode("utf-8", errors="replace")

    binary = _binary_paths(repo)
    ops: list[dict[str, Any]] = []

    # -z keeps paths with spaces or newlines intact; -M turns a delete+add pair into a rename.
    fields = [field for field in _git_text(repo, ["diff", "--cached", "--name-status", "-z", "-M"]).split("\0") if field != ""]
    index = 0
    while index < len(fields):
        status = fields[index]
        index += 1
        if status.startswith("R") or status.startswith("C"):
            source, target = fields[index], fields[index + 1]
            index += 2
            rename: dict[str, Any] = {"op": "rename", "from": source, "to": target}
            # A pure rename needs no content; git spells "renamed and edited" as R<score<100>.
            score = status[1:]
            if not score.isdigit() or int(score) < 100:
                upsert = _upsert(repo, target, binary)
                rename["content"] = upsert["content"]
                rename["encoding"] = upsert["encoding"]
                if "mode" in upsert:
                    rename["mode"] = upsert["mode"]
            ops.append(rename)
            continue

        path = fields[index]
        index += 1
        if status.startswith("D"):
            ops.append({"op": "delete", "path": path})
        elif status.startswith("T"):
            # Type change (file <-> symlink): expressed as a removal and a fresh entry, because the
            # tree entry's mode changes and providers treat that as a different object.
            ops.append({"op": "delete", "path": path})
            ops.append(_upsert(repo, path, binary))
        else:
            ops.append(_upsert(repo, path, binary))

    tree_sha = _git_text(repo, ["write-tree"]).strip()
    return {"ops": ops, "patch": patch, "patchBase64": base64.b64encode(patch_bytes).decode("ascii"),
            "stats": _stats(repo), "truncated": truncated, "baseSha": base_sha,
            "treeSha": tree_sha, "patchSizeBytes": patch_size, "patchSha256": patch_hash}
