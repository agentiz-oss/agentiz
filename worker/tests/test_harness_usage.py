from __future__ import annotations

import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from agentiz_worker import harness_usage
from agentiz_worker.harness_usage import UsageReporter, claude_access_token


class _FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._body = json.dumps(payload).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def _fake_urlopen(payload: dict):
    def opener(request, timeout=None):
        return _FakeResponse(payload)
    return opener


class ClaudeTokenTest(unittest.TestCase):
    def _write(self, root: Path, oauth: dict) -> None:
        (root / ".credentials.json").write_text(json.dumps({"claudeAiOauth": oauth}))

    def test_reads_a_live_token(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, {"accessToken": " sk-ant-oat-x ", "expiresAt": (time.time() + 3600) * 1000})
            with mock.patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(root)}):
                self.assertEqual(claude_access_token(), "sk-ant-oat-x")

    def test_refreshes_an_expired_token_and_stores_the_result(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, {"accessToken": "old", "refreshToken": "r-old", "expiresAt": 1000,
                               "scopes": ["user:inference"], "subscriptionType": "pro"})
            payload = {"access_token": "new", "refresh_token": "r-new", "expires_in": 3600,
                       "scope": "user:inference user:profile"}
            with mock.patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(root)}), \
                    mock.patch.object(harness_usage, "urlopen", _fake_urlopen(payload)):
                self.assertEqual(claude_access_token(), "new")
            stored = json.loads((root / ".credentials.json").read_text())["claudeAiOauth"]
            self.assertEqual(stored["accessToken"], "new")
            # A rotated refresh token must land on disk, or the CLI is logged out.
            self.assertEqual(stored["refreshToken"], "r-new")
            self.assertGreater(stored["expiresAt"] / 1000, time.time())
            self.assertEqual(stored["scopes"], ["user:inference", "user:profile"])
            # Fields the response says nothing about are preserved.
            self.assertEqual(stored["subscriptionType"], "pro")

    def test_a_live_token_is_not_refreshed(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, {"accessToken": "live", "refreshToken": "r",
                               "expiresAt": (time.time() + 3600) * 1000})
            def explode(*args, **kwargs):
                raise AssertionError("refresh must not be attempted for a live token")
            with mock.patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(root)}), \
                    mock.patch.object(harness_usage, "urlopen", explode):
                self.assertEqual(claude_access_token(), "live")

    def test_a_concurrent_cli_refresh_wins_over_ours(self) -> None:
        """The CLI owns this store: if it refreshed while we were in flight, its result stands."""
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, {"accessToken": "old", "refreshToken": "r-old", "expiresAt": 1000})

            def cli_refreshes_first(request, timeout=None):
                self._write(root, {"accessToken": "from-cli", "refreshToken": "r-cli",
                                   "expiresAt": (time.time() + 3600) * 1000})
                return _fake_urlopen({"access_token": "ours", "refresh_token": "r-ours",
                                      "expires_in": 3600})(request, timeout=timeout)

            with mock.patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(root)}), \
                    mock.patch.object(harness_usage, "urlopen", cli_refreshes_first):
                self.assertEqual(claude_access_token(), "from-cli")
            stored = json.loads((root / ".credentials.json").read_text())["claudeAiOauth"]
            self.assertEqual(stored["refreshToken"], "r-cli")

    def test_refresh_can_be_switched_off(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, {"accessToken": "old", "refreshToken": "r", "expiresAt": 1000})
            with mock.patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(root),
                                                "AGENTIZ_CLAUDE_TOKEN_REFRESH": "0"}):
                self.assertIsNone(claude_access_token())

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
