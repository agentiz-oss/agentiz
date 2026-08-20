from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from typing import Any

from agentiz_worker.attachments import download_attachments, sanitize_name


class FakeClient:
    """Answers downloads from a dict; None means "the server no longer has it" (404)."""

    def __init__(self, files: dict[str, bytes | None]):
        self.files = files
        self.calls: list[str] = []

    def download_attachment(self, job: dict[str, Any], attachment_id: str, dest: Path) -> bool:
        self.calls.append(attachment_id)
        content = self.files.get(attachment_id)
        if content is None:
            return False
        dest.write_bytes(content)
        return True


def entry(attachment_id: str, name: str, content: bytes | None = None, **extra: Any) -> dict[str, Any]:
    data: dict[str, Any] = {"id": attachment_id, "fileName": name, **extra}
    if content is not None:
        data["sha256"] = hashlib.sha256(content).hexdigest()
    return data


class SanitizeNameTest(unittest.TestCase):
    def test_keeps_plain_names_and_flattens_paths(self) -> None:
        self.assertEqual(sanitize_name("фото.png"), "фото.png")
        self.assertEqual(sanitize_name("../../etc/passwd"), "passwd")
        self.assertEqual(sanitize_name("C:\\Users\\x\\report.pdf"), "report.pdf")
        self.assertEqual(sanitize_name(""), "file")
        self.assertEqual(sanitize_name(".."), "file")
        self.assertEqual(sanitize_name("a\x00b\x1f.txt"), "ab.txt")


class DownloadAttachmentsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dest = Path(self.tmp.name) / "task-files"
        self.job = {"jobId": "j1", "attempt": 1, "leaseToken": "t"}
        self.warnings: list[str] = []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def download(self, client: FakeClient, entries: list[Any]) -> list[dict[str, Any]]:
        return download_attachments(client, self.job, entries, self.dest, self.warnings.append)

    def test_lays_files_out_under_their_names_and_reports_paths(self) -> None:
        client = FakeClient({"a1": b"png-bytes", "a2": b"text"})
        manifest = self.download(client, [
            entry("a1", "screen.png", b"png-bytes", mimeType="image/png"),
            entry("a2", "notes.txt", b"text"),
        ])
        self.assertEqual([item["name"] for item in manifest], ["screen.png", "notes.txt"])
        self.assertEqual((self.dest / "screen.png").read_bytes(), b"png-bytes")
        self.assertEqual(manifest[0]["mimeType"], "image/png")
        self.assertEqual(manifest[0]["path"], str(self.dest / "screen.png"))
        self.assertEqual(self.warnings, [])

    def test_name_collisions_are_numbered_not_overwritten(self) -> None:
        client = FakeClient({"a1": b"one", "a2": b"two"})
        manifest = self.download(client, [
            entry("a1", "shot.png", b"one"),
            entry("a2", "shot.png", b"two"),
        ])
        self.assertEqual([item["name"] for item in manifest], ["shot.png", "shot (2).png"])
        self.assertEqual((self.dest / "shot (2).png").read_bytes(), b"two")

    def test_a_deleted_attachment_is_skipped_with_a_warning(self) -> None:
        client = FakeClient({"a1": None, "a2": b"kept"})
        manifest = self.download(client, [
            entry("a1", "gone.pdf"),
            entry("a2", "kept.txt", b"kept"),
        ])
        self.assertEqual([item["name"] for item in manifest], ["kept.txt"])
        self.assertEqual(len(self.warnings), 1)
        self.assertIn("gone.pdf", self.warnings[0])
        self.assertFalse((self.dest / "gone.pdf").exists())

    def test_a_corrupted_download_fails_the_run(self) -> None:
        client = FakeClient({"a1": b"actual-bytes"})
        with self.assertRaises(RuntimeError):
            self.download(client, [entry("a1", "data.bin", b"expected-bytes")])

    def test_malformed_entries_are_ignored(self) -> None:
        client = FakeClient({})
        manifest = self.download(client, ["junk", {}, {"fileName": "no-id.txt"}])
        self.assertEqual(manifest, [])
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
