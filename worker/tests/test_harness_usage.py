from __future__ import annotations

import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from agentiz_worker import harness_usage
from agentiz_worker.harness_usage import UsageReporter, claude_access_token


class ClaudeTokenTest(unittest.TestCase):
    def _write(self, root: Path, oauth: dict) -> None:
        (root / ".credentials.json").write_text(json.dumps({"claudeAiOauth": oauth}))

    def test_reads_a_live_token(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, {"accessToken": " sk-ant-oat-x ", "expiresAt": (time.time() + 3600) * 1000})
            with mock.patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(root)}):
                self.assertEqual(claude_access_token(), "sk-ant-oat-x")

    def test_skips_an_expired_token_instead_of_refreshing_it(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, {"accessToken": "sk-ant-oat-x", "expiresAt": (time.time() - 60) * 1000})
            with mock.patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(root)}):
                self.assertIsNone(claude_access_token())
            # The store the CLI owns is never written by us.
            self.assertEqual(json.loads((root / ".credentials.json").read_text())["claudeAiOauth"]["accessToken"],
                             "sk-ant-oat-x")

    def test_missing_or_broken_profile_is_not_an_error(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(root)}):
                self.assertIsNone(claude_access_token())
                (root / ".credentials.json").write_text("{not json")
                self.assertIsNone(claude_access_token())


class UsageReporterTest(unittest.TestCase):
    def test_sends_what_the_collector_returned_verbatim(self) -> None:
        raw = {"five_hour": {"utilization": 42, "resets_at": "2026-08-18T12:00:00Z"}}
        sent: list[tuple[str, dict]] = []
        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": lambda: raw}, clear=True):
            reporter = UsageReporter(lambda key, payload: sent.append((key, payload)))
            self.assertEqual(reporter.report_once(), 1)
        self.assertEqual(sent, [("claude", raw)])

    def test_a_harness_absent_from_this_machine_reports_nothing(self) -> None:
        sent: list[tuple[str, dict]] = []
        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": lambda: None}, clear=True):
            self.assertEqual(UsageReporter(lambda key, payload: sent.append((key, payload))).report_once(), 0)
        self.assertEqual(sent, [])

    def test_neither_a_broken_collector_nor_a_failing_send_escapes(self) -> None:
        def explode() -> dict:
            raise OSError("no network")

        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": explode}, clear=True):
            self.assertEqual(UsageReporter(lambda key, payload: None).report_once(), 0)

        def refuse(key: str, payload: dict) -> None:
            raise RuntimeError("HTTP 400")

        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": lambda: {"five_hour": {}}}, clear=True):
            self.assertEqual(UsageReporter(refuse).report_once(), 0)


if __name__ == "__main__":
    unittest.main()
