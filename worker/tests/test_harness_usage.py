from __future__ import annotations

import json
import subprocess
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from agentiz_worker import harness_usage, main
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
            reporter = UsageReporter(lambda key, payload, poke=None: sent.append((key, payload, poke)))
            self.assertEqual(reporter.report_once(), 1)
        # No poke has happened, so the body is what it always was — an older server sees no change.
        self.assertEqual(sent, [("claude", raw, None)])

    def test_a_harness_absent_from_this_machine_reports_nothing(self) -> None:
        sent: list[tuple[str, dict]] = []
        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": lambda: None}, clear=True):
            self.assertEqual(UsageReporter(lambda key, payload, poke=None: sent.append((key, payload))).report_once(), 0)
        self.assertEqual(sent, [])

    def test_starting_the_loop_reports_once_immediately(self) -> None:
        """main() starts the thread instead of also calling report_once — one report, not two."""
        sent: list[tuple[str, dict]] = []
        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": lambda: {"five_hour": {}}}, clear=True):
            reporter = UsageReporter(lambda key, payload, poke=None: sent.append((key, payload)), interval_sec=3600)
            reporter.start()
            for _ in range(50):
                if sent:
                    break
                time.sleep(0.01)
            reporter.stop()
        self.assertEqual(len(sent), 1)

    def test_neither_a_broken_collector_nor_a_failing_send_escapes(self) -> None:
        def explode() -> dict:
            raise OSError("no network")

        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": explode}, clear=True):
            self.assertEqual(UsageReporter(lambda key, payload, poke=None: None).report_once(), 0)

        def refuse(key: str, payload: dict, poke: dict | None = None) -> None:
            raise RuntimeError("HTTP 400")

        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": lambda: {"five_hour": {}}}, clear=True):
            self.assertEqual(UsageReporter(refuse).report_once(), 0)


class PokeReportingTest(unittest.TestCase):
    """A poke the server asked for is answered on the next report — otherwise its failure lives in
    this machine's journal and the server goes on believing the request was carried out."""

    def _reporter(self, sent: list, open_window: bool = True) -> UsageReporter:
        def send(key: str, payload: dict, poke: dict | None = None) -> dict:
            sent.append((key, payload, poke))
            return {"openWindow": open_window}

        return UsageReporter(send)

    def test_a_failed_poke_travels_with_the_following_report(self) -> None:
        sent: list = []
        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": lambda: {"five_hour": {}}}, clear=True), \
                mock.patch.dict(harness_usage.POKERS,
                                {"claude": lambda: harness_usage.PokeOutcome(False, "no claude CLI found")},
                                clear=True):
            reporter = self._reporter(sent)
            reporter.report_once()   # asks for the poke, which fails: nothing to re-report yet
            reporter.report_once()   # …so the outcome rides this one
        self.assertIsNone(sent[0][2])
        self.assertEqual(sent[1][2]["ok"], False)
        self.assertEqual(sent[1][2]["error"], "no claude CLI found")
        self.assertTrue(sent[1][2]["at"].endswith("Z"))

    def test_a_successful_poke_is_reported_with_its_own_re_report(self) -> None:
        sent: list = []
        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": lambda: {"five_hour": {}}}, clear=True), \
                mock.patch.dict(harness_usage.POKERS, {"claude": lambda: harness_usage.PokeOutcome(True)}, clear=True):
            self._reporter(sent).report_once()
        # The re-report that tells the server "the window you asked for is open" carries the result.
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[1][2], {"ok": True, "at": sent[1][2]["at"]})

    def test_a_send_that_failed_does_not_lose_the_outcome(self) -> None:
        sent: list = []

        def send(key: str, payload: dict, poke: dict | None = None) -> dict:
            sent.append((key, payload, poke))
            if len(sent) == 2:
                raise RuntimeError("HTTP 502")
            return {"openWindow": True}

        with mock.patch.dict(harness_usage.COLLECTORS, {"claude": lambda: {"five_hour": {}}}, clear=True), \
                mock.patch.dict(harness_usage.POKERS,
                                {"claude": lambda: harness_usage.PokeOutcome(False, "boom")}, clear=True):
            reporter = UsageReporter(send)
            reporter.report_once()
            reporter.report_once()   # carries the outcome and fails
            reporter.report_once()   # so the outcome is still pending here
        self.assertEqual(sent[1][2]["error"], "boom")
        self.assertEqual(sent[2][2]["error"], "boom")


class ClaudeCliLocationTest(unittest.TestCase):
    """The poke is the only thing the worker runs by bare name, and a service's PATH is not the
    installing shell's — see `claude_cli_path`."""

    def _home_with_cli(self, root: Path) -> Path:
        cli = root / ".local/bin/claude"
        cli.parent.mkdir(parents=True)
        cli.write_text("#!/bin/sh\nexit 0\n")
        cli.chmod(0o755)
        return cli

    def test_path_wins_and_is_what_gets_executed(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command, **kwargs):
            calls.append(list(command))
            return subprocess.CompletedProcess(command, 0, "", "")

        with mock.patch.object(harness_usage.shutil, "which", return_value="/opt/x/bin/claude"), \
                mock.patch.object(harness_usage.subprocess, "run", fake_run):
            self.assertTrue(harness_usage.poke_claude().ok)
        self.assertEqual(calls[0][0], "/opt/x/bin/claude")

    def test_falls_back_to_the_home_install_a_service_cannot_see(self) -> None:
        with TemporaryDirectory() as tmp:
            cli = self._home_with_cli(Path(tmp))
            with mock.patch.dict("os.environ", {"HOME": tmp}, clear=False), \
                    mock.patch.object(harness_usage.shutil, "which", return_value=None), \
                    mock.patch.object(harness_usage, "CLAUDE_BIN_FALLBACKS", ("~/.local/bin/claude",)):
                self.assertEqual(harness_usage.claude_cli_path(), str(cli))

    def test_an_explicit_setting_wins_over_both(self) -> None:
        with mock.patch.dict("os.environ", {harness_usage.CLAUDE_BIN_ENV: "/srv/claude"}), \
                mock.patch.object(harness_usage.shutil, "which", return_value="/usr/bin/claude"):
            self.assertEqual(harness_usage.claude_cli_path(), "/srv/claude")

    def test_a_machine_without_the_cli_refuses_instead_of_raising(self) -> None:
        with TemporaryDirectory() as tmp:
            with mock.patch.dict("os.environ", {"HOME": tmp}, clear=False), \
                    mock.patch.object(harness_usage.shutil, "which", return_value=None), \
                    mock.patch.object(harness_usage, "CLAUDE_BIN_FALLBACKS", ("~/.local/bin/claude",)):
                self.assertIsNone(harness_usage.claude_cli_path())
                outcome = harness_usage.poke_claude()
                self.assertFalse(outcome.ok)
                # The reason is what the server will show; it must name what was looked at.
                self.assertIn("~/.local/bin/claude", outcome.error or "")


class ServiceUnitTest(unittest.TestCase):
    def test_the_unit_names_the_user_bin_directory(self) -> None:
        """`~/.local/bin` is where the CLI installs itself; systemd's own PATH does not have it."""
        value = main.service_path_value()
        self.assertIn(str(Path.home() / ".local/bin"), value.split(":"))
        self.assertIn("/usr/bin", value.split(":"))

    def test_an_exotic_install_is_added_from_the_installing_shell(self) -> None:
        with mock.patch.object(main.shutil, "which", return_value="/opt/mise/shims/claude"):
            self.assertEqual(main.service_path_value().split(":")[0], "/opt/mise/shims")


if __name__ == "__main__":
    unittest.main()
