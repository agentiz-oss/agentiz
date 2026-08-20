"""Task attachments: lays the files a task carries out on disk for the agent to read.

The job snapshot lists attachments as metadata only (``task.attachments``); the bytes are fetched
through the leased Worker API endpoint one file at a time. Everything lands in one directory
*outside* the working tree — a file inside the checkout would show up in the run's diff as the
agent's own work, and inside a pinned workspace it would fail the next run's clean-tree preflight.

Names are taken from the upload but reduced to safe basenames, with collisions numbered: the agent
should see ``screenshot.png``, not a UUID, because the task text refers to files by their names.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any, Callable, Protocol


class AttachmentClient(Protocol):
    def download_attachment(self, job: dict[str, Any], attachment_id: str, dest: Path) -> bool:
        """Writes the bytes to ``dest``; False means the server no longer has the file (404)."""
        ...


_UNSAFE = re.compile(r"[\x00-\x1f\x7f]")


def sanitize_name(raw: Any) -> str:
    """Basename only, control characters stripped, never empty — mirrors the server's rule."""
    text = str(raw or "").replace("\\", "/").rsplit("/", 1)[-1]
    text = _UNSAFE.sub("", text).strip()
    if not text or text in (".", ".."):
        return "file"
    return text[-200:] if len(text) > 200 else text


def _numbered(name: str, taken: set[str]) -> str:
    if name not in taken:
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    for index in range(2, 1000):
        candidate = f"{stem} ({index}){dot}{ext}" if dot else f"{stem} ({index})"
        if candidate not in taken:
            return candidate
    raise RuntimeError(f"could not find a free name for {name}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_attachments(
    client: AttachmentClient,
    job: dict[str, Any],
    entries: list[Any],
    dest_dir: Path,
    warn: Callable[[str], None],
) -> list[dict[str, Any]]:
    """Downloads every attachment into ``dest_dir`` and returns the local manifest.

    A 404 is a skip with a warning, not a failure: it only happens when somebody deleted the file
    after the job was queued, and stopping the whole run over it would punish the wrong side. A
    hash mismatch *is* a failure — a corrupted download must not be handed to the agent as the
    file the person attached.
    """
    manifest: list[dict[str, Any]] = []
    taken: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("id"):
            continue
        attachment_id = str(entry["id"])
        name = _numbered(sanitize_name(entry.get("fileName")), taken)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / name
        if not client.download_attachment(job, attachment_id, dest):
            warn(f"Файл задачи «{name}» уже удалён на сервере — пропущен")
            dest.unlink(missing_ok=True)
            continue
        expected = str(entry.get("sha256") or "")
        if expected:
            actual = _sha256(dest)
            if actual != expected:
                raise RuntimeError(
                    f"attachment {name} failed integrity check: expected sha256 {expected[:12]}…, got {actual[:12]}…"
                )
        taken.add(name)
        manifest.append({
            "name": name,
            "path": str(dest),
            "sizeBytes": dest.stat().st_size,
            "mimeType": entry.get("mimeType"),
        })
    return manifest
